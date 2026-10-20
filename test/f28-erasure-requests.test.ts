// Ф28: канал приёма просьб об удалении данных. Реальные HTTP-запросы, выдуманные данные (seedDemo + свои подростки).
// Время зафиксировано: 2026-10-20 12:00 UTC (пороги возраста считаются от него, не от «сегодня» — тест не «плывёт»).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import { seedDemo, type Demo } from '../src/seed.ts';
import { register } from '../src/auth.ts';
import { createApp, listen, COOKIE, type ServerOptions } from '../src/server.ts';
import { actorOf, Denied } from '../src/access.ts';
import { submitRequest, listMine, parentConfirm, listAll, decide } from '../src/erasure.ts';
import { processOutbox, MemorySink } from '../src/notify.ts';
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
    const u = { id, login: key.toLowerCase(), password: `f28-demo-password-${n}`, email };
    register(db, id, u.login, u.password);
    if (parent) db.prepare('INSERT INTO parent_child(parent_id, child_id) VALUES (?,?)').run(extra[parent].id, id);
    return extra[key] = u;
  };
  mk('PX', 'parent', '1980-01-01'); mk('PY', 'parent', '1981-01-01'); mk('PZ', 'parent', '1982-01-01');
  mk('Teen16', 'student', B.age16, 'PX');          // ровно 16 — своя просьба принимается
  mk('Teen15', 'student', B.age15y364d, 'PX');     // 15 лет 364 дня — сам подать не может
  mk('Teen17', 'student', B.age17, 'PY');          // 17 — нужен родитель
  mk('Teen18', 'student', B.age18, 'PZ');          // ровно 18 — взрослый (связь с родителем осталась, но права родителя кончились)
  mk('Orphan17', 'student', B.age17);              // 17, родителя на платформе нет
  const server = createApp(db, { now: () => NOW, rateLimit: false, ...opts });
  servers.push(server);
  const base = `http://127.0.0.1:${await listen(server, 0)}`;
  const all = { ...demo.users, ...extra } as Record<string, { id: number; login: string; password: string; email: string }>;
  const jar: Record<string, string> = {};
  const call = async (as: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { ...headers };
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
  return { db, call, login, id, one, n1, audits, all };
}
type S = Awaited<ReturnType<typeof start>>;
const post = (s: S, as: string, who: string) => s.call(as, 'POST', '/api/erasure-requests', who === 'self' ? {} : { student_id: s.id(who) });

// ---------- пороги 16 и 18 ----------
test('Ф28 порог 16: ученик младше 16 (в т.ч. 15 лет 364 дня) подать не может → 404 not_available, заявки нет; ровно 16 — принимается', async () => {
  const s = await start();
  await s.login('KidA', 'TeenC', 'Teen15', 'Teen16');
  for (const who of ['KidA', 'TeenC', 'Teen15']) {
    const r = await s.call(who, 'POST', '/api/erasure-requests', {});
    assert.equal(r.status, 404, who); assert.deepEqual(r.json, { error: 'not_available' }, who);
  }
  assert.equal(s.n1('SELECT COUNT(*) c FROM erasure_requests'), 0);
  assert.equal(s.audits('erasure.request.refused'), 3, 'отказы в журнале');
  const ok = await s.call('Teen16', 'POST', '/api/erasure-requests', {});
  assert.equal(ok.status, 201);
  assert.equal(ok.json.request.status, 'pending_parent'); assert.equal(ok.json.request.via, 'self');
});

test('Ф28 порог 18: 17 лет → pending_parent (+уведомление родителю), ровно 18 → pending_owner без родителя; 17 лет без родителя на платформе → not_available', async () => {
  const s = await start();
  await s.login('Teen17', 'Teen18', 'Orphan17');
  const a = await s.call('Teen17', 'POST', '/api/erasure-requests', {});
  assert.equal(a.status, 201); assert.equal(a.json.request.status, 'pending_parent'); assert.equal(a.json.request.via, 'self');
  assert.equal(s.n1(`SELECT COUNT(*) c FROM parent_notifications WHERE kind = 'erasure_request' AND parent_id = ? AND child_id = ?`, s.id('PY'), s.id('Teen17')), 1);
  const b = await s.call('Teen18', 'POST', '/api/erasure-requests', {});
  assert.equal(b.status, 201); assert.equal(b.json.request.status, 'pending_owner'); assert.equal(b.json.request.via, 'self');
  assert.equal(s.n1(`SELECT COUNT(*) c FROM parent_notifications WHERE child_id = ?`, s.id('Teen18')), 0, 'взрослому родитель не уведомляется');
  const c = await s.call('Orphan17', 'POST', '/api/erasure-requests', {});
  assert.equal(c.status, 404); assert.deepEqual(c.json, { error: 'not_available' });
});

