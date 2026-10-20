// Ф29: родитель отклоняет заявку ребёнка на удаление данных + изоляция ролей вокруг канала. Реальные HTTP-запросы, выдуманные данные.
// Время зафиксировано: 2026-10-20 12:00 UTC (пороги возраста считаются от него, не от «сегодня» — тест не «плывёт»).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import { seedDemo, type Demo } from '../src/seed.ts';
import { register } from '../src/auth.ts';
import { createApp, listen, COOKIE, type ServerOptions } from '../src/server.ts';
import { actorOf, Denied } from '../src/access.ts';
import { parentReject } from '../src/erasure.ts';
import { catalog, LANGS, t } from '../src/i18n.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });
const NOW = Date.parse('2026-10-20T12:00:00Z');
const B = { age15y364d: '2010-10-21', age16: '2010-10-20', age17: '2008-10-21', age18: '2008-10-20' };   // даты рождения относительно NOW

async function start(opts: ServerOptions = {}) {
  const db = openDb(':memory:');
  const demo: Demo = seedDemo(db);
  const extra: Record<string, { id: number; login: string; password: string; email: string }> = {};
  let n = 0;
  const mk = (key: string, role: 'student' | 'parent', birth: string, parent?: string) => {
    n++;
    const id = Number(db.prepare('INSERT INTO users(role, display_name, birth_date) VALUES (?,?,?)').run(role, `Fake${key}`, birth).lastInsertRowid);
    const email = `${key.toLowerCase()}@example.test`;
    db.prepare('INSERT INTO contact_vault(user_id, email, phone) VALUES (?,?,?)').run(id, email, `+00 111 000 ${String(n).padStart(3, '0')}`);
    if (role === 'student') db.prepare('INSERT INTO students(user_id, level) VALUES (?,?)').run(id, 'B1');
    const u = { id, login: key.toLowerCase(), password: `f29-demo-password-${n}`, email };
    register(db, id, u.login, u.password);
    if (parent) db.prepare('INSERT INTO parent_child(parent_id, child_id) VALUES (?,?)').run(extra[parent].id, id);
    return extra[key] = u;
  };
  mk('PX', 'parent', '1980-01-01'); mk('PY', 'parent', '1981-01-01'); mk('PZ', 'parent', '1982-01-01');
  mk('Teen16', 'student', B.age16, 'PX');          // ровно 16
  mk('Teen15', 'student', B.age15y364d, 'PX');     // 15 лет 364 дня
  mk('Teen17', 'student', B.age17, 'PY');          // 17 — родитель PY
  mk('Teen18', 'student', B.age18, 'PZ');          // ровно 18 — взрослый (связь с родителем осталась, права родителя кончились)
  const server = createApp(db, { now: () => NOW, rateLimit: false, ...opts });
  servers.push(server);
  const base = `http://127.0.0.1:${await listen(server, 0)}`;
  const all = { ...demo.users, ...extra } as Record<string, { id: number; login: string; password: string; email: string }>;
  const jar: Record<string, string> = {};
  const call = async (as: string | null, method: string, path: string, body?: unknown) => {
    const h: Record<string, string> = {};
    if (as && jar[as]) h.cookie = `${COOKIE}=${jar[as]}`;
    let payload: string | undefined;
    if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + path, { method, headers: h, body: payload });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* не JSON */ }
    return { status: r.status, text, json };
  };
  const login = async (...keys: string[]) => {
    for (const k of keys) {
      const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: all[k].login, password: all[k].password }) });
      assert.equal(r.status, 200, `login ${k}`);
      jar[k] = /sid=([0-9a-f]+)/.exec(r.headers.get('set-cookie') ?? '')![1];
    }
  };
  const id = (k: string) => all[k].id;
  const one = (sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;
  const n1 = (sql: string, ...a: any[]) => Number(one(sql, ...a).c);
  const audits = (action: string) => n1('SELECT COUNT(*) c FROM audit_log WHERE action = ?', action);
  return { db, call, login, id, one, n1, audits };
}
type S = Awaited<ReturnType<typeof start>>;
const post = (s: S, as: string, who: string) => s.call(as, 'POST', '/api/erasure-requests', who === 'self' ? {} : { student_id: s.id(who) });
const rej = (s: S, as: string | null, id: number) => s.call(as, 'POST', `/api/erasure-requests/${id}/parent-reject`, {});
const status = (s: S, id: number) => s.one('SELECT status st FROM erasure_requests WHERE id = ?', id).st;

