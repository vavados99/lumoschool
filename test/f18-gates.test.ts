// Ф18: средние и низкие дыры аудита Ф14 (№3, №6–№10). Реальные HTTP-запросы, подставляемые часы, выдуманные данные.
// Каждый тест краснеет, если временно сломать своё правило (список поломок — в отчёте и в docs/ВОРОТА.md).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import { seedDemo } from '../src/seed.ts';
import { createApp, listen, COOKIE, cookieNameFor } from '../src/server.ts';
import { actorOf, TEACHER_ACCESS_GRACE_MS, ScheduleError } from '../src/access.ts';
import { createSlot } from '../src/schedule.ts';
import { login } from '../src/auth.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });
const MIN = 60_000;

async function start(opts: { secure?: boolean } = {}) {
  const T0 = Date.now();
  const clock = { now: T0 };
  const db = openDb(':memory:');
  const demo = seedDemo(db, T0);
  const server = createApp(db, { now: () => clock.now, secureCookie: opts.secure });
  servers.push(server);
  const port = await listen(server, 0);
  const base = `http://127.0.0.1:${port}`;
  const jar: Record<string, string> = {};
  const cname = cookieNameFor(!!opts.secure);
  const call = async (as: string | null, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (as && jar[as]) headers.cookie = `${cname}=${jar[as]}`;
    let payload: string | undefined;
    if (method !== 'GET') { headers['content-type'] = 'application/json'; payload = JSON.stringify(body ?? {}); }
    const r = await fetch(base + path, { method, headers, body: payload });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, text, json };
  };
  let lastSetCookie = '';
  for (const k of Object.keys(demo.users)) {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: demo.users[k].login, password: demo.users[k].password }) });
    assert.equal(r.status, 200);
    lastSetCookie = r.headers.get('set-cookie') ?? '';
    jar[k] = /sid=([0-9a-f]+)/.exec(lastSetCookie)![1];
  }
  const L = demo.lessons;
  const startAt = (id: number, offsetMin: number, dur = 50) =>
    db.prepare('UPDATE lessons SET starts_at = ?, duration_min = ?, status = \'planned\' WHERE id = ?').run(new Date(T0 + offsetMin * MIN).toISOString(), dur, id);
  startAt(L.a1, 60); startAt(L.a2, 600); startAt(L.b1, 60); startAt(L.b2, 60);
  const at = (offsetMin: number) => { clock.now = T0 + offsetMin * MIN; };
  const U = (k: string) => demo.users[k];
  return { db, demo, call, at, T0, clock, startAt, L, U, base, lastSetCookie, room: (id: number) => `/api/rooms/${id}` };
}
type S = Awaited<ReturnType<typeof start>>;
const countAudit = (s: S) => Number((s.db.prepare('SELECT COUNT(*) c FROM audit_log').get() as { c: number }).c);