test('Ф28 родитель: за своего ребёнка до 18 → pending_owner (via=parent); за 18-летнего, чужого, несуществующего или без student_id — один и тот же отказ not_available', async () => {
  const s = await start();
  await s.login('PX', 'PZ');
  const ok = await s.call('PX', 'POST', '/api/erasure-requests', { student_id: s.id('Teen16') });
  assert.equal(ok.status, 201); assert.equal(ok.json.request.status, 'pending_owner'); assert.equal(ok.json.request.via, 'parent');
  const refusals = [
    await s.call('PZ', 'POST', '/api/erasure-requests', { student_id: s.id('Teen18') }),   // ребёнок стал взрослым
    await s.call('PX', 'POST', '/api/erasure-requests', { student_id: s.id('Teen17') }),   // чужой ребёнок
    await s.call('PX', 'POST', '/api/erasure-requests', { student_id: 999999 }),           // несуществующий
    await s.call('PX', 'POST', '/api/erasure-requests', {}),                               // без student_id
    await s.call('PX', 'POST', '/api/erasure-requests', { student_id: s.id('PX') }),       // сам родитель этим каналом — нет
  ];
  for (const r of refusals) { assert.equal(r.status, 404); assert.deepEqual(r.json, { error: 'not_available' }); }
  assert.equal((await s.call('PX', 'POST', '/api/erasure-requests', { student_id: 'abc' })).status, 400);
  assert.equal(s.n1('SELECT COUNT(*) c FROM erasure_requests'), 1);
});

// ---------- роли и изоляция ----------
test('Ф28 преподаватель: 403 на ВСЕ новые маршруты (HTTP и ядро), контактов и данных заявок не получает; владелец подать не может', async () => {
  const s = await start();
  await s.login('TeacherA', 'Owner', 'Teen17', 'PY');
  const mine = await s.call('Teen17', 'POST', '/api/erasure-requests', {});
  const rid = mine.json.request.id;
  const routes: [string, string, unknown][] = [
    ['POST', '/api/erasure-requests', {}], ['POST', '/api/erasure-requests', { student_id: s.id('KidA') }], ['GET', '/api/erasure-requests', undefined],
    ['POST', `/api/erasure-requests/${rid}/parent-confirm`, {}],
    ['GET', '/api/owner/erasure-requests', undefined], ['GET', '/api/owner/erasure-requests?status=pending_parent', undefined],
    ['POST', `/api/owner/erasure-requests/${rid}/decision`, { decision: 'approve', identity_checked: true }],
  ];
  for (const [m, p, b] of routes) {
    const r = await s.call('TeacherA', m, p, b);
    assert.equal(r.status, 403, `${m} ${p}`); assert.deepEqual(r.json, { error: 'forbidden' });
    assert.ok(!/example\.test|\+00 \d|Fake|Teen/.test(r.text), 'в отказе нет контактов и данных');
  }
  assert.equal((await s.call('Owner', 'POST', '/api/erasure-requests', { student_id: s.id('Teen17') })).status, 403);
  assert.equal((await s.call('Owner', 'GET', '/api/erasure-requests')).status, 403);
  assert.equal((await s.call('Owner', 'POST', `/api/erasure-requests/${rid}/parent-confirm`, {})).status, 403);
  for (const who of ['Teen17', 'PY']) assert.equal((await s.call(who, 'GET', '/api/owner/erasure-requests')).status, 403);
  assert.equal((await s.call('PY', 'POST', `/api/owner/erasure-requests/${rid}/decision`, { decision: 'approve', identity_checked: true })).status, 403);
  assert.equal((await s.call('Teen17', 'POST', `/api/erasure-requests/${rid}/parent-confirm`, {})).status, 403, 'ученик сам себя за родителя подтвердить не может');
  assert.equal(s.one('SELECT status FROM erasure_requests WHERE id = ?', rid).status, 'pending_parent', 'ничего не изменилось');
  // второй слой — ядро, напрямую без HTTP: преподаватель отвергается правом, а не только списком ролей
  const teacher = actorOf(s.db, s.id('TeacherA'));
  assert.throws(() => submitRequest(s.db, teacher, s.id('KidA'), NOW), Denied);
  assert.throws(() => listMine(s.db, teacher, NOW), Denied);
  assert.throws(() => parentConfirm(s.db, teacher, rid, NOW), Denied);
  assert.throws(() => listAll(s.db, teacher), Denied);
  assert.throws(() => decide(s.db, teacher, rid, 'approve', true, null, NOW), Denied);
  assert.throws(() => decide(s.db, actorOf(s.db, s.id('PY')), rid, 'reject', false, null, NOW), Denied);
});