// ---------- отклонение родителем ----------
test('Ф29 родитель этого ребёнка отклоняет заявку 16–17-летнего: 200 rejected_by_parent, журнал, decided_by=родитель, владелец исполнить не может, ребёнок может подать заново', async () => {
  const s = await start();
  await s.login('Teen17', 'PY', 'Owner');
  const id = (await post(s, 'Teen17', 'self')).json.request.id;
  const r = await rej(s, 'PY', id);
  assert.equal(r.status, 200); assert.equal(r.json.request.status, 'rejected_by_parent');
  assert.deepEqual(Object.keys(r.json.request).sort(), ['created_at', 'decided_at', 'id', 'note', 'status', 'subject_id', 'via'], 'родителю — белый список полей');
  assert.notEqual(r.json.request.decided_at, null);
  assert.equal(s.one('SELECT decided_by d FROM erasure_requests WHERE id = ?', id).d, s.id('PY'));
  assert.equal(s.audits('erasure.parent_rejected'), 1);
  assert.equal(s.one('SELECT display_name d FROM users WHERE id = ?', s.id('Teen17')).d, 'FakeTeen17', 'данные ребёнка целы');
  assert.equal(s.n1('SELECT COUNT(*) c FROM erased_subjects'), 0);
  for (const decision of ['approve', 'reject']) {
    const o = await s.call('Owner', 'POST', `/api/owner/erasure-requests/${id}/decision`, { decision, identity_checked: true });
    assert.equal(o.status, 409, decision); assert.equal(o.json.error, 'request_not_pending');
  }
  assert.equal(status(s, id), 'rejected_by_parent'); assert.equal(s.n1('SELECT COUNT(*) c FROM erased_subjects'), 0);
  const mine = await s.call('Teen17', 'GET', '/api/erasure-requests');
  assert.equal(mine.json.requests[0].status, 'rejected_by_parent');
  assert.deepEqual((await s.call('Owner', 'GET', '/api/owner/erasure-requests?status=rejected_by_parent')).json.requests.map((x: any) => x.id), [id]);
  const again = await post(s, 'Teen17', 'self');
  assert.equal(again.status, 201); assert.equal(again.json.request.status, 'pending_parent');
});

test('Ф29 повтор отклонения: 409 request_not_pending, ничего не меняется (ни статус, ни время, ни журнал)', async () => {
  const s = await start();
  await s.login('Teen17', 'PY');
  const id = (await post(s, 'Teen17', 'self')).json.request.id;
  await rej(s, 'PY', id);
  const before = { ...s.one('SELECT status, decided_at, decided_by FROM erasure_requests WHERE id = ?', id) };
  const again = await rej(s, 'PY', id);
  assert.equal(again.status, 409); assert.equal(again.json.error, 'request_not_pending');
  assert.deepEqual({ ...s.one('SELECT status, decided_at, decided_by FROM erasure_requests WHERE id = ?', id) }, before);
  assert.equal(s.audits('erasure.parent_rejected'), 1);
  const c = await s.call('PY', 'POST', `/api/erasure-requests/${id}/parent-confirm`, {});
  assert.equal(c.status, 409); assert.equal(status(s, id), 'rejected_by_parent');
});

