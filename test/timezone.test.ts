// Ф4: часовые пояса. В базе — UTC; показ — Europe/Warsaw и Europe/Kyiv через Intl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showInZone, ZONES } from '../src/time.ts';
import { seed } from './seed.ts';
import { register, login } from '../src/auth.ts';
import { createSlot } from '../src/schedule.ts';

const W = (s: string) => showInZone(s, 'Europe/Warsaw');
const K = (s: string) => showInZone(s, 'Europe/Kyiv');

test('слот 18:00 Варшавы = 19:00 Киева — до и после перехода (25.10.2026)', () => {
  // летнее время: Варшава UTC+2, Киев UTC+3
  assert.equal(W('2026-10-24T16:00:00.000Z').text, '2026-10-24 18:00');
  assert.equal(K('2026-10-24T16:00:00.000Z').text, '2026-10-24 19:00');
  assert.equal(W('2026-10-24T16:00:00.000Z').offsetMin, 120);
  assert.equal(K('2026-10-24T16:00:00.000Z').offsetMin, 180);
  // зимнее время: Варшава UTC+1, Киев UTC+2 — тот же «18:00 по Варшаве» теперь 17:00 UTC
  assert.equal(W('2026-10-26T17:00:00.000Z').text, '2026-10-26 18:00');
  assert.equal(K('2026-10-26T17:00:00.000Z').text, '2026-10-26 19:00');
  assert.equal(W('2026-10-26T17:00:00.000Z').offsetMin, 60);
  assert.equal(K('2026-10-26T17:00:00.000Z').offsetMin, 120);
  // разница между городами — всегда час
  for (const s of ['2026-01-15T17:00:00Z', '2026-07-15T16:00:00Z', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z', '2026-03-29T00:30:00Z', '2026-03-29T01:30:00Z']) {
    assert.equal(K(s).offsetMin - W(s).offsetMin, 60, s);
  }
});

test('переход на зимнее время: 25.10.2026 в 01:00 UTC; UTC-время слота не «плывёт», показ — плывёт', () => {
  // 00:59 UTC — ещё лето, 01:00 UTC — уже зима (оба города переходят в один момент)
  assert.equal(W('2026-10-25T00:59:00Z').text, '2026-10-25 02:59');
  assert.equal(W('2026-10-25T00:59:00Z').offsetMin, 120);
  assert.equal(W('2026-10-25T01:00:00Z').text, '2026-10-25 02:00');   // 02:00–02:59 повторяется
  assert.equal(W('2026-10-25T01:00:00Z').offsetMin, 60);
  assert.equal(K('2026-10-25T00:59:00Z').text, '2026-10-25 03:59');
  assert.equal(K('2026-10-25T01:00:00Z').text, '2026-10-25 03:00');
  assert.equal(K('2026-10-25T01:00:00Z').offsetMin, 120);
  // еженедельный урок «в 18:00 по Варшаве»: 24.10 это 16:00Z, 31.10 — 17:00Z
  assert.equal(W('2026-10-31T17:00:00Z').text, '2026-10-31 18:00');
  assert.notEqual(W('2026-10-24T16:00:00Z').text.slice(11), W('2026-10-31T16:00:00Z').text.slice(11)); // 16:00Z уже не 18:00
});

test('переход на летнее время 29.03.2026 и смена даты на границе суток', () => {
  assert.equal(W('2026-03-29T00:59:00Z').text, '2026-03-29 01:59');
  assert.equal(W('2026-03-29T01:00:00Z').text, '2026-03-29 03:00');   // 02:00–02:59 не существует
  assert.equal(K('2026-03-29T00:59:00Z').text, '2026-03-29 02:59');
  assert.equal(K('2026-03-29T01:00:00Z').text, '2026-03-29 04:00');
  // 23:30 UTC зимой: Варшава уже следующий день
  assert.equal(W('2026-12-31T23:30:00Z').text, '2027-01-01 00:30');
  assert.equal(K('2026-12-31T23:30:00Z').text, '2027-01-01 01:30');
});

test('показ: только поддерживаемые зоны и корректные даты; неоднозначности нет', () => {
  assert.deepEqual([...ZONES], ['Europe/Warsaw', 'Europe/Kyiv']);
  assert.throws(() => showInZone('2026-10-24T16:00:00Z', 'Asia/Tokyo' as never), RangeError);
  assert.throws(() => showInZone('не-дата', 'Europe/Kyiv'), RangeError);
  assert.equal(W('2026-10-24T16:00:00').text, '2026-10-24 18:00');    // без 'Z' трактуется как UTC, как в toMs
});

test('в базе слот хранится в UTC: слот, заданный со смещением, лежит как UTC и показывается в обеих зонах', () => {
  const { db, ids } = seed();
  const NOW = Date.parse('2026-10-01T10:00:00Z');
  register(db, ids.teacherA, 'tA', 'test-password-123');
  const tok = login(db, 'tA', 'test-password-123', NOW);
  // 18:00 по Варшаве 26.10.2026 (зима, +01:00) = 17:00Z
  const id = createSlot(db, tok, NOW, '2026-10-26T18:00:00+01:00');
  const row = db.prepare('SELECT starts_at FROM lessons WHERE id = ?').get(id) as { starts_at: string };
  assert.equal(row.starts_at, '2026-10-26T17:00:00.000Z');
  assert.equal(W(row.starts_at).text, '2026-10-26 18:00');
  assert.equal(K(row.starts_at).text, '2026-10-26 19:00');
  // тот же «18:00 Варшавы» до перехода (24.10, +02:00) = 16:00Z
  const id2 = createSlot(db, tok, NOW, '2026-10-24T18:00:00+02:00');
  const r2 = db.prepare('SELECT starts_at FROM lessons WHERE id = ?').get(id2) as { starts_at: string };
  assert.equal(r2.starts_at, '2026-10-24T16:00:00.000Z');
  assert.equal(K(r2.starts_at).text, '2026-10-24 19:00');
});
