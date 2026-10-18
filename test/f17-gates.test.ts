// Ф17: ВЫСОКИЕ дыры аудита Ф14. Каждая — свой тест; каждый красен при поломке своего фикса (список поломок — в docs/ВОРОТА.md).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server, IncomingMessage } from 'node:http';
import { seed } from './seed.ts';
import { openDb } from '../src/db.ts';
import { seedDemo, type Demo } from '../src/seed.ts';
import { register, login } from '../src/auth.ts';
import { Denied, NotAvailable, ScheduleError, readAudit, actorOf, enroll, cancelEnrollment, listStudents, getProfile } from '../src/access.ts';
import { myLessons } from '../src/schedule.ts';
import { createApp, listen, clientIp, COOKIE } from '../src/server.ts';
import { loadConfig, ConfigError } from '../src/config.ts';

const NOW = 1_800_000_000_000;          // 2027-01-15
const NOW18 = Date.parse('2027-07-01T10:00:00Z');
const PW = 'test-password-123';

const lesson = (db: ReturnType<typeof seed>['db'], teacher: number, startsAt: string, audience: 'minor' | 'adult', max = 6) =>
  Number(db.prepare('INSERT INTO lessons(teacher_id, starts_at, audience, max_students) VALUES (?,?,?,?)').run(teacher, startsAt, audience, max).lastInsertRowid);
const auditActions = (db: ReturnType<typeof seed>['db'], ids: Record<string, number>) =>
  (readAudit(db, actorOf(db, ids.owner)) as { action: string; outcome: string; target_id: number }[]);

// ================= Дыра 1: аудитория группы против возраста ученика =================
test('Ф17-1: взрослого нельзя записать в детскую группу, ребёнка — во взрослую; отказ в журнале; владельцу тоже', () => {
  const { db, ids } = seed();
  const kidsLesson = ids.lessonA;                                              // minor (по умолчанию)
  const adultsLesson = lesson(db, ids.teacherA, '2099-02-02T10:00:00.000Z', 'adult');
  const adultC = actorOf(db, ids.adultC), parentA = actorOf(db, ids.parentA), owner = actorOf(db, ids.owner);
  // взрослый → детская группа: сам и от имени владельца
  assert.throws(() => enroll(db, adultC, kidsLesson, ids.adultC, NOW), NotAvailable);
  assert.throws(() => enroll(db, owner, kidsLesson, ids.adultC, NOW), NotAvailable);
  // ребёнок → взрослая группа: родитель и владелец
  assert.throws(() => enroll(db, parentA, adultsLesson, ids.kidA, NOW), NotAvailable);
  assert.throws(() => enroll(db, owner, adultsLesson, ids.kidA, NOW), NotAvailable);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM lesson_enrollments WHERE lesson_id=? AND student_id=? AND status='active'`).get(kidsLesson, ids.adultC) as { c: number }).c, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM lesson_enrollments WHERE lesson_id=? AND student_id=?`).get(adultsLesson, ids.kidA) as { c: number }).c, 0);
  const denied = auditActions(db, ids).filter(r => r.action === 'enroll.audience_mismatch' && r.outcome === 'denied');
  assert.equal(denied.length, 4, 'каждый отказ записан в журнал');
  // контроль: совпадающая аудитория — можно
  enroll(db, adultC, adultsLesson, ids.adultC, NOW);
  db.prepare(`INSERT INTO parental_consents(child_id, parent_id, granted_at) VALUES (?,?,datetime('now'))`).run(ids.kidB, ids.parentB);
  const k2 = lesson(db, ids.teacherA, '2099-03-03T10:00:00.000Z', 'minor');
  enroll(db, actorOf(db, ids.parentB), k2, ids.kidB, NOW);
  assert.ok(auditActions(db, ids).some(r => r.action === 'enroll.done' && r.target_id === adultsLesson));
});

test('Ф17-1 (HTTP): AdultD POST /api/lessons/<детская>/enroll — отказ; ParentA не записывает KidA во взрослую', async () => {
  const s = await start();
  const d = s.demo;
  await s.loginAs('AdultD'); await s.loginAs('ParentA');
  const r = await s.call('AdultD', 'POST', `/api/lessons/${d.lessons.b1}/enroll`, { student_id: d.users.AdultD.id });
  assert.equal(r.status, 404);
  const r2 = await s.call('ParentA', 'POST', `/api/lessons/${d.lessons.b2}/enroll`, { student_id: d.users.KidA.id });
  assert.equal(r2.status, 404);
  const n = s.db.prepare(`SELECT COUNT(*) c FROM lesson_enrollments WHERE (lesson_id=? AND student_id=?) OR (lesson_id=? AND student_id=?)`)
    .get(d.lessons.b1, d.users.AdultD.id, d.lessons.b2, d.users.KidA.id) as { c: number };
  assert.equal(n.c, 0);
});