// ---------- №3: правило двух взрослых для 1:1 «ребёнок + преподаватель» ----------
// a2 = TeacherA + только KidA (ребёнок) — это 1:1; a1 = KidA + KidB — группа, правило не трогает.
test('Ф18 №3: урок 1:1 ребёнок + преподаватель — без родителя/владельца в комнате ни преподаватель, ни ребёнок не входят', async () => {
  const s = await start();
  s.at(595);
  const room = s.room(s.L.a2);
  let r = await s.call('TeacherA', 'POST', room + '/enter');
  assert.equal(r.status, 409); assert.equal(r.json.error, 'second_adult_required');
  r = await s.call('KidA', 'POST', room + '/enter');
  assert.equal(r.status, 409); assert.ok(['second_adult_required', 'wait_for_adult'].includes(r.json.error));
  // отказ записан в журнал
  assert.ok(Number((s.db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE action = 'room.enter.second_adult_required' AND outcome = 'denied'`).get() as { c: number }).c) >= 1);
  // родитель входит первым — после него могут войти преподаватель и ребёнок
  assert.equal((await s.call('ParentA', 'POST', room + '/enter')).status, 200);
  assert.equal((await s.call('TeacherA', 'POST', room + '/enter')).status, 200);
  assert.equal((await s.call('KidA', 'POST', room + '/enter')).status, 200);
  // владелец тоже считается вторым взрослым (отдельная комната-1:1: owner + teacher + child)
  const s2 = await start();
  s2.at(595);
  assert.equal((await s2.call('TeacherA', 'POST', s2.room(s2.L.a2) + '/enter')).status, 409);
  assert.equal((await s2.call('Owner', 'POST', s2.room(s2.L.a2) + '/enter')).status, 200);
  assert.equal((await s2.call('TeacherA', 'POST', s2.room(s2.L.a2) + '/enter')).status, 200);
  // группа (два ребёнка) — прежнее поведение: преподаватель входит сам
  s2.at(55);
  assert.equal((await s2.call('TeacherA', 'POST', s2.room(s2.L.a1) + '/enter')).status, 200);
});

test('Ф18 №3: единственный родитель/владелец не может выйти, оставив ребёнка наедине с преподавателем', async () => {
  const s = await start();
  s.at(595);
  const room = s.room(s.L.a2);
  for (const who of ['ParentA', 'TeacherA', 'KidA']) assert.equal((await s.call(who, 'POST', room + '/enter')).status, 200, who);
  const r = await s.call('ParentA', 'POST', room + '/leave');
  assert.equal(r.status, 409); assert.equal(r.json.error, 'second_adult_would_leave');
  assert.ok(Number((s.db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE action = 'room.leave.would_leave_one_on_one' AND outcome = 'denied'`).get() as { c: number }).c) >= 1);
  // ребёнок вышел — родитель выйти может
  assert.equal((await s.call('KidA', 'POST', room + '/leave')).status, 200);
  assert.equal((await s.call('ParentA', 'POST', room + '/leave')).status, 200);
});

test('Ф18 №3: реплика преподавателя ребёнку в ветке уведомляет родителя этого ребёнка (и только его); без текста', async () => {
  const s = await start();
  const t = await s.call('ParentA', 'POST', '/api/threads', { teacher_id: s.U('TeacherA').id, student_id: s.U('KidA').id });
  assert.equal(t.status, 201);
  assert.equal((await s.call('ParentA', 'GET', '/api/notifications')).json.notifications.length, 0);
  const m = await s.call('TeacherA', 'POST', `/api/threads/${t.json.id}/messages`, { body: 'Please bring the workbook SECRETWORD' });
  assert.equal(m.status, 201);
  const a = await s.call('ParentA', 'GET', '/api/notifications');
  assert.equal(a.status, 200);
  assert.equal(a.json.notifications.length, 1);
  assert.equal(a.json.notifications[0].kind, 'thread_message');
  assert.equal(a.json.notifications[0].child_id, s.U('KidA').id);
  assert.equal(a.json.notifications[0].ref_id, t.json.id);
  assert.ok(!a.text.includes('SECRETWORD'), 'текста сообщения в уведомлении нет');
  assert.equal((await s.call('ParentB', 'GET', '/api/notifications')).json.notifications.length, 0, 'чужой родитель не получает');
  // реплика самого ребёнка/родителя уведомлений не порождает
  await s.call('KidA', 'POST', `/api/threads/${t.json.id}/messages`, { body: 'ok' });
  await s.call('ParentA', 'POST', `/api/threads/${t.json.id}/messages`, { body: 'thanks' });
  assert.equal((await s.call('ParentA', 'GET', '/api/notifications')).json.notifications.length, 1);
  // не-родители ручку не читают
  for (const who of ['KidA', 'TeacherA', 'Owner']) assert.equal((await s.call(who, 'GET', '/api/notifications')).status, 403, who);
});

test('Ф18 №3: реплика преподавателя в чате комнаты уведомляет родителей детей на уроке', async () => {
  const s = await start();
  s.at(55);
  assert.equal((await s.call('TeacherA', 'POST', s.room(s.L.a1) + '/enter')).status, 200);
  const r = await s.call('TeacherA', 'POST', s.room(s.L.a1) + '/chat', { body: 'Welcome everyone' });
  assert.equal(r.status, 201);
  const pa = (await s.call('ParentA', 'GET', '/api/notifications')).json.notifications;
  const pb = (await s.call('ParentB', 'GET', '/api/notifications')).json.notifications;
  assert.deepEqual(pa.map((n: any) => [n.kind, n.child_id, n.ref_id]), [['room_message', s.U('KidA').id, s.L.a1]]);
  assert.deepEqual(pb.map((n: any) => [n.kind, n.child_id, n.ref_id]), [['room_message', s.U('KidB').id, s.L.a1]]);
  assert.equal((await s.call('ParentC', 'GET', '/api/notifications')).json.notifications.length, 0);
});

