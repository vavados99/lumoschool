// Ф10: дашборд владельца и постраничный журнал. Реальные HTTP-запросы, фиксированные часы, выдуманные данные с известными ответами.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import { seedDemo } from '../src/seed.ts';
import { createApp, listen, COOKIE } from '../src/server.ts';
import { actorOf, Denied } from '../src/access.ts';
import { ownerDashboard, readAuditPage, parsePeriod, AUDIT_MAX_LIMIT } from '../src/dashboard.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const P = '?from=2026-10-08&to=2026-10-15';   // [08.10, 15.10); предыдущий период [01.10, 08.10)

/** Известные данные (см. ожидания в тестах):
 *  L1,L2 — прошлый период; L3 (A, 60 мин, done) — KidA, TeenC активны, KidB отменил; L4 (B, 90 мин, взрослая группа) — AdultD;
 *  L5 — отменённый урок; L6 — ровно на границе «to» (не входит); L7 — ровно на границе «from» (входит, пустой). */
async function start() {
  const db = openDb(':memory:');
  const demo = seedDemo(db, NOW);
  const U = (k: string) => demo.users[k].id;
  db.exec('DELETE FROM msg_posts; DELETE FROM msg_threads; DELETE FROM lesson_enrollments; DELETE FROM lessons;');
  const L = (t: string, at: string, dur: number, aud: string, status: string, cap: number) => Number(db.prepare(
    'INSERT INTO lessons(teacher_id, starts_at, duration_min, audience, status, max_students) VALUES (?,?,?,?,?,?)').run(U(t), at, dur, aud, status, cap).lastInsertRowid);
  const l = {
    l1: L('TeacherA', '2026-10-01T10:00:00.000Z', 50, 'minor', 'done', 6), l2: L('TeacherA', '2026-10-02T10:00:00.000Z', 50, 'minor', 'done', 6),
    l3: L('TeacherA', '2026-10-09T10:00:00.000Z', 60, 'minor', 'done', 6), l4: L('TeacherB', '2026-10-10T09:00:00.000Z', 90, 'adult', 'done', 8),
    l5: L('TeacherB', '2026-10-12T10:00:00.000Z', 50, 'minor', 'cancelled', 6), l6: L('TeacherB', '2026-10-15T00:00:00.000Z', 50, 'minor', 'planned', 6),
    l7: L('TeacherA', '2026-10-08T00:00:00.000Z', 50, 'minor', 'planned', 6),
  };
  const en = (lesson: number, kid: string, status = 'active') => db.prepare('INSERT INTO lesson_enrollments(lesson_id, student_id, status) VALUES (?,?,?)').run(lesson, U(kid), status);
  en(l.l1, 'KidA'); en(l.l1, 'KidB'); en(l.l2, 'TeenC'); en(l.l2, 'AdultD');
  en(l.l3, 'KidA'); en(l.l3, 'TeenC'); en(l.l3, 'KidB', 'cancelled');
  en(l.l4, 'AdultD'); en(l.l5, 'KidA'); en(l.l6, 'KidB');
  const pr = (lesson: number, kid: string) => db.prepare(`INSERT INTO room_presence(lesson_id, user_id, entered_at) VALUES (?,?,'2026-10-09T10:01:00.000Z')`).run(lesson, U(kid));
  pr(l.l3, 'KidA'); pr(l.l4, 'AdultD');
  db.prepare('UPDATE parental_consents SET revoked_at = ? WHERE child_id = ?').run('2026-10-05T00:00:00.000Z', U('TeenC'));   // у Tess согласия нет
  // аварийные вызовы (журнал): в периоде — 2 на L3, 1 на L4, 1 на L7 (ровно на границе from); вне — 3; отказ не считается
  const call = (ts: string, lesson: number, outcome = 'allowed') => db.prepare(
    `INSERT INTO audit_log(ts, actor_id, action, target_type, target_id, outcome) VALUES (?,?,?,?,?,?)`).run(ts, U('KidA'), 'room.call_owner', 'lesson', lesson, outcome);
  call('2026-10-09 10:05:00', l.l3); call('2026-10-09 10:06:00', l.l3); call('2026-10-10 09:10:00', l.l4); call('2026-10-08 00:00:00', l.l7);
  call('2026-10-09 10:07:00', l.l3, 'denied'); call('2026-10-07 23:59:59', l.l1); call('2026-10-15 00:00:00', l.l6); call('2026-10-16 00:00:00', l.l6);

  const server = createApp(db, { now: () => NOW });
  servers.push(server);
  const port = await listen(server, 0);
  const jar: Record<string, string> = {};
  const call_ = async (as: string | null, path: string) => {
    const headers: Record<string, string> = {};
    if (as && jar[as]) headers.cookie = `${COOKIE}=${jar[as]}`;
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, text, json };
  };
  for (const k of Object.keys(demo.users)) {
    const r = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: demo.users[k].login, password: demo.users[k].password }) });
    assert.equal(r.status, 200);
    jar[k] = /sid=([0-9a-f]+)/.exec(r.headers.get('set-cookie') ?? '')![1];
  }
  return { db, demo, U, l, call: call_ };
}