// ================= Дыра 2: адрес клиента и вход =================
function fakeReq(remote: string, xff?: string): IncomingMessage {
  return { socket: { remoteAddress: remote }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } } as unknown as IncomingMessage;
}
test('Ф17-2: clientIp — X-Forwarded-For только от доверенного прокси, справа налево', () => {
  assert.equal(clientIp(fakeReq('10.0.0.5', '1.2.3.4'), []), '10.0.0.5', 'без TRUSTED_PROXY заголовок игнорируется');
  assert.equal(clientIp(fakeReq('10.0.0.5', '1.2.3.4'), ['127.0.0.1']), '10.0.0.5', 'не от доверенного — игнорируется');
  assert.equal(clientIp(fakeReq('127.0.0.1', '1.2.3.4'), ['127.0.0.1']), '1.2.3.4');
  assert.equal(clientIp(fakeReq('::ffff:127.0.0.1', '1.2.3.4'), ['127.0.0.1']), '1.2.3.4', 'IPv4-в-IPv6');
  assert.equal(clientIp(fakeReq('127.0.0.1', '6.6.6.6, 1.2.3.4'), ['127.0.0.1']), '1.2.3.4', 'подделка слева не работает: берём то, что дописал наш прокси');
  assert.equal(clientIp(fakeReq('127.0.0.1', '1.2.3.4, 127.0.0.1'), ['127.0.0.1']), '1.2.3.4');
  assert.equal(clientIp(fakeReq('127.0.0.1'), ['127.0.0.1']), '127.0.0.1', 'нет заголовка — адрес прокси');
});

test('Ф17-2: TRUSTED_PROXY в конфигурации — список адресов; мусор и «*» отвергаются', () => {
  const base = { LUMO_MODE: 'dev' };
  assert.deepEqual([...loadConfig({ ...base }).trustedProxies], []);
  assert.deepEqual([...loadConfig({ ...base, TRUSTED_PROXY: '127.0.0.1, ::1' }).trustedProxies], ['127.0.0.1', '::1']);
  assert.throws(() => loadConfig({ ...base, TRUSTED_PROXY: '*' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, TRUSTED_PROXY: 'evil.example' }), ConfigError);
});

const BADPW = 'wrong-password-xx';
test('Ф17-2 (HTTP): 20 неверных входов с одного адреса прокси не блокируют других пользователей школы', async () => {
  const s = await start({ trustedProxies: ['127.0.0.1'], loginDelayStepMs: 1, loginDelayMaxMs: 5 });
  // 20 разных логинов, все с одного клиентского адреса за прокси
  for (let i = 0; i < 20; i++) {
    const r = await s.call(null, 'POST', '/api/login', { login: `ghost${i}`, password: BADPW }, { 'x-forwarded-for': '203.0.113.9' });
    assert.equal(r.status, 401, `попытка ${i}`);
  }
  const owner = s.demo.users.Owner;
  for (const xff of ['198.51.100.7', '203.0.113.9', undefined]) {   // другой клиент, тот же адрес, вообще без заголовка (виден адрес прокси)
    const r = await s.call(null, 'POST', '/api/login', { login: owner.login, password: owner.password }, xff ? { 'x-forwarded-for': xff } : {});
    assert.equal(r.status, 200, `владелец входит (xff=${xff})`);
  }
  // то же, когда ВСЕ запросы без заголовка: адрес один — адрес прокси
  const s2 = await start({ loginDelayStepMs: 1, loginDelayMaxMs: 5 });
  for (let i = 0; i < 20; i++) assert.equal((await s2.call(null, 'POST', '/api/login', { login: `ghost${i}`, password: BADPW })).status, 401);
  const o2 = s2.demo.users.Owner, t2 = s2.demo.users.TeacherA;
  assert.equal((await s2.call(null, 'POST', '/api/login', { login: o2.login, password: o2.password })).status, 200);
  assert.equal((await s2.call(null, 'POST', '/api/login', { login: t2.login, password: t2.password })).status, 200);
});

