// Ф30: то, что нашёл живой прогон: лимит повторных заявок на удаление (3 в сутки на ребёнка) + комбинации, которых не было в матрице
// (два родителя у одного ребёнка, замена преподавателя, чужой родитель). Реальные HTTP-запросы, выдуманные данные.
// Время управляемое: стартует 2026-10-20 12:00 UTC и двигается вручную.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import { seedDemo } from '../src/seed.ts';
import { register } from '../src/auth.ts';
import { createApp, listen, COOKIE } from '../src/server.ts';
import { actorOf, assignSubstitute, removeSubstitute, getProfile, Denied } from '../src/access.ts';
import { ERASURE_DAILY_LIMIT } from '../src/erasure.ts';
import { catalog, LANGS } from '../src/i18n.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });
const START = Date.parse('2026-10-20T12:00:00Z');

async function start() {
  const db = openDb(':memory:');
  const demo = seedDemo(db, START);
  const clock = { t: START };
  const teen = (key: string, birth: string, parent: string) => {
    const id = Number(db.prepare(`INSERT INTO users(role, display_name, birth_date) VALUES ('student',?,?)`).run(`Fake${key}`, birth).lastInsertRowid);
    db.prepare('INSERT INTO contact_vault(user_id, email, phone) VALUES (?,?,?)').run(id, `${key.toLowerCase()}@example.test`, '+00 222 000 000');
    db.prepare(`INSERT INTO students(user_id, level) VALUES (?, 'B1')`).run(id);
    register(db, id, key.toLowerCase(), `f30-demo-password-${key}`);
    db.prepare('INSERT INTO parent_child(parent_id, child_id) VALUES (?,?)').run(demo.users[parent].id, id);
    return { id, login: key.toLowerCase(), password: `f30-demo-password-${key}` };
  };
  const extra = { Teen16: teen('Teen16', '2010-01-01', 'ParentC'), Teen17: teen('Teen17', '2009-01-01', 'ParentA') };
  const all: Record<string, { id: number; login: string; password: string }> = { ...demo.users, ...extra };
  const server = createApp(db, { now: () => clock.t, rateLimit: false });
  servers.push(server);
  const base = `http://127.0.0.1:${await listen(server, 0)}`;
  const jar: Record<string, string> = {};
  const login = async (...keys: string[]) => {
    for (const k of keys) {
      const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: all[k].login, password: all[k].password }) });
      assert.equal(r.status, 200, `login ${k}`);
      jar[k] = /sid=([0-9a-f]+)/.exec(r.headers.get('set-cookie') ?? '')![1];
    }
  };
  const call = async (as: string, method: string, path: string, body?: unknown) => {
    const h: Record<string, string> = { cookie: `${COOKIE}=${jar[as]}` };
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, text, json };
  };
  return { db, demo, all, clock, login, call, n: (sql: string, ...a: any[]) => Number((db.prepare(sql).get(...a) as any).c) };
}
const ids = (r: { json: any }) => (r.json.students as { id: number }[]).map(s => s.id).sort((a, b) => a - b);

test('Ф30 лимит: не больше 3 заявок на удаление в сутки на ребёнка — 4-я 429 request_limit, родителям новых уведомлений нет, через сутки снова можно', async () => {
  assert.equal(ERASURE_DAILY_LIMIT, 3);
  const s = await start();
  await s.login('Teen17', 'ParentA', 'Teen16', 'ParentC');
  for (let i = 0; i < 3; i++) {
    const r = await s.call('Teen17', 'POST', '/api/erasure-requests', {});
    assert.equal(r.status, 201, `заявка ${i + 1}`);
    assert.equal((await s.call('ParentA', 'POST', `/api/erasure-requests/${r.json.request.id}/parent-reject`, {})).status, 200);
    s.clock.t += 60_000;
  }
  const notes = () => s.n('SELECT COUNT(*) c FROM parent_notifications WHERE kind = ?', 'erasure_request');
  assert.equal(notes(), 3);
  const over = await s.call('Teen17', 'POST', '/api/erasure-requests', {});
  assert.equal(over.status, 429); assert.equal(over.json.error, 'request_limit');
  assert.equal(notes(), 3, 'отказ не плодит уведомлений');
  assert.equal(s.n(`SELECT COUNT(*) c FROM erasure_requests WHERE subject_id = ?`, s.all.Teen17.id), 3, 'строка не создана');
  assert.equal(s.n(`SELECT COUNT(*) c FROM audit_log WHERE action = 'erasure.request.limited'`), 1);
  // другой ребёнок не затронут
  assert.equal((await s.call('Teen16', 'POST', '/api/erasure-requests', {})).status, 201);
  // лимит считается по ребёнку, а не по подающему: родитель за 17-летнего (18+ не нужен — 17 ещё «ребёнок») тоже упирается
  const viaParent = await s.call('ParentA', 'POST', '/api/erasure-requests', { student_id: s.all.Teen17.id });
  assert.equal(viaParent.status, 429);
  // через сутки — снова можно
  s.clock.t += 86_400_000;
  await s.login('Teen17');   // сессия за сутки истекла — входим заново
  assert.equal((await s.call('Teen17', 'POST', '/api/erasure-requests', {})).status, 201);
  for (const l of LANGS) assert.ok(catalog(l)['error.request_limit'], `i18n ${l}`);
});