test('Ф29 нельзя отклонить уже подтверждённую родителем, переданную владельцу и исполненную заявку', async () => {
  const s = await start();
  await s.login('Teen17', 'PY', 'Owner', 'PX');
  const id = (await post(s, 'Teen17', 'self')).json.request.id;
  assert.equal((await s.call('PY', 'POST', `/api/erasure-requests/${id}/parent-confirm`, {})).status, 200);
  const late = await rej(s, 'PY', id);
  assert.equal(late.status, 409); assert.equal(late.json.error, 'request_not_pending'); assert.equal(status(s, id), 'pending_owner');
  const done = await s.call('Owner', 'POST', `/api/owner/erasure-requests/${id}/decision`, { decision: 'approve', identity_checked: true });
  assert.equal(done.status, 200); assert.equal(done.json.request.status, 'done');
  const after = await rej(s, 'PY', id);
  assert.equal(after.status, 404, 'после стирания связь родитель–ребёнок удалена → для родителя заявки «нет» (не 200)'); assert.equal(status(s, id), 'done');
  // если связь ещё есть (строка done, ребёнок не стёрт) — статусная проверка даёт 409
  const kid = s.id('Teen16');
  const did = Number(s.db.prepare(`INSERT INTO erasure_requests(subject_id, requested_by, via, status, identity_checked) VALUES (?,?,'parent','done',1)`).run(kid, s.id('PX')).lastInsertRowid);
  const doneLinked = await rej(s, 'PX', did);
  assert.equal(doneLinked.status, 409); assert.equal(doneLinked.json.error, 'request_not_pending'); assert.equal(status(s, did), 'done');
  s.db.prepare(`DELETE FROM erasure_requests WHERE id = ?`).run(did);
  // заявка самого родителя за ребёнка (pending_owner) — отклонять этим маршрутом нечего
  const pid = (await s.call('PX', 'POST', '/api/erasure-requests', { student_id: s.id('Teen16') })).json.request.id;
  assert.equal((await rej(s, 'PX', pid)).status, 409); assert.equal(status(s, pid), 'pending_owner');
  // слой базы: закрытую строку нельзя перезаписать даже прямым UPDATE
  assert.throws(() => s.db.prepare(`UPDATE erasure_requests SET status = 'pending_owner' WHERE id = ?`).run(id), /already closed/);
});

test('Ф29 чужой родитель, родитель взрослого, несуществующая заявка — один и тот же отказ 404 not_available, заявка не меняется, отказ в журнале', async () => {
  const s = await start();
  await s.login('Teen17', 'Teen18', 'PX', 'PZ', 'ParentA', 'ParentB');
  const id = (await post(s, 'Teen17', 'self')).json.request.id;          // ребёнок PY
  const id18 = (await post(s, 'Teen18', 'self')).json.request.id;        // 18+, pending_owner
  const answers = [await rej(s, 'PX', id), await rej(s, 'ParentA', id), await rej(s, 'ParentB', id), await rej(s, 'PX', 999999), await rej(s, 'PZ', id18)];
  for (const a of answers) { assert.equal(a.status, 404); assert.deepEqual(a.json, { error: 'not_available' }); }
  assert.equal(status(s, id), 'pending_parent'); assert.equal(status(s, id18), 'pending_owner');
  assert.equal(s.audits('erasure.parent_rejected'), 0);
  assert.equal(s.audits('erasure.request.refused'), 5, 'каждый отказ записан');
  // ребёнок, ставший взрослым при pending_parent: родитель права потерял (ядро, время сдвинуто на 2 года)
  assert.throws(() => parentReject(s.db, actorOf(s.db, s.id('PY')), id, Date.parse('2028-10-22T12:00:00Z')), (e: any) => e.name === 'NotAvailable');
  assert.equal(status(s, id), 'pending_parent');
});

test('Ф29 ученик, преподаватель, владелец, аноним: отклонить нельзя (403/403/403/401), в том числе свою; ядро отказывает отдельно от HTTP', async () => {
  const s = await start();
  await s.login('Teen17', 'Teen16', 'KidA', 'TeacherA', 'Owner', 'AdultD');
  const id = (await post(s, 'Teen17', 'self')).json.request.id;
  for (const who of ['Teen17', 'Teen16', 'KidA', 'AdultD', 'TeacherA', 'Owner']) {
    const r = await rej(s, who, id); assert.equal(r.status, 403, who);
  }
  assert.equal((await rej(s, null, id)).status, 401);
  assert.equal(status(s, id), 'pending_parent');
  for (const who of ['Teen17', 'TeacherA', 'Owner'])
    assert.throws(() => parentReject(s.db, actorOf(s.db, s.id(who)), id, NOW), (e: any) => e instanceof Denied, who);
  assert.equal(status(s, id), 'pending_parent');
});