test('Ф28 изоляция: ученик видит только свои заявки, родитель — только заявки своего ребёнка; чужую подтвердить нельзя; в ответах нет контактов и имён', async () => {
  const s = await start();
  await s.login('Teen16', 'Teen17', 'Teen18', 'PX', 'PY', 'PZ', 'Owner');
  const r16 = (await post(s, 'Teen16', 'self')).json.request.id;
  const r17 = (await post(s, 'Teen17', 'self')).json.request.id;
  const r18 = (await post(s, 'Teen18', 'self')).json.request.id;
  const ids = (r: any) => r.json.requests.map((x: any) => x.id).sort();
  const list: Record<string, any> = {};
  for (const w of ['Teen16', 'Teen17', 'Teen18', 'PX', 'PY', 'PZ']) list[w] = await s.call(w, 'GET', '/api/erasure-requests');
  assert.deepEqual(ids(list.Teen16), [r16]); assert.deepEqual(ids(list.Teen17), [r17]); assert.deepEqual(ids(list.Teen18), [r18]);
  assert.deepEqual(ids(list.PX), [r16]); assert.deepEqual(ids(list.PY), [r17]);
  assert.deepEqual(ids(list.PZ), [], 'родитель 18-летнего заявку взрослого не видит');
  for (const w of Object.keys(list)) {
    const txt = list[w].text;
    assert.ok(!/example\.test|\+00 \d|Fake|identity_checked|decided_by|requested_by/.test(txt), `${w}: нет контактов/имён/служебных полей владельца`);
    for (const x of list[w].json.requests) assert.deepEqual(Object.keys(x).sort(), ['created_at', 'decided_at', 'id', 'note', 'status', 'subject_id', 'via']);
  }
  // чужую заявку не подтвердить и не отличить от несуществующей
  const alien = await s.call('PX', 'POST', `/api/erasure-requests/${r17}/parent-confirm`, {});
  const none = await s.call('PX', 'POST', '/api/erasure-requests/999999/parent-confirm', {});
  assert.equal(alien.status, 404); assert.deepEqual(alien.json, { error: 'not_available' }); assert.deepEqual(none.json, alien.json);
  assert.equal(s.one('SELECT status FROM erasure_requests WHERE id = ?', r17).status, 'pending_parent');
  // родитель 18-летнего: заявка не его ребёнка по закону — подтверждать нечего
  assert.equal((await s.call('PZ', 'POST', `/api/erasure-requests/${r18}/parent-confirm`, {})).status, 404);
  // владелец видит все, с фильтром по статусу; контактов в списке нет
  const all = await s.call('Owner', 'GET', '/api/owner/erasure-requests');
  assert.equal(all.status, 200); assert.deepEqual(ids(all), [r16, r17, r18].sort());
  assert.ok(!/example\.test|\+00 \d|Fake/.test(all.text));
  assert.deepEqual(ids(await s.call('Owner', 'GET', '/api/owner/erasure-requests?status=pending_owner')), [r18]);
  assert.equal((await s.call('Owner', 'GET', '/api/owner/erasure-requests?status=bogus')).status, 400);
  assert.deepEqual(Object.keys(all.json.requests[0]).sort(), ['created_at', 'decided_at', 'decided_by', 'id', 'identity_checked', 'note', 'requested_by', 'status', 'subject_id', 'via']);
});