test('Ф17-2 (HTTP): без TRUSTED_PROXY подделанный X-Forwarded-For не даёт обойти лимит пары логин+адрес', async () => {
  const s = await start({ loginDelayStepMs: 1, loginDelayMaxMs: 5 });
  const o = s.demo.users.Owner;
  for (let i = 0; i < 5; i++) await s.call(null, 'POST', '/api/login', { login: o.login, password: BADPW }, { 'x-forwarded-for': `7.7.7.${i}` });
  const r = await s.call(null, 'POST', '/api/login', { login: o.login, password: o.password }, { 'x-forwarded-for': '8.8.8.8' });
  assert.equal(r.status, 429);
});

test('Ф17-2 (HTTP): за доверенным прокси перебор логина с одного адреса блокирует пару логин+адрес, но не этого же владельца с другого адреса', async () => {
  const s = await start({ trustedProxies: ['127.0.0.1'], loginDelayStepMs: 1, loginDelayMaxMs: 5 });
  const o = s.demo.users.Owner;
  for (let i = 0; i < 5; i++) await s.call(null, 'POST', '/api/login', { login: o.login, password: BADPW }, { 'x-forwarded-for': '203.0.113.9' });
  assert.equal((await s.call(null, 'POST', '/api/login', { login: o.login, password: o.password }, { 'x-forwarded-for': '203.0.113.9' })).status, 429);
  assert.equal((await s.call(null, 'POST', '/api/login', { login: o.login, password: o.password }, { 'x-forwarded-for': '198.51.100.7' })).status, 200);
});

test('Ф17-2 (HTTP): с адреса с множеством неудач ответ приходит с нарастающей задержкой (а не отказом)', async () => {
  const s = await start({ trustedProxies: ['127.0.0.1'], loginDelayStepMs: 40, loginDelayMaxMs: 400 });
  const h = { 'x-forwarded-for': '203.0.113.50' };
  const timed = async () => { const t = Date.now(); const r = await s.call(null, 'POST', '/api/login', { login: `ghost${Math.random()}`, password: BADPW }, h); return { ms: Date.now() - t, status: r.status }; };
  for (let i = 0; i < 5; i++) await timed();                 // до порога — без задержки
  const first = await timed();                               // 6-я неудача: задержка ещё 0 (считается по прошлым)
  let last = first;
  for (let i = 0; i < 8; i++) last = await timed();
  assert.equal(last.status, 401);
  assert.ok(last.ms >= 380, `задержка достигла потолка: ${last.ms} мс`);
  assert.ok(first.ms < 300, `в начале задержки нет: ${first.ms} мс`);
});

// ================= Дыра 4: единый возрастной фильтр родителя =================
function teen17(db: ReturnType<typeof seed>['db'], ids: Record<string, number>) {
  // 17 лет на 2027-01-15, ровно 18 с 2027-06-01
  const id = Number(db.prepare(`INSERT INTO users(role, display_name, birth_date) VALUES ('student','Teen17','2009-06-01')`).run().lastInsertRowid);
  db.prepare('INSERT INTO students(user_id, level) VALUES (?,?)').run(id, 'B1');
  db.prepare('INSERT INTO parent_child(parent_id, child_id) VALUES (?,?)').run(ids.parentA, id);
  db.prepare('INSERT INTO contact_vault(user_id, email, phone) VALUES (?,?,?)').run(id, 't17@example.invalid', '+000-t17');
  return id;
}
test('Ф17-4: родитель видит и ведёт ученика, пока ему <18; в день 18-летия список, профиль, запись, отмена закрываются', () => {
  const { db, ids } = seed();
  const t17 = teen17(db, ids);
  register(db, ids.parentA, 'parenta', PW);
  const kidsLesson = lesson(db, ids.teacherA, '2099-04-04T10:00:00.000Z', 'minor');
  const kidsLesson2 = lesson(db, ids.teacherA, '2099-04-05T10:00:00.000Z', 'minor');
  const adultsLesson = lesson(db, ids.teacherA, '2099-04-06T10:00:00.000Z', 'adult');
  const pa = actorOf(db, ids.parentA);
  // 17 лет: всё доступно
  assert.ok(listStudents(db, pa, NOW).some(p => p.id === t17));
  assert.equal(getProfile(db, pa, t17, NOW).id, t17);
  enroll(db, pa, kidsLesson, t17, NOW);
  enroll(db, pa, kidsLesson2, t17, NOW);
  assert.ok(myLessons(db, login(db, 'parenta', PW, NOW), NOW).some(l => l.id === kidsLesson));
  cancelEnrollment(db, pa, kidsLesson2, t17, NOW);
  // 18 лет
  assert.ok(!listStudents(db, pa, NOW18).some(p => p.id === t17), 'нет в списке учеников');
  assert.throws(() => getProfile(db, pa, t17, NOW18), Denied);
  assert.ok(!myLessons(db, login(db, 'parenta', PW, NOW18), NOW18).some(l => l.students.some(s => s.id === t17)), 'нет в уроках');
  assert.throws(() => enroll(db, pa, adultsLesson, t17, NOW18), Denied, 'запись закрыта');
  assert.throws(() => cancelEnrollment(db, pa, kidsLesson, t17, NOW18), Denied, 'отмена закрыта');
  const log = auditActions(db, ids);
  assert.ok(log.some(r => r.action === 'child_lessons.enroll' && r.outcome === 'denied' && r.target_id === adultsLesson));
  assert.ok(log.some(r => r.action === 'child_lessons.cancel' && r.outcome === 'denied' && r.target_id === kidsLesson));
  // сам 18-летний управляет собой
  const self = actorOf(db, t17);
  cancelEnrollment(db, self, kidsLesson, t17, NOW18);
});