const DASH = '/api/owner/dashboard', AUD = '/api/owner/audit';

// ---------- роли ----------
test('дашборд и журнал: только владелец; преподаватель, ученик, родитель — 403, аноним — 401', async () => {
  const s = await start();
  for (const path of [DASH + P, AUD, AUD + '?limit=5']) {
    assert.equal((await s.call('Owner', path)).status, 200, path);
    for (const who of ['TeacherA', 'TeacherB', 'KidA', 'TeenC', 'AdultD', 'ParentA', 'ParentC']) {
      const r = await s.call(who, path);
      assert.equal(r.status, 403, `${who} ${path}`);
      assert.deepEqual(r.json, { error: 'forbidden' });   // тело отказа ничего не раскрывает
    }
    assert.equal((await s.call(null, path)).status, 401, path);
  }
});

test('ядро тоже отказывает не-владельцу (вторая линия защиты, без HTTP)', async () => {
  const s = await start();
  const P0 = parsePeriod('2026-10-08', '2026-10-15')!;
  for (const who of ['TeacherA', 'KidA', 'ParentA']) {
    const a = actorOf(s.db, s.U(who));
    assert.throws(() => ownerDashboard(s.db, a, P0, NOW), Denied, who);
    assert.throws(() => readAuditPage(s.db, a), Denied, who);
  }
});

// ---------- контакты ----------
const EMAIL = /[^\s"@]+@[^\s"@]+\.[^\s"@]+/;
const PHONE = /(\+\d[\d\s().-]{6,}\d)|(\b\d{3}[\s.-]\d{3}[\s.-]\d{2,4}\b)/;
const BAD_KEY = /e-?mail|phone|tel\b|mobile|contact|telegram|whatsapp|viber|messenger|skype/i;
function scan(v: unknown, vault: string[], path = '$'): string[] {
  const bad: string[] = [];
  if (typeof v === 'string') {
    if (EMAIL.test(v) || PHONE.test(v) || vault.some(x => x && v.includes(x))) bad.push(`${path}=${v}`);
  } else if (Array.isArray(v)) v.forEach((x, i) => bad.push(...scan(x, vault, `${path}[${i}]`)));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    if (BAD_KEY.test(k)) bad.push(`${path}.${k} (key)`);
    bad.push(...scan(x, vault, `${path}.${k}`));
  }
  return bad;
}

test('в ответах владельца нет контактов: обход всего JSON по ключам и значениям', async () => {
  const s = await start();
  const vault = (s.db.prepare('SELECT email, phone FROM contact_vault').all() as { email: string; phone: string }[]).flatMap(r => [r.email, r.phone]);
  assert.ok(vault.length >= 20);
  // сам сканер ловит подсовывание (иначе тест пустой)
  assert.ok(scan({ a: { b: ['x kida@example.test'] } }, vault).length > 0);
  assert.ok(scan({ x: '+00 000 000 007' }, vault).length > 0);
  assert.ok(scan({ phone: 'n' }, vault).length > 0);
  assert.deepEqual(scan({ at: '2026-10-08T00:00:00.000Z', n: 5 }, vault), []);
  const bodies = [DASH + P, DASH + '?from=2026-01-01&to=2026-12-31', AUD + '?limit=200'];
  for (const p of bodies) {
    const r = await s.call('Owner', p);
    assert.equal(r.status, 200);
    assert.deepEqual(scan(r.json, vault), [], p);
    assert.ok(!/@|\+00/.test(r.text), p);
  }
});

