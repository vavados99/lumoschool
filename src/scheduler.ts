// Ф19c: встроенный планировщик (без внешних сервисов): периодически запускает processOutbox, резервную копию с ротацией и чистку.
//  * интервалы ниже нижней границы поднимаются до неё (нельзя поставить 0 мс и забить процесс);
//  * одна и та же задача не накладывается сама на себя: прошлый запуск не закончен → пропуск + запись в журнал;
//  * сбой одной задачи не роняет процесс и не останавливает остальные; в журнал идёт только имя задачи и класс ошибки
//    (текст ошибки может содержать персональные данные или секреты — не пишем);
//  * таймеры unref (не держат процесс), stop() гасит всё. Таймеры инжектируются (тесты без реального ожидания).
// Реальной отправки нет: Sender — сток (см. notify.ts, docs/ВОРОТА.md).
import type { DatabaseSync } from 'node:sqlite';
import { audit, actorOf } from './access.ts';
import { runRetention } from './consent.ts';
import { purgeExpiredSessions, purgeOldAttempts } from './auth.ts';
import { backupDb } from './backup.ts';
import { processOutbox, type Sender } from './notify.ts';
import type { Config } from './config.ts';

export const MIN_INTERVAL_MS: Readonly<Record<'outbox' | 'backup' | 'cleanup', number>> = { outbox: 5_000, backup: 60_000, cleanup: 60_000 };
export const DEFAULT_MIN_INTERVAL_MS = 5_000;

export type Task = { name: string; intervalMs: number; minIntervalMs?: number; run: () => unknown | Promise<unknown> };
export type TimerApi = {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
};
export type SchedulerEvent = { task: string; event: 'ok' | 'skipped_overlap' | 'failed'; error?: string };
export type SchedulerOptions = {
  timers?: TimerApi;
  onEvent?: (e: SchedulerEvent) => void;   // журнал: вызывающий пишет в audit_log/лог
  now?: () => number;                       // Ф21: часы для «живости» (тесты)
};
/** Ф21: «живость» задачи в памяти — только время и класс события, без текста ошибок и данных. */
export type TaskHealth = { intervalMs: number; lastOkAt: number | null; lastEvent: SchedulerEvent['event'] | null; lastEventAt: number | null; okCount: number; failCount: number };

const realTimers: TimerApi = {
  setInterval: (fn, ms) => { const h = setInterval(fn, ms); h.unref(); return h; },
  clearInterval: h => clearInterval(h as NodeJS.Timeout),
};

export const effectiveInterval = (t: Pick<Task, 'intervalMs' | 'minIntervalMs'>): number => {
  const min = Math.max(1, t.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
  const v = Number.isFinite(t.intervalMs) ? Math.floor(t.intervalMs) : min;
  return Math.max(min, v);
};

export type Scheduler = {
  start(): void;
  stop(): void;
  /** Один запуск задачи по имени (то же, что делает таймер: с защитой от наложения и изоляцией сбоя). */
  tick(name: string): Promise<void>;
  intervals(): Record<string, number>;
  /** Ф21: когда задача в последний раз успешно отработала. Только память процесса: в audit_log тики не пишутся. */
  health(): Record<string, TaskHealth>;
};

export function createScheduler(tasks: readonly Task[], opts: SchedulerOptions = {}): Scheduler {
  const timers = opts.timers ?? realTimers;
  const emit = (e: SchedulerEvent) => { try { opts.onEvent?.(e); } catch { /* журнал не должен ронять планировщик */ } };
  const running = new Set<string>();
  const handles: unknown[] = [];
  let started = false, stopped = false;
  const byName = new Map(tasks.map(t => [t.name, t]));
  const clock = opts.now ?? Date.now;
  const live = new Map<string, { lastOkAt: number | null; lastEvent: SchedulerEvent['event'] | null; lastEventAt: number | null; okCount: number; failCount: number }>(
    tasks.map(t => [t.name, { lastOkAt: null, lastEvent: null, lastEventAt: null, okCount: 0, failCount: 0 }]));
  const note = (name: string, ev: SchedulerEvent['event']) => {
    const h = live.get(name); if (!h) return;
    h.lastEvent = ev; h.lastEventAt = clock();
    if (ev === 'ok') { h.lastOkAt = h.lastEventAt; h.okCount++; } else if (ev === 'failed') h.failCount++;
  };

  async function tick(name: string): Promise<void> {
    const t = byName.get(name);
    if (!t || stopped) return;
    if (running.has(name)) { note(name, 'skipped_overlap'); emit({ task: name, event: 'skipped_overlap' }); return; }
    running.add(name);
    try {
      await t.run();
      note(name, 'ok');
      emit({ task: name, event: 'ok' });
    } catch (e) {
      note(name, 'failed');
      emit({ task: name, event: 'failed', error: e instanceof Error ? e.name : 'Error' });
    } finally { running.delete(name); }
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      for (const t of tasks) handles.push(timers.setInterval(() => { void tick(t.name); }, effectiveInterval(t)));
    },
    stop() {
      stopped = true;
      for (const h of handles.splice(0)) timers.clearInterval(h);
    },
    tick,
    intervals: () => Object.fromEntries(tasks.map(t => [t.name, effectiveInterval(t)])),
    health: () => Object.fromEntries(tasks.map(t => [t.name, { intervalMs: effectiveInterval(t), ...live.get(t.name)! }])),
  };
}