// ---------- №6: окно доступа преподавателя ----------
test('Ф18 №6: через TEACHER_ACCESS_GRACE_MS после конца урока преподаватель теряет ученика: списки, профиль, ветка', async () => {
  const s = await start();
  s.startAt(s.L.a2, 60);   // конец урока +2 ч остаются внутри 12-часовой сессии
  const th = await s.call('ParentA', 'POST', '/api/threads', { teacher_id: s.U('TeacherA').id, student_id: s.U('KidA').id });
  assert.equal(th.status, 201);
  const endMin = 60 + 50, graceMin = TEACHER_ACCESS_GRACE_MS / MIN;
  const kid = s.U('KidA').id;
  const seesKid = async () => ((await s.call('TeacherA', 'GET', '/api/students')).json.students as { id: number }[]).some(x => x.id === kid);
  const lessonStudents = async () => ((await s.call('TeacherA', 'GET', '/api/lessons')).json.lessons as { id: number; students: unknown[] }[]).find(l => l.id === s.L.a2)!.students.length;
  const threadStatus = async () => (await s.call('TeacherA', 'GET', `/api/threads/${th.json.id}`)).status;
  // до окончания и внутри окна — доступ есть
  s.at(endMin - 1); assert.ok(await seesKid()); assert.equal(await lessonStudents(), 1); assert.equal(await threadStatus(), 200);
  s.at(endMin + graceMin - 1); assert.ok(await seesKid()); assert.equal(await lessonStudents(), 1); assert.equal(await threadStatus(), 200);
  // окно вышло — доступ закрыт везде
  s.at(endMin + graceMin + 1);
  assert.ok(!(await seesKid()), '/api/students');
  assert.equal(await lessonStudents(), 0, '/api/lessons: учеников нет');
  assert.equal(await threadStatus(), 403, 'ветка закрыта для преподавателя');
  assert.equal((await s.call('TeacherA', 'POST', `/api/threads/${th.json.id}/messages`, { body: 'late' })).status, 403);
  assert.deepEqual((await s.call('TeacherA', 'GET', '/api/threads')).json.threads, []);
  // родитель и владелец не затронуты
  assert.equal((await s.call('ParentA', 'GET', `/api/threads/${th.json.id}`)).status, 200);
  assert.ok(((await s.call('Owner', 'GET', '/api/students')).json.students as { id: number }[]).some(x => x.id === kid));
});

test('Ф18 №6: отменённый урок закрывает доступ преподавателя к ученику сразу', async () => {
  const s = await start();
  const kid = s.U('KidA').id;
  const seesKid = async () => ((await s.call('TeacherA', 'GET', '/api/students')).json.students as { id: number }[]).some(x => x.id === kid);
  assert.ok(await seesKid());
  s.db.prepare(`UPDATE lessons SET status = 'cancelled' WHERE id = ?`).run(s.L.a2);
  s.db.prepare(`UPDATE lessons SET status = 'cancelled' WHERE id = ?`).run(s.L.a1);
  assert.ok(!(await seesKid()), 'ученик отменённого урока исчез из списка преподавателя');
});