// ---------- подтверждение родителя ----------
test('Ф28 pending_parent не пропускается: владелец не исполняет заявку 16–17-летнего без родителя (даже с identity_checked); после подтверждения родителя — pending_owner; повторное подтверждение — отказ', async () => {
  const s = await start();
  await s.login('Teen17', 'PY', 'Owner');
  const rid = (await post(s, 'Teen17', 'self')).json.request.id;
  const early = await s.call('Owner', 'POST', `/api/owner/erasure-requests/${rid}/decision`, { decision: 'approve', identity_checked: true });
  assert.equal(early.status, 409); assert.equal(early.json.error, 'parent_confirmation_required');
  assert.equal(s.one('SELECT display_name d FROM users WHERE id = ?', s.id('Teen17')).d, 'FakeTeen17', 'данные целы');
  assert.equal(s.n1('SELECT COUNT(*) c FROM erased_subjects'), 0);
  const c = await s.call('PY', 'POST', `/api/erasure-requests/${rid}/parent-confirm`, {});
  assert.equal(c.status, 200); assert.equal(c.json.request.status, 'pending_owner');
  assert.equal(s.audits('erasure.parent_confirmed'), 1);
  const again = await s.call('PY', 'POST', `/api/erasure-requests/${rid}/parent-confirm`, {});
  assert.equal(again.status, 409); assert.equal(again.json.error, 'request_not_pending');
});

// ---------- проверка личности ----------
test('Ф28 identity_checked обязателен: без флага (нет, false, 0) исполнение отказывает 422, данные целы; с флагом — исполняется; база не принимает «done» без флага', async () => {
  const s = await start();
  await s.login('Teen18', 'Owner');
  const rid = (await post(s, 'Teen18', 'self')).json.request.id;
  const url = `/api/owner/erasure-requests/${rid}/decision`;
  for (const body of [{ decision: 'approve' }, { decision: 'approve', identity_checked: false }, { decision: 'approve', identity_checked: 0 }]) {
    const r = await s.call('Owner', 'POST', url, body);
    assert.equal(r.status, 422, JSON.stringify(body)); assert.equal(r.json.error, 'identity_not_checked');
  }
  assert.equal((await s.call('Owner', 'POST', url, { decision: 'approve', identity_checked: 'yes' })).status, 400);
  assert.equal(s.one('SELECT status s FROM erasure_requests WHERE id = ?', rid).s, 'pending_owner');
  assert.equal(s.one('SELECT display_name d FROM users WHERE id = ?', s.id('Teen18')).d, 'FakeTeen18');
  assert.equal(s.n1('SELECT COUNT(*) c FROM contact_vault WHERE user_id = ?', s.id('Teen18')), 1);
  assert.equal(s.audits('erasure.execute.refused'), 3);
  // третья линия: прямой UPDATE мимо кода тоже не пройдёт
  assert.throws(() => s.db.prepare(`UPDATE erasure_requests SET status = 'done' WHERE id = ?`).run(rid), /identity_checked/);
  const ok = await s.call('Owner', 'POST', url, { decision: 'approve', identity_checked: true });
  assert.equal(ok.status, 200); assert.equal(ok.json.request.status, 'done'); assert.equal(ok.json.request.identity_checked, 1);
});

// ---------- повторная заявка ----------
test('Ф28 повторная заявка: пока открыта — 409 request_exists (и от ученика, и от родителя); после отказа можно подать снова; после исполнения — not_available', async () => {
  const s = await start();
  await s.login('Teen16', 'PX', 'Owner');
  const first = (await post(s, 'Teen16', 'self')).json.request.id;
  const dup = await post(s, 'Teen16', 'self');
  assert.equal(dup.status, 409); assert.equal(dup.json.error, 'request_exists');
  const dupParent = await post(s, 'PX', 'Teen16');
  assert.equal(dupParent.status, 409); assert.equal(dupParent.json.error, 'request_exists');
  assert.equal(s.n1('SELECT COUNT(*) c FROM erasure_requests'), 1);
  assert.equal(s.audits('erasure.request.duplicate'), 2);
  // база тоже не даст второй открытой (частичный уникальный индекс)
  assert.throws(() => s.db.prepare(`INSERT INTO erasure_requests(subject_id, requested_by, via, status) VALUES (?,?,'self','pending_owner')`).run(s.id('Teen16'), s.id('Teen16')), /UNIQUE/);
  const rej = await s.call('Owner', 'POST', `/api/owner/erasure-requests/${first}/decision`, { decision: 'reject', identity_checked: false, note: 'identity_failed' });
  assert.equal(rej.status, 200); assert.equal(rej.json.request.status, 'rejected'); assert.equal(rej.json.request.note, 'identity_failed');
  const second = await post(s, 'PX', 'Teen16');
  assert.equal(second.status, 201); assert.notEqual(second.json.request.id, first);
  // закрытую заявку решить повторно нельзя
  const closed = await s.call('Owner', 'POST', `/api/owner/erasure-requests/${first}/decision`, { decision: 'approve', identity_checked: true });
  assert.equal(closed.status, 409); assert.equal(closed.json.error, 'request_not_pending');
  const done = await s.call('Owner', 'POST', `/api/owner/erasure-requests/${second.json.request.id}/decision`, { decision: 'approve', identity_checked: true });
  assert.equal(done.status, 200);
  assert.equal((await post(s, 'PX', 'Teen16')).status, 404, 'человек уже обезличен');
});