/** Чистка, как в maintenance.ts: срок хранения (от имени владельца) + просроченные сессии + старые попытки входа. */
export function cleanupOnce(db: DatabaseSync, cfg: Pick<Config, 'messageRetentionDays' | 'loginAttemptRetentionDays'>, now = Date.now()): void {
  const owner = db.prepare(`SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1`).get() as { id: number } | undefined;
  if (!owner) throw new Error('no owner user');
  runRetention(db, actorOf(db, owner.id), { now, ...(cfg.messageRetentionDays !== null && { messageDays: cfg.messageRetentionDays }), ...(cfg.loginAttemptRetentionDays !== null && { loginAttemptDays: cfg.loginAttemptRetentionDays }) });
  purgeExpiredSessions(db, now);
  purgeOldAttempts(db, now);
}

/** Задачи сервера. Outbox — только если передан Sender; backup — только если задан BACKUP_DIR. */
export function buildTasks(db: DatabaseSync, cfg: Config, sender: Sender | null): Task[] {
  const tasks: Task[] = [];
  if (sender) tasks.push({ name: 'outbox', intervalMs: cfg.outboxIntervalMs, minIntervalMs: MIN_INTERVAL_MS.outbox, run: () => processOutbox(db, sender) });
  tasks.push({ name: 'cleanup', intervalMs: cfg.cleanupIntervalMs, minIntervalMs: MIN_INTERVAL_MS.cleanup, run: () => cleanupOnce(db, cfg) });
  if (cfg.backupDir) {
    const dir = cfg.backupDir;
    tasks.push({ name: 'backup', intervalMs: cfg.backupIntervalMs, minIntervalMs: MIN_INTERVAL_MS.backup, run: () => backupDb(db, dir, { keep: cfg.backupKeep }) });
  }
  return tasks;
}

/** Запись события в журнал действий (audit_log) без текста ошибки и данных; успех не пишем (шум). */
export function auditEvent(db: DatabaseSync, e: SchedulerEvent): void {
  if (e.event === 'ok') return;
  audit(db, null, `scheduler.${e.task}.${e.event}`, 'scheduler', null, e.event === 'failed' ? 'denied' : 'allowed');
}

/** Запуск для реального сервера. Возвращает null, если выключен (SCHEDULER=off). */
export function startScheduler(db: DatabaseSync, cfg: Config, sender: Sender | null, log: (line: string) => void = console.log): Scheduler | null {
  if (!cfg.schedulerEnabled) { log('scheduler: off'); return null; }
  const s = createScheduler(buildTasks(db, cfg, sender), {
    onEvent: e => {
      if (e.event !== 'ok') log(`scheduler: ${e.task} ${e.event}${e.error ? ` (${e.error})` : ''}`);
      try { auditEvent(db, e); } catch { /* база занята/закрыта — лог уже есть */ }
    },
  });
  s.start();
  log(`scheduler: on ${JSON.stringify(s.intervals())}`);
  return s;
}