// ---------- №7: id родителя не уходит преподавателю ----------
/** Обход JSON: у любого объекта с ролью parent не должно быть id/from_id; ключ parent_id недопустим нигде. */
function assertNoParentId(v: unknown, where: string) {
  if (Array.isArray(v)) { v.forEach(x => assertNoParentId(x, where)); return; }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.role === 'parent') for (const k of ['id', 'user_id']) assert.ok(!(k in o), `${where}: у родителя есть ${k}`);   // участник комнаты
    if (o.from_role === 'parent') for (const k of ['from_id', 'user_id']) assert.ok(!(k in o), `${where}: у реплики родителя есть ${k}`);   // реплика ветки (id — номер реплики, не человека)
    assert.ok(!('parent_id' in o), `${where}: parent_id`);
    Object.values(o).forEach(x => assertNoParentId(x, where));
  }
}
test('Ф18 №7: преподавателю не отдаётся id родителя — ни в ветке, ни в комнате, ни в списках', async () => {
  const s = await start();
  const th = await s.call('ParentA', 'POST', '/api/threads', { teacher_id: s.U('TeacherA').id, student_id: s.U('KidA').id });
  await s.call('ParentA', 'POST', `/api/threads/${th.json.id}/messages`, { body: 'hello teacher' });
  s.at(55);
  assert.equal((await s.call('ParentA', 'POST', s.room(s.L.a1) + '/enter')).status, 200);
  assert.equal((await s.call('TeacherA', 'POST', s.room(s.L.a1) + '/enter')).status, 200);
  const pid = s.U('ParentA').id;
  const seen: string[] = [];
  for (const [m, p] of [['GET', `/api/threads/${th.json.id}`], ['GET', '/api/threads'], ['GET', s.room(s.L.a1)], ['POST', s.room(s.L.a1) + '/enter'], ['GET', '/api/lessons'], ['GET', '/api/students']] as const) {
    const r = await s.call('TeacherA', m, p);
    assert.equal(r.status, 200, `${m} ${p}`);
    assertNoParentId(r.json, `${m} ${p}`);
    seen.push(`${m} ${p}`);
  }
  // контрольный: родитель действительно есть в комнате и ветке как роль, а владельцу id виден (проверка не пустая)
  const rs = (await s.call('TeacherA', 'GET', s.room(s.L.a1))).json;
  assert.ok(rs.participants.some((x: any) => x.role === 'parent'), 'родитель в комнате виден как роль');
  const post = (await s.call('TeacherA', 'GET', `/api/threads/${th.json.id}`)).json.posts.find((x: any) => x.from_role === 'parent');
  assert.ok(post, 'реплика родителя видна как роль');
  assert.ok(!('from_id' in post) && !('from_name' in post));
  assert.ok((await s.call('Owner', 'GET', s.room(s.L.a1))).json.participants.some((x: any) => x.id === pid), 'владельцу id родителя виден');
  assert.equal(seen.length, 6);
});

// ---------- №8: audience — только 'minor' | 'adult' ----------
test('Ф18 №8: audience=toString/constructor/__proto__ и прочее → HTTP 400, не 500', async () => {
  const s = await start();
  const when = new Date(s.T0 + 3 * 24 * 60 * MIN).toISOString();
  for (const bad of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', 'Minor', 'ADULT', '', 'adult ']) {
    const r = await s.call('TeacherA', 'POST', '/api/lessons', { starts_at: when, audience: bad });
    assert.equal(r.status, 400, `audience=${JSON.stringify(bad)} → ${r.status}`);
    assert.equal(r.json.error, 'bad_request');
  }
  for (const [i, ok] of (['minor', 'adult'] as const).entries()) {
    const r = await s.call('TeacherA', 'POST', '/api/lessons', { starts_at: new Date(s.T0 + (4 + i) * 24 * 60 * MIN).toISOString(), audience: ok });
    assert.equal(r.status, 201, ok);
  }
});
test('Ф18 №8: ядро createSlot само отвергает prototype-ключи в audience (вторая линия)', async () => {
  const s = await start();
  const tokenRow = await fetch(s.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: s.U('TeacherA').login, password: s.U('TeacherA').password }) });
  const token = /sid=([0-9a-f]+)/.exec(tokenRow.headers.get('set-cookie') ?? '')![1];
  for (const bad of ['toString', 'constructor', '__proto__']) {
    assert.throws(() => createSlot(s.db, token, s.T0, new Date(s.T0 + 9 * 24 * 60 * MIN).toISOString(), 50, bad as never), (e: unknown) => e instanceof ScheduleError && /audience/.test((e as Error).message), bad);
  }
});