test('Ф29 ошибки: request_not_pending при повторе — на всех 6 языках с переводом; схема версии 8, право только у родителя', async () => {
  const s = await start();
  await s.login('Teen17', 'PY');
  const id = (await post(s, 'Teen17', 'self')).json.request.id;
  await rej(s, 'PY', id);
  for (const l of LANGS) {
    const d = await s.call('PY', 'POST', `/api/erasure-requests/${id}/parent-reject?lang=${l}`, {});
    assert.equal(d.status, 409); assert.equal(d.json.error, 'request_not_pending');
    assert.equal(d.json.message_localized, t(l, 'error.request_not_pending')); assert.notEqual(d.json.message_localized, 'error.request_not_pending');
    assert.ok(Object.hasOwn(catalog(l), 'error.request_not_pending'), l);
  }
  assert.equal(Number((s.db.prepare('PRAGMA user_version').get() as any).user_version), 8);
  assert.deepEqual(s.db.prepare(`SELECT role FROM role_permissions WHERE permission = 'erasure.parent_reject'`).all().map(r => ({ ...r })), [{ role: 'parent' }]);
});

test('Ф29 лимит частоты действует на маршруте отклонения', async () => {
  const s = await start({ rateLimit: { user: [{ windowMs: 60_000, max: 2 }], ip: [{ windowMs: 60_000, max: 1000 }] } });
  await s.login('PY');
  for (let i = 0; i < 2; i++) assert.equal((await rej(s, 'PY', 999)).status, 404);
  const third = await rej(s, 'PY', 999);
  assert.equal(third.status, 429); assert.equal(third.json.error, 'rate_limited');
});

// ---------- изоляция ролей вокруг канала (регрессия: Ф29 ничего не открывает) ----------
test('Ф29 изоляция: преподаватель вне урока не видит учеников; в уроке — только учеников урока и без контактов; чужие контакты — только владельцу', async () => {
  const s = await start();
  await s.login('TeacherA', 'Teen16', 'Teen17', 'PX', 'PY', 'Owner');
  s.db.prepare(`UPDATE lessons SET status = 'cancelled'`).run();   // демо-уроки не мешают
  const none = await s.call('TeacherA', 'GET', '/api/students');
  assert.equal(none.status, 200); assert.deepEqual(none.json.students, []);
  assert.equal((await s.call('TeacherA', 'GET', '/api/me/contacts')).status, 403);
  for (const who of ['Teen16', 'Teen17', 'PX', 'PY', 'TeacherA'])
    assert.equal((await s.call(who, 'GET', `/api/contacts/${s.id('Teen16')}`)).status, 403, who);
  assert.equal((await s.call('Owner', 'GET', `/api/contacts/${s.id('Teen16')}`)).status, 200);
  // урок TeacherA «сейчас» с одним учеником Teen16
  const lid = Number(s.db.prepare(`INSERT INTO lessons(teacher_id, starts_at, audience, max_students) VALUES (?,?, 'minor', 6)`).run(s.id('TeacherA'), new Date(NOW + 5 * 60_000).toISOString()).lastInsertRowid);
  s.db.prepare('INSERT INTO lesson_enrollments(lesson_id, student_id) VALUES (?,?)').run(lid, s.id('Teen16'));
  await post(s, 'Teen17', 'self'); await post(s, 'Teen16', 'self');
  const inl = await s.call('TeacherA', 'GET', '/api/students');
  assert.deepEqual(inl.json.students.map((x: any) => x.id), [s.id('Teen16')]);
  assert.ok(!/example\.test|\+00 \d|email|phone|parent/i.test(inl.text), 'ни контактов, ни родителей');
  assert.equal((await s.call('TeacherA', 'GET', '/api/erasure-requests')).status, 403);
  assert.equal((await s.call('TeacherA', 'GET', '/api/owner/erasure-requests')).status, 403);
});