// ---------- исполнение ----------
test('Ф28 исполнение: полный путь 17 лет → родитель → владелец; данные стёрты, надгробие есть, заявка done, уведомление родителю — в outbox/сток без данных ребёнка, журнал пишется', async () => {
  const s = await start();
  await s.login('Teen17', 'PY', 'Owner', 'KidB');
  const kid = s.id('Teen17');
  s.db.prepare('INSERT INTO lesson_enrollments(lesson_id, student_id) VALUES (?,?)').run(s.one('SELECT id FROM lessons LIMIT 1').id, kid);
  const rid = (await post(s, 'Teen17', 'self')).json.request.id;

  // уведомление родителю — только через очередь; сток, не почта; текста и имени ребёнка нет
  const sink = new MemorySink();
  assert.deepEqual(await processOutbox(s.db, sink, NOW), { sent: 1, failed: 0, dead: 0 });
  assert.equal(sink.sent.length, 1);
  assert.equal(sink.sent[0].kind, 'erasure_request'); assert.equal(sink.sent[0].to_user_id, s.id('PY'));
  assert.equal(sink.sent[0].body, t('uk', 'notify.erasure_request'));
  assert.ok(!/Fake|example\.test/.test(JSON.stringify(sink.sent[0])));

  assert.equal((await s.call('PY', 'POST', `/api/erasure-requests/${rid}/parent-confirm`, {})).status, 200);
  const done = await s.call('Owner', 'POST', `/api/owner/erasure-requests/${rid}/decision`, { decision: 'approve', identity_checked: true });
  assert.equal(done.status, 200);
  assert.equal(done.json.request.status, 'done'); assert.equal(done.json.request.decided_by, s.id('Owner')); assert.ok(done.json.request.decided_at);

  const u = s.one('SELECT display_name d, birth_date b, anonymized_at a FROM users WHERE id = ?', kid);
  assert.equal(u.d, 'Deleted user'); assert.equal(u.b, null); assert.ok(u.a);
  assert.equal(s.n1('SELECT COUNT(*) c FROM contact_vault WHERE user_id = ?', kid), 0);
  assert.equal(s.n1('SELECT COUNT(*) c FROM credentials WHERE user_id = ?', kid), 0);
  assert.equal(s.n1('SELECT COUNT(*) c FROM parent_child WHERE child_id = ?', kid), 0);
  assert.equal(s.n1(`SELECT COUNT(*) c FROM lesson_enrollments WHERE student_id = ? AND status = 'active'`, kid), 0);
  assert.equal(s.n1('SELECT COUNT(*) c FROM erased_subjects WHERE user_id = ?', kid), 1, 'надгробие');
  assert.equal((await s.call('Teen17', 'GET', '/api/me')).status, 401, 'сессия ученика мертва');
  // чужие данные целы
  assert.equal(s.one('SELECT display_name d FROM users WHERE id = ?', s.id('KidB')).d, 'Kira');
  assert.equal(s.n1('SELECT COUNT(*) c FROM contact_vault WHERE user_id = ?', s.id('PY')), 1);
  // заявка в таблице: только id, статусы и время — ни имён, ни контактов
  assert.equal(JSON.stringify(s.one('SELECT * FROM erasure_requests WHERE id = ?', rid)).match(/Fake|example|\+00/), null);
  // журнал: каждый шаг
  for (const a of ['erasure.requested', 'erasure.parent_confirmed', 'erasure.executed', 'data.erased']) assert.ok(s.audits(a) >= 1, `в журнале нет ${a}`);
  assert.equal(s.n1(`SELECT COUNT(*) c FROM audit_log WHERE action = 'erasure.executed' AND actor_id = ? AND target_id = ? AND outcome = 'allowed'`, s.id('Owner'), rid), 1);
  // заявка осталась в таблице как «done»: восстановление из копии опирается на надгробие (Ф26), заявка — только след процесса
  assert.equal(s.one('SELECT status s FROM erasure_requests WHERE id = ?', rid).s, 'done');
});

