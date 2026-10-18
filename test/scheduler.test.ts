// Ф19c: планировщик. Таймеры фейковые: «время» идёт только когда тест вызывает fire().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seed } from './seed.ts';
import { loadConfig } from '../src/config.ts';
import { createScheduler, effectiveInterval, buildTasks, auditEvent, startScheduler, MIN_INTERVAL_MS, type SchedulerEvent, type TimerApi } from '../src/scheduler.ts';

function fakeTimers() {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let n = 0;
  const api: TimerApi = {
    setInterval: (fn, ms) => { const id = ++n; timers.set(id, { fn, ms }); return id; },
    clearInterval: h => { timers.delete(h as number); },
  };
  return { api, timers, fire: (i = 0) => [...timers.values()][i]?.fn() };
}
const flush = () => new Promise<void>(r => setImmediate(r));

test('задачи вызываются по своему интервалу (по одному таймеру на задачу)', async () => {
  const ft = fakeTimers(); const calls: string[] = [];
  const s = createScheduler([
    { name: 'a', intervalMs: 10_000, run: () => { calls.push('a'); } },
    { name: 'b', intervalMs: 20_000, run: async () => { calls.push('b'); } },
  ], { timers: ft.api });
  s.start(); s.start();   // повторный start не плодит таймеры
  assert.deepEqual([...ft.timers.values()].map(t => t.ms), [10_000, 20_000]);
  assert.deepEqual(calls, []);   // сразу при старте не запускается
  ft.fire(0); await flush(); ft.fire(0); await flush(); ft.fire(1); await flush();
  assert.deepEqual(calls, ['a', 'a', 'b']);
});

test('наложение: пока прошлый запуск не закончен — пропуск и запись в журнал', async () => {
  const ft = fakeTimers(); const ev: SchedulerEvent[] = [];
  let release!: () => void, runs = 0;
  const s = createScheduler([{ name: 'slow', intervalMs: 10_000, run: () => { runs++; return new Promise<void>(r => { release = r; }); } }], { timers: ft.api, onEvent: e => ev.push(e) });
  s.start();
  ft.fire(); await flush();
  ft.fire(); ft.fire(); await flush();
  assert.equal(runs, 1);
  assert.equal(ev.filter(e => e.event === 'skipped_overlap').length, 2);
  release(); await flush();
  ft.fire(); await flush();      // после завершения запуск снова разрешён
  assert.equal(runs, 2);
});

test('наложение одной задачи не блокирует другую', async () => {
  const ft = fakeTimers(); let b = 0;
  const s = createScheduler([
    { name: 'slow', intervalMs: 10_000, run: () => new Promise<void>(() => {}) },
    { name: 'b', intervalMs: 10_000, run: () => { b++; } },
  ], { timers: ft.api });
  s.start(); ft.fire(0); ft.fire(1); await flush(); ft.fire(1); await flush();
  assert.equal(b, 2);
});

test('сбой задачи (sync и async) не роняет процесс и не останавливает остальные; в журнале нет текста ошибки', async () => {
  const ft = fakeTimers(); const ev: SchedulerEvent[] = []; let ok = 0;
  const s = createScheduler([
    { name: 'boom-sync', intervalMs: 10_000, run: () => { throw new Error('smtp down: user pa@example.invalid pw=hunter2'); } },
    { name: 'boom-async', intervalMs: 10_000, run: async () => { throw new TypeError('child Anna, born 2015'); } },
    { name: 'fine', intervalMs: 10_000, run: () => { ok++; } },
  ], { timers: ft.api, onEvent: e => ev.push(e) });
  s.start();
  for (let round = 0; round < 2; round++) { ft.fire(0); ft.fire(1); ft.fire(2); await flush(); }
  assert.equal(ok, 2);
  assert.equal(ev.filter(e => e.event === 'failed').length, 4);
  const dump = JSON.stringify(ev);
  assert.ok(!/hunter2|example\.invalid|Anna|2015/.test(dump), dump);
  assert.ok(ev.some(e => e.task === 'boom-async' && e.error === 'TypeError'));
  // и после сбоя задача снова запускается (флаг «выполняется» сброшен)
  ft.fire(0); await flush();
  assert.equal(ev.filter(e => e.task === 'boom-sync' && e.event === 'failed').length, 3);
});

test('сбой самого журнала не роняет планировщик', async () => {
  const ft = fakeTimers(); let n = 0;
  const s = createScheduler([{ name: 'a', intervalMs: 10_000, run: () => { n++; } }], { timers: ft.api, onEvent: () => { throw new Error('log broken'); } });
  s.start(); ft.fire(); await flush(); ft.fire(); await flush();
  assert.equal(n, 2);
});

test('stop() гасит таймеры; позднее срабатывание и повторный start ничего не запускают', async () => {
  const ft = fakeTimers(); let n = 0;
  const s = createScheduler([{ name: 'a', intervalMs: 10_000, run: () => { n++; } }], { timers: ft.api });
  s.start();
  const stale = [...ft.timers.values()][0].fn;
  s.stop(); s.stop();
  assert.equal(ft.timers.size, 0);
  stale(); await flush();
  assert.equal(n, 0);
  s.start();
  assert.equal(ft.timers.size, 0);
});