test('Ф30 два родителя одного ребёнка: оба видят ребёнка и его выгрузку, чужой родитель — нет (403/404), заявку чужой родитель не подаёт и не отклоняет', async () => {
  const s = await start();
  s.db.prepare('INSERT INTO parent_child(parent_id, child_id) VALUES (?,?)').run(s.all.ParentB.id, s.all.KidA.id);   // у Kai два родителя: A и B
  await s.login('ParentA', 'ParentB', 'ParentC', 'Teen16');
  const kai = s.all.KidA.id;
  assert.ok(ids(await s.call('ParentA', 'GET', '/api/students')).includes(kai));
  assert.ok(ids(await s.call('ParentB', 'GET', '/api/students')).includes(kai));
  assert.ok(!ids(await s.call('ParentC', 'GET', '/api/students')).includes(kai));
  for (const p of ['ParentA', 'ParentB']) assert.equal((await s.call(p, 'GET', `/api/export/${kai}`)).status, 200, p);
  for (const p of ['ParentA', 'ParentB']) { const r = await s.call(p, 'GET', `/api/export/${kai}`); assert.equal(r.json.contacts, null, 'контакты ребёнка родителю не отдаются'); }
  for (const path of [`/api/export/${kai}`, `/api/consents/${kai}`, `/api/contacts/${kai}`]) assert.equal((await s.call('ParentC', 'GET', path)).status, 403, path);
  assert.equal((await s.call('ParentC', 'POST', '/api/erasure-requests', { student_id: kai })).status, 404);
  // заявка 16-летней Teen16 (родитель C): ни A, ни B не подтверждают и не отклоняют
  const id = (await s.call('Teen16', 'POST', '/api/erasure-requests', {})).json.request.id;
  for (const p of ['ParentA', 'ParentB']) for (const act of ['parent-confirm', 'parent-reject']) {
    const r = await s.call(p, 'POST', `/api/erasure-requests/${id}/${act}`, {});
    assert.equal(r.status, 404, `${p} ${act}`); assert.deepEqual(r.json, { error: 'not_available' });
  }
  assert.equal((await s.call('ParentA', 'GET', '/api/erasure-requests')).json.requests.length, 0);
  assert.equal(s.n('SELECT COUNT(*) c FROM erasure_requests WHERE id = ? AND status = ?', id, 'pending_parent'), 1);
});

test('Ф30 замена преподавателя: замещающий видит учеников ТОЛЬКО замещаемого урока, контактов не видит; после снятия — теряет; при передаче урока старый теряет учеников этого урока', async () => {
  const s = await start();
  const { KidA, KidB, TeenC, AdultD, TeacherA, TeacherB, Owner } = s.all;
  const lessonA1 = s.demo.lessons.a1;                  // TeacherA: KidA + KidB
  await s.login('TeacherA', 'TeacherB');
  assert.deepEqual(ids(await s.call('TeacherB', 'GET', '/api/students')), [KidB.id, TeenC.id, AdultD.id].sort((a, b) => a - b));
  assert.equal((await s.call('TeacherB', 'GET', `/api/rooms/${lessonA1}`)).status, 403);
  assignSubstitute(s.db, actorOf(s.db, Owner.id), lessonA1, TeacherB.id, START);
  assert.ok(ids(await s.call('TeacherB', 'GET', '/api/students')).includes(KidA.id), 'замещающий видит Kai');
  assert.ok(!ids(await s.call('TeacherB', 'GET', '/api/students')).includes(s.all.Teen17.id), 'но не чужих');
  const tb = actorOf(s.db, TeacherB.id);
  assert.equal(getProfile(s.db, tb, KidA.id, START).display_name, 'Kai', 'профиль ученика замещаемого урока доступен');
  assert.throws(() => getProfile(s.db, tb, s.all.Teen17.id, START), Denied, 'профиль постороннего — нет');
  assert.throws(() => getProfile(s.db, tb, s.all.Teen16.id, START), Denied);
  for (const path of [`/api/contacts/${KidA.id}`, `/api/export/${KidA.id}`, `/api/consents/${KidA.id}`, `/api/contacts/${TeacherA.id}`]) assert.equal((await s.call('TeacherB', 'GET', path)).status, 403, path);
  removeSubstitute(s.db, actorOf(s.db, Owner.id), lessonA1);
  assert.ok(!ids(await s.call('TeacherB', 'GET', '/api/students')).includes(KidA.id), 'после снятия замены доступа нет');
  assert.throws(() => getProfile(s.db, tb, KidA.id, START), Denied, 'и профиль закрыт');
  // урок переведён другому преподавателю (в API такого маршрута нет — правим базу): старый не видит учеников этого урока, новый видит
  s.db.prepare('UPDATE lessons SET teacher_id = ? WHERE id = ?').run(TeacherB.id, lessonA1);
  const a = ids(await s.call('TeacherA', 'GET', '/api/students'));
  assert.ok(!a.includes(KidB.id), 'старый преподаватель потерял Kira (она только на переданном уроке)');
  assert.ok(a.includes(KidA.id), 'Kai остался: у него ещё урок с TeacherA (a2)');
  assert.ok(ids(await s.call('TeacherB', 'GET', '/api/students')).includes(KidA.id));
  assert.equal((await s.call('TeacherA', 'GET', `/api/rooms/${lessonA1}`)).status, 403);
  for (const t of ['TeacherA', 'TeacherB']) assert.equal((await s.call(t, 'GET', `/api/contacts/${KidB.id}`)).status, 403);
});