test('Ф28 атомарность: если стирание упало, заявка остаётся открытой и данные целы (ничего не «наполовину»)', async () => {
  const s = await start({ eraser: () => { throw new Error('boom'); } });
  await s.login('Teen18', 'Owner');
  const rid = (await post(s, 'Teen18', 'self')).json.request.id;
  const r = await s.call('Owner', 'POST', `/api/owner/erasure-requests/${rid}/decision`, { decision: 'approve', identity_checked: true });
  assert.equal(r.status, 500);
  assert.equal(s.one('SELECT status s FROM erasure_requests WHERE id = ?', rid).s, 'pending_owner');
  assert.equal(s.one('SELECT display_name d FROM users WHERE id = ?', s.id('Teen18')).d, 'FakeTeen18');
  assert.equal(s.audits('erasure.executed'), 0);
});

// ---------- журнал отказа, примечание без персональных данных ----------
test('Ф28 журнал и note: отказ владельца пишется в журнал; note — только код из закрытого списка (свободный текст/персональные данные отклоняются 400 и не сохраняются)', async () => {
  const s = await start();
  await s.login('Teen18', 'Owner');
  const rid = (await post(s, 'Teen18', 'self')).json.request.id;
  assert.equal(s.audits('erasure.requested'), 1);
  const url = `/api/owner/erasure-requests/${rid}/decision`;
  for (const bad of ['Jan Kowalski, +48 123 456 789', 'free text', 123, '']) {
    const r = await s.call('Owner', 'POST', url, { decision: 'reject', note: bad });
    assert.equal(r.status, 400, String(bad)); assert.deepEqual(r.json, { error: 'bad_request', field: 'note' });
  }
  assert.equal(s.one('SELECT note n FROM erasure_requests WHERE id = ?', rid).n, null);
  assert.equal((await s.call('Owner', 'POST', url, { decision: 'maybe' })).status, 400);
  assert.equal((await s.call('Owner', 'POST', '/api/owner/erasure-requests/999999/decision', { decision: 'reject' })).status, 404);
  assert.throws(() => s.db.prepare(`UPDATE erasure_requests SET note = 'Jan K.' WHERE id = ?`).run(rid), /CHECK/);
  const r = await s.call('Owner', 'POST', url, { decision: 'reject', identity_checked: true, note: 'not_entitled' });
  assert.equal(r.status, 200); assert.equal(r.json.request.status, 'rejected');
  assert.equal(s.n1(`SELECT COUNT(*) c FROM audit_log WHERE action = 'erasure.rejected' AND actor_id = ? AND target_id = ?`, s.id('Owner'), rid), 1);
  assert.equal(s.one('SELECT display_name d FROM users WHERE id = ?', s.id('Teen18')).d, 'FakeTeen18', 'после отказа данные целы');
  assert.equal(s.audits('erasure.executed'), 0);
});