// ---------- цифры ----------
test('цифры дашборда на известных данных', async () => {
  const s = await start();
  const r = await s.call('Owner', DASH + P);
  assert.equal(r.status, 200);
  const d = r.json;
  assert.deepEqual(d.period, { from: '2026-10-08T00:00:00.000Z', to: '2026-10-15T00:00:00.000Z' });
  // нагрузка: A — L3 (60) + L7 (50) = 110 мин; B — L4 (90), отменённый L5 не в часах, L6 за границей
  assert.deepEqual(d.teachers, [
    { teacher_id: s.U('TeacherA'), name: 'Tina', lessons: 2, done: 1, cancelled: 0, hours: 1.83 },
    { teacher_id: s.U('TeacherB'), name: 'Tom', lessons: 1, done: 1, cancelled: 1, hours: 1.5 },
  ]);
  // заполняемость: L3 2/6, L4 1/8, L7 0/6; отменённый L5 и отменённая запись KidB не считаются
  assert.deepEqual(d.groups.items.map((g: any) => [g.lesson_id, g.enrolled, g.capacity, g.fill_rate]),
    [[s.l.l3, 2, 6, 0.333], [s.l.l4, 1, 8, 0.125], [s.l.l7, 0, 6, 0]]);
  assert.deepEqual([d.groups.seats, d.groups.enrolled, d.groups.fill_rate], [20, 3, 0.15]);
  // посещаемость: записано 3 (L3: 2, L4: 1), пришли KidA и AdultD
  assert.deepEqual(d.attendance, { booked: 3, attended: 2, rate: 0.667 });
  // удержание: в прошлом KidA, KidB, TeenC, AdultD (4); в текущем KidA, TeenC, AdultD (3; KidB отменил) → вернулись 3 из 4
  assert.deepEqual(d.retention, { previous_students: 4, retained: 3, rate: 0.75 });
  assert.deepEqual(d.cancellations, { lessons: 1, enrollments: 1 });
  assert.deepEqual(d.emergency_calls, { total: 4, by_lesson: [{ lesson_id: s.l.l3, n: 2 }, { lesson_id: s.l.l4, n: 1 }, { lesson_id: s.l.l7, n: 1 }].sort((a, b) => a.lesson_id - b.lesson_id) });
  // согласия: дети — Kai, Kira, Tess (9, 12, 15 лет); у Tess согласие отозвано. Только id.
  assert.deepEqual(d.consents, { children_total: 3, children_without_consent: 1, candidate_ids: [s.U('TeenC')] });
});

test('посещаемость не считает ещё не начавшиеся уроки', async () => {
  const s = await start();
  const early = ownerDashboard(s.db, actorOf(s.db, s.U('Owner')), parsePeriod('2026-10-08', '2026-10-15')!, Date.parse('2026-10-09T00:00:00Z'));
  assert.deepEqual(early.attendance, { booked: 0, attended: 0, rate: null });   // L7 (08.10) без записей; L3 — 09.10 10:00, ещё не началась
});

// ---------- границы и пустой период ----------
test('границы периода: from включительно, to не включительно', async () => {
  const s = await start();
  const ids = async (q: string) => (await s.call('Owner', DASH + q)).json.groups.items.map((g: any) => g.lesson_id);
  assert.deepEqual(await ids(P), [s.l.l3, s.l.l4, s.l.l7]);                 // L7 ровно на from — внутри, L6 ровно на to — снаружи
  assert.deepEqual(await ids('?from=2026-10-08T00:00:00.001Z&to=2026-10-15'), [s.l.l3, s.l.l4]);   // сдвинули from на 1 мс — L7 вышел
  assert.deepEqual(await ids('?from=2026-10-08&to=2026-10-15T00:00:00.001Z'), [s.l.l3, s.l.l4, s.l.l6, s.l.l7]);   // сдвинули to — L6 вошёл
  // вызов ровно на from считается, ровно на to — нет (total 4 выше); сдвиг to на секунду добавляет вызов L6
  const c = (await s.call('Owner', DASH + '?from=2026-10-08&to=2026-10-15T00:00:01Z')).json.emergency_calls.total;
  assert.equal(c, 5);
});

test('пустой период: нули и null вместо деления на ноль, без падения', async () => {
  const s = await start();
  const r = await s.call('Owner', DASH + '?from=2027-01-01&to=2027-01-08');
  assert.equal(r.status, 200);
  const d = r.json;
  assert.deepEqual(d.teachers.map((t: any) => [t.lessons, t.done, t.cancelled, t.hours]), [[0, 0, 0, 0], [0, 0, 0, 0]]);
  assert.deepEqual(d.groups, { items: [], seats: 0, enrolled: 0, fill_rate: null });
  assert.deepEqual(d.attendance, { booked: 0, attended: 0, rate: null });
  assert.deepEqual(d.retention, { previous_students: 0, retained: 0, rate: null });
  assert.deepEqual(d.cancellations, { lessons: 0, enrollments: 0 });
  assert.deepEqual(d.emergency_calls, { total: 0, by_lesson: [] });
  assert.equal(d.consents.children_without_consent, 1);   // согласия от периода не зависят
});