// ---------- №9: дубль /api/audit ----------
test('Ф18 №9: GET /api/audit не пишет в журнал при чтении и не отдаёт всю таблицу', async () => {
  const s = await start();
  const ins = s.db.prepare(`INSERT INTO audit_log(actor_id, action, target_type, target_id, outcome) VALUES (NULL, 'bulk.probe', NULL, NULL, 'allowed')`);
  s.db.exec('BEGIN'); for (let i = 0; i < 1500; i++) ins.run(); s.db.exec('COMMIT');
  const before = countAudit(s);
  const r1 = await s.call('Owner', 'GET', '/api/audit');
  const r2 = await s.call('Owner', 'GET', '/api/audit');
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  assert.equal(countAudit(s), before, 'чтение журнала журнал не пополняет');
  assert.ok(r1.json.entries.length <= 500 && r1.json.entries.length > 0, `entries=${r1.json.entries.length}`);
  assert.ok(before > 1500);
  // остальные роли по-прежнему не читают
  for (const who of ['TeacherA', 'ParentA', 'KidA']) assert.equal((await s.call(who, 'GET', '/api/audit')).status, 403, who);
  // /api/owner/audit остаётся
  assert.equal((await s.call('Owner', 'GET', '/api/owner/audit')).status, 200);
});

// ---------- №10: login_attempts и кука ----------
test('Ф18 №10: старые login_attempts чистятся самим входом; неизвестный логин (мог быть паролем) в базе открытым текстом не хранится', async () => {
  const s = await start();
  const DAY = 24 * 60 * MIN;
  const ins = s.db.prepare('INSERT INTO login_attempts(login, ts, ok, ip) VALUES (?,?,?,?)');
  ins.run('old-attempt', s.T0 - 2 * DAY, 0, '9.9.9.9');
  ins.run('fresh-attempt', s.T0 - 60 * MIN, 0, '9.9.9.9');
  const typed = 'my-secret-Passw0rd-typed-as-login';
  const r = await s.call(null, 'POST', '/api/login', { login: typed, password: 'x'.repeat(12) });
  assert.equal(r.status, 401);
  const has = (l: string) => Number((s.db.prepare('SELECT COUNT(*) c FROM login_attempts WHERE login = ?').get(l) as { c: number }).c);
  assert.equal(has('old-attempt'), 0, 'старше суток — удалено при входе');
  assert.equal(has('fresh-attempt'), 1, 'свежее не тронуто');
  assert.equal(has(typed), 0, 'введённая строка не лежит в базе открытым текстом');
  const rows = s.db.prepare(`SELECT login FROM login_attempts WHERE login LIKE 'unknown:%'`).all() as { login: string }[];
  assert.ok(rows.length >= 1 && !rows.some(x => x.login.includes('secret')));
  // счётчик пары по неизвестному логину работает: 5 неудач → блок для пары логин+адрес
  const db2 = openDb(':memory:');
  for (let i = 0; i < 5; i++) assert.throws(() => login(db2, 'nobody-here', 'wrong-password-1', s.T0 + i, undefined, '1.1.1.1'), /invalid login/);
  assert.throws(() => login(db2, 'nobody-here', 'wrong-password-1', s.T0 + 10, undefined, '1.1.1.1'), /too many attempts/);
  void actorOf;
});

test('Ф18 №10: в боевом режиме (secure) кука сессии — __Host-sid с Secure, Path=/, без Domain; обычное sid не принимается', async () => {
  const s = await start({ secure: true });
  assert.match(s.lastSetCookie, /^__Host-sid=[0-9a-f]+;/);
  assert.match(s.lastSetCookie, /; Secure/); assert.match(s.lastSetCookie, /; Path=\//); assert.doesNotMatch(s.lastSetCookie, /Domain=/i);
  assert.equal((await s.call('Owner', 'GET', '/api/me')).status, 200);
  const sid = /__Host-sid=([0-9a-f]+)/.exec(s.lastSetCookie)![1];
  const plain = await fetch(s.base + '/api/me', { headers: { cookie: `${COOKIE}=${sid}` } });
  assert.equal(plain.status, 401, 'кука без префикса не принимается');
  const out = await fetch(s.base + '/api/logout', { method: 'POST', headers: { cookie: `__Host-sid=${sid}`, 'content-type': 'application/json' }, body: '{}' });
  assert.match(out.headers.get('set-cookie') ?? '', /^__Host-sid=;/);
  // без secure имя прежнее
  const s2 = await start();
  assert.match(s2.lastSetCookie, /^sid=[0-9a-f]+;/);
});
