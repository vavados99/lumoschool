// Ф19b: доставка уведомлений родителю через подключаемый Sender (только локальные «стоки», реальной отправки нет).
// Список поломок для проверки силы тестов — docs/ВОРОТА.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seed } from './seed.ts';
import { actorOf } from '../src/access.ts';
import { openThread, postMessage, notifyParents } from '../src/messages.ts';
import { processOutbox, MemorySink, FileSink, ConsoleSink, MAX_ATTEMPTS, backoffMs, BACKOFF_BASE_MS, type Sender, type OutboxMessage } from '../src/notify.ts';
import { LANGS, t } from '../src/i18n.ts';

const SECRET = 'Homework: page 12, call me later';
function setup() {
  const s = seed();
  const th = openThread(s.db, actorOf(s.db, s.ids.teacherA), s.ids.teacherA, s.ids.kidA);
  postMessage(s.db, actorOf(s.db, s.ids.teacherA), th, SECRET);
  return s;
}
const rows = (db: any) => (db.prepare('SELECT status, attempts, next_attempt_at, last_error FROM notification_outbox ORDER BY id').all() as any[]).map(r => ({ ...r })) as { status: string; attempts: number; next_attempt_at: number; last_error: string | null }[];
class Flaky implements Sender {
  calls = 0; ok: OutboxMessage[] = []; failFirst: number;
  constructor(failFirst: number) { this.failFirst = failFirst; }
  send(m: OutboxMessage) { this.calls++; if (this.calls <= this.failFirst) throw new Error('smtp down: user pa@example.invalid'); this.ok.push(m); }
}
const T0 = 1_000_000;

test('доставка: родитель получает уведомление только о СВОЁМ ребёнке; чужой родитель, преподаватель, ребёнок — нет', async () => {
  const { db, ids } = setup();
  const sink = new MemorySink();
  const r = await processOutbox(db, sink, T0);
  assert.deepEqual(r, { sent: 1, failed: 0, dead: 0 });
  assert.deepEqual(sink.sent.map(m => m.to_user_id), [ids.parentA]);
  for (const other of [ids.parentB, ids.teacherA, ids.teacherB, ids.kidA, ids.owner]) assert.ok(!sink.sent.some(m => m.to_user_id === other), `получил ${other}`);
  // второй ребёнок — свой родитель
  notifyParents(db, ids.kidB, 'room_message', ids.lessonB);
  const sink2 = new MemorySink();
  await processOutbox(db, sink2, T0);
  assert.deepEqual(sink2.sent.map(m => m.to_user_id), [ids.parentB]);
});

test('сообщение родителю: нет контактов преподавателя и текста реплики; нет контактов самого родителя; язык родителя из 6', async () => {
  const { db, ids } = setup();
  const sink = new MemorySink();
  await processOutbox(db, sink, T0);
  const dump = JSON.stringify(sink.sent);
  for (const bad of [SECRET, 'page 12', 'ta@example.invalid', '+000-ta', 'TeacherA', 'pa@example.invalid', '+000-pa', 'KidA', 'kida@example.invalid']) assert.ok(!dump.includes(bad), `утечка: ${bad}`);
  assert.deepEqual(Object.keys(sink.sent[0]).sort(), ['body', 'key', 'kind', 'lang', 'subject', 'to_user_id']);
  for (const l of LANGS) {
    db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(l, ids.parentA);
    db.prepare(`UPDATE notification_outbox SET status='pending', next_attempt_at=0`).run();
    const s = new MemorySink(); await processOutbox(db, s, T0);
    assert.equal(s.sent[0].lang, l);
    assert.equal(s.sent[0].body, t(l, 'notify.thread_message'));
    assert.notEqual(s.sent[0].body, 'notify.thread_message');
  }
  // неизвестный/пустой язык → язык по умолчанию (uk)
  db.prepare('UPDATE users SET lang = ? WHERE id = ?').run('xx', ids.parentA);
  db.prepare(`UPDATE notification_outbox SET status='pending'`).run();
  const s = new MemorySink(); await processOutbox(db, s, T0);
  assert.equal(s.sent[0].lang, 'uk');
});