test('Ф17-4 (HTTP): родитель ученика 18+ не видит его в /api/students и /api/lessons, не записывает и не отменяет', async () => {
  const s = await start();
  const d = s.demo;
  s.db.prepare('INSERT INTO parent_child(parent_id, child_id) VALUES (?,?)').run(d.users.ParentA.id, d.users.AdultD.id);   // взрослый в связке с родителем
  await s.loginAs('ParentA');
  const st = await s.call('ParentA', 'GET', '/api/students');
  assert.equal(st.status, 200);
  assert.ok(!JSON.stringify(st.json).includes(`"id":${d.users.AdultD.id},`) && !st.json.students?.some?.((x: any) => x.id === d.users.AdultD.id), 'AdultD не в списке');
  assert.ok(st.json.students.some((x: any) => x.id === d.users.KidA.id), 'контроль: ребёнок виден');
  const ls = await s.call('ParentA', 'GET', '/api/lessons');
  assert.ok(!ls.json.lessons.some((l: any) => l.id === d.lessons.b2), 'взрослый урок b2 не виден');
  assert.ok(ls.json.lessons.some((l: any) => l.id === d.lessons.a1), 'контроль: уроки ребёнка видны');
  assert.equal((await s.call('ParentA', 'POST', `/api/lessons/${d.lessons.b2}/cancel`, { student_id: d.users.AdultD.id })).status, 403);
  assert.equal((await s.call('ParentA', 'POST', `/api/lessons/${d.lessons.b2}/enroll`, { student_id: d.users.AdultD.id })).status, 403);
  const left = s.db.prepare(`SELECT status FROM lesson_enrollments WHERE lesson_id=? AND student_id=?`).get(d.lessons.b2, d.users.AdultD.id) as { status: string };
  assert.equal(left.status, 'active', 'запись взрослого не тронута');
});