// ---------- единый формат ошибок, 6 языков, лимит частоты, неавторизованный ----------
test('Ф28 ошибки: коды error.* для новых отказов есть во всех 6 языках и приходят как message_localized; аноним — 401', async () => {
  const s = await start();
  await s.login('Teen16', 'Owner');
  await post(s, 'Teen16', 'self');
  for (const l of LANGS) {
    const d = await s.call('Teen16', 'POST', `/api/erasure-requests?lang=${l}`, {});
    assert.equal(d.json.error, 'request_exists'); assert.equal(d.json.message_localized, t(l, 'error.request_exists')); assert.equal(d.json.lang, l);
    assert.notEqual(d.json.message_localized, 'error.request_exists', `${l}: перевод есть, а не сам ключ`);
  }
  assert.equal((await s.call(null, 'GET', '/api/erasure-requests')).status, 401);
  assert.equal((await s.call(null, 'POST', '/api/erasure-requests', {})).status, 401);
  assert.equal((await s.call(null, 'POST', '/api/owner/erasure-requests/1/decision', { decision: 'reject' })).status, 401);
  for (const code of ['request_exists', 'request_not_pending', 'parent_confirmation_required', 'identity_not_checked', 'not_available'])
    for (const l of LANGS) assert.ok(Object.hasOwn(catalog(l), `error.${code}`), `${l}: error.${code}`);
  for (const l of LANGS) assert.ok(Object.hasOwn(catalog(l), 'notify.erasure_request'), `${l}: notify.erasure_request`);
});

test('Ф28 лимит частоты действует на изменяющих маршрутах канала: превышение → 429 rate_limited; чтение не считается', async () => {
  const s = await start({ rateLimit: { user: [{ windowMs: 60_000, max: 2 }], ip: [{ windowMs: 60_000, max: 1000 }] } });
  await s.login('Teen18', 'Owner');
  for (let i = 0; i < 2; i++) { const r = await s.call('Teen18', 'POST', '/api/erasure-requests', {}); assert.ok([201, 409].includes(r.status)); }
  const third = await s.call('Teen18', 'POST', '/api/erasure-requests', {});
  assert.equal(third.status, 429); assert.equal(third.json.error, 'rate_limited');
  for (let i = 0; i < 5; i++) assert.equal((await s.call('Teen18', 'GET', '/api/erasure-requests')).status, 200);
  for (let i = 0; i < 2; i++) await s.call('Owner', 'POST', '/api/owner/erasure-requests/999999/decision', { decision: 'reject' });
  assert.equal((await s.call('Owner', 'POST', '/api/owner/erasure-requests/999999/decision', { decision: 'reject' })).status, 429);
});

// ---------- миграция 007 ----------
test('Ф28 миграция 007: база версии 6 с уже лежащей очередью уведомлений обновляется без потерь (строки outbox живы), новый вид уведомления принимается', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = new URL('../', import.meta.url);
  const dir = mkdtempSync(join(tmpdir(), 'f28-mig-'));
  try {
    const path = join(dir, 'v6.sqlite');
    const d = new DatabaseSync(path);
    d.exec('PRAGMA foreign_keys = ON');
    for (const f of ['db/schema.sql', 'db/migrations/002-room.sql', 'db/migrations/003-notifications.sql', 'db/migrations/004-outbox.sql', 'db/migrations/005-audit-retention.sql', 'db/migrations/006-erased-subjects.sql'])
      d.exec(readFileSync(new URL(f, root), 'utf8'));
    d.exec('PRAGMA user_version = 6');
    d.exec(`INSERT INTO users(role, display_name) VALUES ('parent','P'),('student','S')`);
    d.exec(`INSERT INTO parent_notifications(parent_id, child_id, kind, ref_id) VALUES (1,2,'thread_message',5),(1,2,'room_message',6)`);
    d.exec(`INSERT INTO notification_outbox(notification_id, status, attempts) VALUES (1,'sent',1),(2,'pending',0)`);
    d.close();
    const db = openDb(path);
    assert.equal(Number((db.prepare('PRAGMA user_version').get() as any).user_version), 7);
    assert.deepEqual(db.prepare('SELECT notification_id n, status s, attempts a FROM notification_outbox ORDER BY id').all().map(r => ({ ...r })), [{ n: 1, s: 'sent', a: 1 }, { n: 2, s: 'pending', a: 0 }]);
    assert.deepEqual(db.prepare('SELECT kind, ref_id FROM parent_notifications ORDER BY id').all().map(r => ({ ...r })), [{ kind: 'thread_message', ref_id: 5 }, { kind: 'room_message', ref_id: 6 }]);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.prepare(`INSERT INTO parent_notifications(parent_id, child_id, kind, ref_id) VALUES (1,2,'erasure_request',9)`).run();
    assert.throws(() => db.prepare(`INSERT INTO parent_notifications(parent_id, child_id, kind, ref_id) VALUES (1,2,'bogus',9)`).run(), /CHECK/);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