test('плохой период → 400 (нет параметров, мусор, to<=from, больше года)', async () => {
  const s = await start();
  for (const q of ['', '?from=2026-10-08', '?from=x&to=y', '?from=2026-10-15&to=2026-10-08', '?from=2026-10-08&to=2026-10-08',
    '?from=2025-01-01&to=2026-12-31', '?from=2026-13-45&to=2026-14-01', "?from=2026-10-08&to=2026-10-15'--"]) {
    assert.equal((await s.call('Owner', DASH + q)).status, 400, q);
  }
  assert.equal((await s.call('Owner', DASH + '?from=2026-01-01&to=2026-12-31')).status, 200);   // 364 дня — можно
});

// ---------- журнал ----------
function fill(db: ReturnType<typeof openDb>, n: number) {
  const ins = db.prepare(`INSERT INTO audit_log(actor_id, action, target_type, target_id, outcome) VALUES (NULL, 'test.fill', 'x', ?, 'allowed')`);
  for (let i = 0; i < n; i++) ins.run(i);
}
const count = (db: ReturnType<typeof openDb>) => Number((db.prepare('SELECT COUNT(*) c FROM audit_log').get() as { c: number }).c);

test('журнал: постраничность — страницы без пропусков и повторов, новые сверху, курсор конца', async () => {
  const s = await start();
  fill(s.db, 130);
  const total = count(s.db);
  const seen: number[] = [];
  let before: number | null = null, pages = 0;
  do {
    const r: any = await s.call('Owner', `${AUD}?limit=50${before === null ? '' : `&before=${before}`}`);
    assert.equal(r.status, 200);
    assert.ok(r.json.entries.length <= 50);
    seen.push(...r.json.entries.map((e: any) => e.id));
    before = r.json.next_before; pages++;
    assert.ok(pages < 20);
  } while (before !== null);
  assert.equal(seen.length, total);
  assert.equal(new Set(seen).size, total);
  assert.deepEqual(seen, [...seen].sort((a, b) => b - a));
  assert.equal(pages, Math.ceil(total / 50));
  // точное деление: последняя полная страница не обещает пустой следующей
  const exact = await s.call('Owner', `${AUD}?limit=${total}`);
  assert.equal(exact.json.entries.length, total);
  assert.equal(exact.json.next_before, null);
  assert.deepEqual((await s.call('Owner', `${AUD}?before=1`)).json.entries, []);
});

test('журнал: лимит по умолчанию 50 и потолок 200; мусорный limit/before → 400', async () => {
  const s = await start();
  fill(s.db, 400);
  assert.equal((await s.call('Owner', AUD)).json.entries.length, 50);
  const big = await s.call('Owner', `${AUD}?limit=100000`);
  assert.equal(big.json.entries.length, AUDIT_MAX_LIMIT);
  assert.equal(big.json.limit, AUDIT_MAX_LIMIT);
  assert.notEqual(big.json.next_before, null);
  assert.equal((await s.call('Owner', `${AUD}?limit=1`)).json.entries.length, 1);
  for (const q of ['?limit=0', '?limit=-5', '?limit=abc', '?limit=1.5', '?before=abc', '?before=-1']) assert.equal((await s.call('Owner', AUD + q)).status, 400, q);
});

test('журнал: чтение не растит журнал; отказы чужим ролям на маршруте — тоже', async () => {
  const s = await start();
  const n0 = count(s.db);
  for (let i = 0; i < 5; i++) {
    await s.call('Owner', AUD); await s.call('Owner', DASH + P);
    await s.call('KidA', AUD); await s.call('TeacherA', DASH + P); await s.call(null, AUD);
  }
  assert.equal(count(s.db), n0);
});

test('журнал отдаёт только белый список полей', async () => {
  const s = await start();
  const e = (await s.call('Owner', AUD + '?limit=3')).json.entries;
  assert.equal(e.length, 3);
  for (const row of e) assert.deepEqual(Object.keys(row).sort(), ['action', 'actor_id', 'id', 'outcome', 'target_id', 'target_type', 'ts']);
});