test('Ф29 изоляция: ученик не видит чужих (профили, заявки, экспорт); родитель видит только своего ребёнка — до и после отклонения', async () => {
  const s = await start();
  await s.login('Teen16', 'Teen17', 'PX', 'PY', 'PZ');
  const r16 = (await post(s, 'Teen16', 'self')).json.request.id;
  const r17 = (await post(s, 'Teen17', 'self')).json.request.id;
  await rej(s, 'PY', r17);
  const ids = async (w: string) => (await s.call(w, 'GET', '/api/students')).json.students.map((x: any) => x.id).sort((a: number, b: number) => a - b);
  assert.deepEqual(await ids('Teen16'), [s.id('Teen16')]);
  assert.deepEqual(await ids('Teen17'), [s.id('Teen17')]);
  assert.deepEqual(await ids('PX'), [s.id('Teen16'), s.id('Teen15')].sort((a, b) => a - b));
  assert.deepEqual(await ids('PY'), [s.id('Teen17')]);
  assert.deepEqual(await ids('PZ'), [], 'ребёнок стал взрослым — родитель его уже не видит');
  const rq = async (w: string) => (await s.call(w, 'GET', '/api/erasure-requests')).json.requests.map((x: any) => x.id);
  assert.deepEqual(await rq('Teen16'), [r16]); assert.deepEqual(await rq('Teen17'), [r17]);
  assert.deepEqual(await rq('PX'), [r16]); assert.deepEqual(await rq('PY'), [r17]); assert.deepEqual(await rq('PZ'), []);
  for (const [w, other] of [['Teen16', 'Teen17'], ['Teen17', 'Teen16'], ['PX', 'Teen17'], ['PY', 'Teen16']])
    assert.equal((await s.call(w, 'GET', `/api/export/${s.id(other)}`)).status, 403, `${w}→${other} экспорт`);
});

// ---------- миграция 008 ----------
test('Ф29 миграция 008: база версии 7 с заявками во всех статусах обновляется без потерь; новый статус принимается, закрытая строка защищена', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = new URL('../', import.meta.url);
  const dir = mkdtempSync(join(tmpdir(), 'f29-mig-'));
  try {
    const path = join(dir, 'v7.sqlite');
    const d = new DatabaseSync(path);
    d.exec('PRAGMA foreign_keys = ON');
    for (const f of ['db/schema.sql', 'db/migrations/002-room.sql', 'db/migrations/003-notifications.sql', 'db/migrations/004-outbox.sql', 'db/migrations/005-audit-retention.sql', 'db/migrations/006-erased-subjects.sql', 'db/migrations/007-erasure-requests.sql'])
      d.exec(readFileSync(new URL(f, root), 'utf8'));
    d.exec('PRAGMA user_version = 7');
    d.exec(`INSERT INTO users(role, display_name) VALUES ('student','S1'),('student','S2'),('student','S3'),('student','S4')`);
    d.exec(`INSERT INTO erasure_requests(subject_id, requested_by, via, status, identity_checked, note) VALUES (1,1,'self','pending_parent',0,NULL),(2,2,'self','pending_owner',0,NULL),(3,3,'self','rejected',0,'other'),(4,4,'self','done',1,NULL)`);
    d.close();
    const db = openDb(path);
    assert.equal(Number((db.prepare('PRAGMA user_version').get() as any).user_version), 8);
    assert.deepEqual(db.prepare('SELECT id, subject_id s, status st, note FROM erasure_requests ORDER BY id').all().map(r => ({ ...r })),
      [{ id: 1, s: 1, st: 'pending_parent', note: null }, { id: 2, s: 2, st: 'pending_owner', note: null }, { id: 3, s: 3, st: 'rejected', note: 'other' }, { id: 4, s: 4, st: 'done', note: null }]);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.prepare(`UPDATE erasure_requests SET status = 'rejected_by_parent' WHERE id = 1`).run();
    assert.throws(() => db.prepare(`UPDATE erasure_requests SET status = 'pending_owner' WHERE id = 1`).run(), /already closed/);
    assert.throws(() => db.prepare(`UPDATE erasure_requests SET status = 'pending_owner' WHERE id = 4`).run(), /already closed/);
    assert.throws(() => db.prepare(`UPDATE erasure_requests SET status = 'bogus' WHERE id = 2`).run(), /CHECK/);
    assert.throws(() => db.prepare(`INSERT INTO erasure_requests(subject_id, requested_by, via, status) VALUES (2,2,'self','pending_owner')`).run(), /UNIQUE/, 'индекс «одна открытая» цел');
    assert.throws(() => db.prepare(`UPDATE erasure_requests SET status = 'done' WHERE id = 2`).run(), /identity_checked/, 'триггер identity цел');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