// ================= Дыра 5: один ответ not_available =================
test('Ф17-5 (HTTP): несуществующий, прошедший, отменённый, полный, чужой по аудитории и пересекающийся урок — один и тот же ответ без message', async () => {
  const s = await start();
  const d = s.demo, tb = d.users.TeacherB.id;
  await s.loginAs('ParentA');
  const kid = d.users.KidA.id;
  const a1start = (s.db.prepare('SELECT starts_at FROM lessons WHERE id=?').get(d.lessons.a1) as { starts_at: string }).starts_at;
  const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const past = lesson(s.db, tb, new Date(Date.now() - 86_400_000).toISOString(), 'minor');
  const cancelled = lesson(s.db, tb, future(20), 'minor'); s.db.prepare(`UPDATE lessons SET status='cancelled' WHERE id=?`).run(cancelled);
  const full = lesson(s.db, tb, future(21), 'minor', 1);
  s.db.prepare('INSERT INTO lesson_enrollments(lesson_id, student_id) VALUES (?,?)').run(full, d.users.KidB.id);
  const overlap = lesson(s.db, tb, a1start, 'minor');
  const cases: Record<string, number> = { нет_такого: 987654, past, cancelled, full, взрослая_группа: d.lessons.b2, overlap };
  const seen = new Set<string>();
  for (const [name, id] of Object.entries(cases)) {
    const r = await s.call('ParentA', 'POST', `/api/lessons/${id}/enroll`, { student_id: kid });
    assert.equal(r.status, 404, `${name}: статус`);
    assert.deepEqual(r.json, { error: 'not_available' }, `${name}: тело`);
    seen.add(r.text);
    const rl = await s.call('ParentA', 'POST', `/api/lessons/${id}/enroll?lang=uk`, { student_id: kid });
    seen.add(JSON.stringify({ ...rl.json, message_localized: undefined, lang: undefined }));
    assert.ok(rl.json.message_localized, 'локализованный текст есть, но один на все случаи');
  }
  assert.equal(seen.size, 1, `ответы различаются: ${[...seen].join(' | ')}`);
  // отмена: несуществующий / чужая запись (ребёнок не записан) / прошедший — тоже один ответ
  const freeLesson = lesson(s.db, tb, future(22), 'minor');
  const c1 = await s.call('ParentA', 'POST', `/api/lessons/987654/cancel`, { student_id: kid });
  const c2 = await s.call('ParentA', 'POST', `/api/lessons/${freeLesson}/cancel`, { student_id: kid });
  const c3 = await s.call('ParentA', 'POST', `/api/lessons/${past}/cancel`, { student_id: kid });
  for (const c of [c1, c2, c3]) { assert.equal(c.status, 404); assert.deepEqual(c.json, { error: 'not_available' }); }
  // контроль: нормальная запись проходит; чужой ребёнок — 403 одинаково для существующего и несуществующего урока
  assert.equal((await s.call('ParentA', 'POST', `/api/lessons/${freeLesson}/enroll`, { student_id: kid })).status, 200);
  const f1 = await s.call('ParentA', 'POST', `/api/lessons/${d.lessons.b1}/enroll`, { student_id: d.users.KidB.id });
  const f2 = await s.call('ParentA', 'POST', `/api/lessons/987654/enroll`, { student_id: d.users.KidB.id });
  assert.equal(f1.status, 403); assert.equal(f1.text, f2.text);
});

test('Ф17-5: в ядре отказ по уроку — NotAvailable (без текста причины); причина остаётся только в журнале', () => {
  const { db, ids } = seed();
  const owner = actorOf(db, ids.owner);
  let err: unknown;
  try { enroll(db, owner, 555, ids.adultC, NOW); } catch (e) { err = e; }
  assert.ok(err instanceof NotAvailable && err instanceof ScheduleError);
  assert.equal((err as Error).message, 'not_available');
  assert.ok(auditActions(db, ids).some(r => r.action === 'enroll.no_lesson' && r.outcome === 'denied' && r.target_id === 555));
});

// ---------- HTTP-каркас ----------
const servers: Server[] = [];
after(() => { for (const x of servers) x.close(); });
type Res = { status: number; text: string; json: any; headers: Headers };
async function start(opts: Parameters<typeof createApp>[1] = {}) {
  const db = openDb(':memory:');
  const demo: Demo = seedDemo(db);
  const server = createApp(db, opts);
  servers.push(server);
  const port = await listen(server, 0);
  const base = `http://127.0.0.1:${port}`;
  const jar: Record<string, string> = {};
  const call = async (as: string | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> => {
    const headers: Record<string, string> = { ...extra };
    if (as && jar[as]) headers.cookie = `${COOKIE}=${jar[as]}`;
    let payload: string | undefined;
    if (body !== undefined) { headers['content-type'] ??= 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + path, { method, headers, body: payload });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* не JSON */ }
    return { status: r.status, text, json, headers: r.headers };
  };
  const loginAs = async (key: string) => {
    const u = demo.users[key];
    const r = await call(null, 'POST', '/api/login', { login: u.login, password: u.password });
    assert.equal(r.status, 200, `login ${key}`);
    jar[key] = /sid=([0-9a-f]+)/.exec(r.headers.get('set-cookie') ?? '')![1];
  };
  return { db, demo, base, call, loginAs };
}
