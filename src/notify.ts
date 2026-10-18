// Ф19b: доставка уведомлений родителю через ПОДКЛЮЧАЕМЫЙ отправитель.
// Здесь НЕТ реальной отправки: ни сети, ни ключей, ни зависимостей. Есть интерфейс Sender и локальные «стоки» для разработки.
// Реальный канал (почта/СМС/мессенджер) — отдельный Sender, подключается только по решению Влада (docs/ВОРОТА.md).
import type { DatabaseSync } from 'node:sqlite';
import { appendFileSync } from 'node:fs';
import { t, isLang, DEFAULT_LANG } from './i18n.ts';

/** Что получает отправитель. Контактов нет: адрес по `to_user_id` реальный отправитель берёт из сейфа сам.
 *  Текста сообщения ребёнка/преподавателя и данных преподавателя здесь нет — только факт «есть новое, зайдите в кабинет». */
export interface OutboxMessage {
  key: string;          // стабильный ключ идемпотентности (по нему канал может отсечь дубль)
  to_user_id: number;   // родитель
  lang: string;
  kind: 'thread_message' | 'room_message';
  subject: string;
  body: string;
}
export interface Sender { send(msg: OutboxMessage): void | Promise<void>; }

export const MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 60_000;    // 1 мин, 2, 4, 8 …
export const BACKOFF_MAX_MS = 3_600_000;  // потолок 1 час
export const backoffMs = (attempt: number) => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));

/** Сток в памяти (тесты). */
export class MemorySink implements Sender {
  readonly sent: OutboxMessage[] = [];
  send(msg: OutboxMessage) { this.sent.push(msg); }
}
/** Сток в консоль (разработка). */
export class ConsoleSink implements Sender {
  private out: (line: string) => void;
  constructor(out: (line: string) => void = console.log) { this.out = out; }
  send(msg: OutboxMessage) { this.out(`[outbox] to=${msg.to_user_id} lang=${msg.lang} ${msg.subject}`); }
}
/** Сток в локальный файл (JSON-строки). Путь задаёт вызывающий и должен быть вне репозитория. */
export class FileSink implements Sender {
  private path: string;
  constructor(path: string) { this.path = path; }
  send(msg: OutboxMessage) { appendFileSync(this.path, JSON.stringify(msg) + '\n'); }
}

type Row = { id: number; attempts: number; notification_id: number; parent_id: number; kind: 'thread_message' | 'room_message'; lang: string | null };

export function buildMessage(r: Pick<Row, 'notification_id' | 'parent_id' | 'kind' | 'lang'>): OutboxMessage {
  const lang = isLang(r.lang) ? r.lang : DEFAULT_LANG;
  return { key: `notif-${r.notification_id}`, to_user_id: r.parent_id, lang, kind: r.kind, subject: t(lang, 'notify.subject'), body: t(lang, `notify.${r.kind}`) };
}

const inFlight = new Set<number>();   // строки, которые сейчас отправляются этим процессом (защита от двух параллельных вызовов)

/** Берёт в работу готовые к отправке записи (pending/failed, срок наступил), шлёт, ставит sent; при сбое — failed с нарастающей
 *  задержкой, после maxAttempts — dead. Повторный вызов уже отправленное не трогает. Возвращает счётчики. */
export async function processOutbox(db: DatabaseSync, sender: Sender, now: number = Date.now(), maxAttempts: number = MAX_ATTEMPTS): Promise<{ sent: number; failed: number; dead: number }> {
  const res = { sent: 0, failed: 0, dead: 0 };
  const due = db.prepare(
    `SELECT o.id, o.attempts, o.notification_id, n.parent_id, n.kind, u.lang
       FROM notification_outbox o
       JOIN parent_notifications n ON n.id = o.notification_id
       JOIN users u ON u.id = n.parent_id
      WHERE o.status IN ('pending','failed') AND o.next_attempt_at <= ?
      ORDER BY o.id LIMIT 100`).all(now) as Row[];
  for (const r of due) {
    if (inFlight.has(r.id)) continue;
    inFlight.add(r.id);
    try {
      try {
        await sender.send(buildMessage(r));
      } catch (e) {
        const attempts = r.attempts + 1;
        const code = (e instanceof Error ? e.name : 'Error').slice(0, 40);   // только имя ошибки, не текст
        if (attempts >= maxAttempts) {
          db.prepare(`UPDATE notification_outbox SET status = 'dead', attempts = ?, last_error = ? WHERE id = ?`).run(attempts, code, r.id); res.dead++;
        } else {
          db.prepare(`UPDATE notification_outbox SET status = 'failed', attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`).run(attempts, code, now + backoffMs(attempts), r.id); res.failed++;
        }
        continue;
      }
      db.prepare(`UPDATE notification_outbox SET status = 'sent', attempts = ?, last_error = NULL, sent_at = datetime('now') WHERE id = ?`).run(r.attempts + 1, r.id);
      res.sent++;
    } finally { inFlight.delete(r.id); }
  }
  return res;
}