test('сбой Sender: failed, нарастающая задержка, повтор только по сроку, затем sent; в базе нет текста ошибки', async () => {
  const { db } = setup();
  const f = new Flaky(2);
  assert.deepEqual(await processOutbox(db, f, T0), { sent: 0, failed: 1, dead: 0 });
  assert.deepEqual(rows(db)[0], { status: 'failed', attempts: 1, next_attempt_at: T0 + backoffMs(1), last_error: 'Error' });
  assert.equal(JSON.stringify(rows(db)).includes('example.invalid'), false, 'текст исключения (с адресом) не хранится');
  // срок не наступил — не шлём
  assert.deepEqual(await processOutbox(db, f, T0 + backoffMs(1) - 1), { sent: 0, failed: 0, dead: 0 });
  assert.equal(f.calls, 1);
  // срок наступил: вторая неудача, задержка вдвое больше
  assert.deepEqual(await processOutbox(db, f, T0 + backoffMs(1)), { sent: 0, failed: 1, dead: 0 });
  assert.equal(backoffMs(2), 2 * BACKOFF_BASE_MS);
  assert.equal(rows(db)[0].next_attempt_at, T0 + backoffMs(1) + backoffMs(2));
  // третья попытка успешна
  assert.deepEqual(await processOutbox(db, f, T0 + 10 * 3_600_000), { sent: 1, failed: 0, dead: 0 });
  assert.equal(rows(db)[0].status, 'sent'); assert.equal(rows(db)[0].attempts, 3); assert.equal(f.ok.length, 1);
});

test('предел попыток: после MAX_ATTEMPTS — dead, больше не отправляется', async () => {
  const { db } = setup();
  const f = new Flaky(1e9);
  let now = T0;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) { await processOutbox(db, f, now); now += 10 * 3_600_000; }
  assert.equal(f.calls, MAX_ATTEMPTS);
  assert.equal(rows(db)[0].status, 'dead'); assert.equal(rows(db)[0].attempts, MAX_ATTEMPTS);
  await processOutbox(db, f, now + 1e12); await processOutbox(db, f, now + 2e12);
  assert.equal(f.calls, MAX_ATTEMPTS, 'dead не повторяется');
  assert.ok(backoffMs(50) <= 3_600_000, 'потолок задержки');
});

test('идемпотентность: повторный и параллельный processOutbox не шлют дважды; новое уведомление уходит один раз', async () => {
  const { db, ids } = setup();
  const sink = new MemorySink();
  await processOutbox(db, sink, T0);
  await processOutbox(db, sink, T0 + 1); await processOutbox(db, sink, T0 + 1e9);
  assert.equal(sink.sent.length, 1);
  const keys = new Set(sink.sent.map(m => m.key)); assert.equal(keys.size, 1);
  const sink2 = new MemorySink();
  await Promise.all([processOutbox(db, sink2, T0), processOutbox(db, sink2, T0)]);   // два одновременно (медленный Sender)
  assert.equal(sink2.sent.length, 0);
  notifyParents(db, ids.kidA, 'room_message', ids.lessonA);
  const slow: Sender & { n: number } = { n: 0, async send() { this.n++; await new Promise(r => setTimeout(r, 10)); } };
  await Promise.all([processOutbox(db, slow, T0), processOutbox(db, slow, T0)]);
  assert.equal(slow.n, 1);
  assert.deepEqual(rows(db).map(r => r.status), ['sent', 'sent']);
});

test('для взрослого ученика строки в очереди нет', async () => {
  const { db, ids } = setup();
  notifyParents(db, ids.adultC, 'thread_message', 1);
  assert.equal(rows(db).length, 1, 'для взрослого строки в очереди нет');
  db.prepare('DELETE FROM notification_outbox').run();
  db.prepare('DELETE FROM parent_notifications').run();
  assert.equal(rows(db).length, 0);
});

test('стоки: файл (вне репозитория) и консоль пишут только факт, без контактов', async () => {
  const { db } = setup();
  const dir = mkdtempSync(join(tmpdir(), 'outbox-'));
  try {
    const path = join(dir, 'out.jsonl');
    const lines: string[] = [];
    await processOutbox(db, new FileSink(path), T0);
    const text = readFileSync(path, 'utf8');
    assert.equal(text.trim().split('\n').length, 1);
    assert.ok(!/example\.invalid|\+000/.test(text) && !text.includes(SECRET));
    db.prepare(`UPDATE notification_outbox SET status='pending'`).run();
    await processOutbox(db, new ConsoleSink(l => lines.push(l)), T0);
    assert.equal(lines.length, 1); assert.ok(!/example\.invalid|\+000/.test(lines[0]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