test('интервал ниже границы поднимается до границы; 0, отрицательные и NaN не дают забить процесс', () => {
  assert.equal(effectiveInterval({ intervalMs: 0, minIntervalMs: 5000 }), 5000);
  assert.equal(effectiveInterval({ intervalMs: 1, minIntervalMs: 5000 }), 5000);
  assert.equal(effectiveInterval({ intervalMs: -100, minIntervalMs: 5000 }), 5000);
  assert.equal(effectiveInterval({ intervalMs: NaN, minIntervalMs: 5000 }), 5000);
  assert.equal(effectiveInterval({ intervalMs: 7000, minIntervalMs: 5000 }), 7000);
  assert.ok(effectiveInterval({ intervalMs: 0 }) >= 1000, 'граница по умолчанию не нулевая');
  const ft = fakeTimers();
  createScheduler([{ name: 'a', intervalMs: 0, minIntervalMs: 5000, run: () => {} }], { timers: ft.api }).start();
  assert.equal([...ft.timers.values()][0].ms, 5000);
});

test('config: умолчания, SCHEDULER=off, плохие значения отвергаются', () => {
  const base = { LUMO_MODE: 'test' };
  const d = loadConfig(base);
  assert.equal(d.schedulerEnabled, true);
  assert.deepEqual([d.outboxIntervalMs, d.backupIntervalMs, d.cleanupIntervalMs], [60_000, 86_400_000, 3_600_000]);
  assert.equal(loadConfig({ ...base, SCHEDULER: 'off' }).schedulerEnabled, false);
  assert.throws(() => loadConfig({ ...base, SCHEDULER: 'maybe' }), /SCHEDULER/);
  assert.throws(() => loadConfig({ ...base, SCHEDULER_OUTBOX_MS: '0' }), /SCHEDULER_OUTBOX_MS/);
  assert.throws(() => loadConfig({ ...base, SCHEDULER_BACKUP_MS: 'abc' }), /SCHEDULER_BACKUP_MS/);
});

test('buildTasks: реальные задачи на базе — outbox, чистка, копия; журнал без текста ошибки', async () => {
  const s = seed(); const dir = mkdtempSync(join(tmpdir(), 'sched-'));
  try {
    const cfg = loadConfig({ LUMO_MODE: 'test', BACKUP_DIR: dir, BACKUP_KEEP: '2', SCHEDULER_OUTBOX_MS: '1' });
    const tasks = buildTasks(s.db, cfg, { send: () => {} });
    assert.deepEqual(tasks.map(t => t.name), ['outbox', 'cleanup', 'backup']);
    assert.equal(effectiveInterval(tasks[0]), MIN_INTERVAL_MS.outbox);   // SCHEDULER_OUTBOX_MS=1 поднят до границы
    const ev: SchedulerEvent[] = [];
    const ft = fakeTimers();
    const sch = createScheduler(tasks, { timers: ft.api, onEvent: e => { ev.push(e); auditEvent(s.db, e); } });
    for (const t of tasks) await sch.tick(t.name);
    assert.deepEqual(ev.map(e => e.event), ['ok', 'ok', 'ok']);
    assert.equal(readdirSync(dir).filter(n => n.endsWith('.sqlite')).length, 1);
    // без BACKUP_DIR копии нет, без Sender — нет outbox
    assert.deepEqual(buildTasks(s.db, loadConfig({ LUMO_MODE: 'test' }), null).map(t => t.name), ['cleanup']);
    // сбой: в audit_log попадает только имя задачи и исход, не текст ошибки
    const bad = createScheduler([{ name: 'backup', intervalMs: 1, run: () => { throw new Error('secret path /home/x'); } }], { timers: ft.api, onEvent: e => auditEvent(s.db, e) });
    await bad.tick('backup');
    const row = s.db.prepare(`SELECT action, outcome FROM audit_log WHERE action LIKE 'scheduler.%' ORDER BY id DESC LIMIT 1`).get() as any;
    assert.equal(row.action, 'scheduler.backup.failed'); assert.equal(row.outcome, 'denied');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('копия по расписанию: ротация оставляет BACKUP_KEEP последних', async () => {
  const s = seed(); const dir = mkdtempSync(join(tmpdir(), 'sched-'));
  try {
    const t = buildTasks(s.db, loadConfig({ LUMO_MODE: 'test', BACKUP_DIR: dir, BACKUP_KEEP: '2' }), null).find(x => x.name === 'backup')!;
    for (let i = 0; i < 4; i++) { await t.run(); await new Promise(r => setTimeout(r, 5)); }
    assert.equal(readdirSync(dir).filter(n => n.endsWith('.sqlite')).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cleanup удаляет просроченные сессии и не трогает живые', async () => {
  const s = seed(); const now = Date.now();
  const ins = s.db.prepare('INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)');
  ins.run('expired-h', s.ids.teacherA, 1, 2); ins.run('live-h', s.ids.teacherA, now, now + 3_600_000);
  const t = buildTasks(s.db, loadConfig({ LUMO_MODE: 'test' }), null).find(x => x.name === 'cleanup')!;
  await t.run();
  const left = (s.db.prepare('SELECT token_hash h FROM sessions').all() as any[]).map(r => r.h);
  assert.ok(!left.includes('expired-h') && left.includes('live-h'));
});

test('startScheduler: SCHEDULER=off — не запускает; on — запускает, stop() гасит (реальные таймеры unref)', () => {
  const s = seed(); const lines: string[] = [];
  assert.equal(startScheduler(s.db, loadConfig({ LUMO_MODE: 'test', SCHEDULER: 'off' }), null, l => lines.push(l)), null);
  const sch = startScheduler(s.db, loadConfig({ LUMO_MODE: 'test' }), null, l => lines.push(l))!;
  assert.ok(sch);
  sch.stop();
  assert.ok(lines.some(l => l.includes('off')) && lines.some(l => l.includes('on')));
});
