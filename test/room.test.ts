// Ф9: комната урока. Реальные HTTP-запросы, подставляемые часы, выдуманные данные.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import { seedDemo } from '../src/seed.ts';
import { createApp, listen, COOKIE } from '../src/server.ts';
import { assignSubstitute, grantConsent, actorOf } from '../src/access.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });
const MIN = 60_000;

/** Урок a1: преподаватель A, дети KidA (родитель A) и KidB (родитель B), старт через 60 минут от T0, 50 минут. */
async function start() {
  const T0 = Date.now();
  const clock = { now: T0 };
  const db = openDb(':memory:');
  const demo = seedDemo(db, T0);
  const server = createApp(db, { now: () => clock.now });
  servers.push(server);
  const port = await listen(server, 0);
  const base = `http://127.0.0.1:${port}`;
  const jar: Record<string, string> = {};
  const call = async (as: string | null, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (as && jar[as]) headers.cookie = `${COOKIE}=${jar[as]}`;
    let payload: string | undefined;
    if (method !== 'GET') { headers['content-type'] = 'application/json'; payload = JSON.stringify(body ?? {}); }
    const r = await fetch(base + path, { method, headers, body: payload });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, text, json };
  };
  for (const k of Object.keys(demo.users)) {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: demo.users[k].login, password: demo.users[k].password }) });
    assert.equal(r.status, 200);
    jar[k] = /sid=([0-9a-f]+)/.exec(r.headers.get('set-cookie') ?? '')![1];
  }
  const startAt = (id: number, offsetMin: number, dur = 50) =>
    db.prepare('UPDATE lessons SET starts_at = ?, duration_min = ?, status = \'planned\' WHERE id = ?').run(new Date(T0 + offsetMin * MIN).toISOString(), dur, id);
  const L = demo.lessons;
  startAt(L.a1, 60); startAt(L.a2, 600); startAt(L.b1, 60); startAt(L.b2, 60);
  const at = (offsetMin: number) => { clock.now = T0 + offsetMin * MIN; };
  const U = (k: string) => demo.users[k];
  return { db, demo, call, at, T0, clock, startAt, L, U, room: (id: number) => `/api/rooms/${id}` };
}
type S = Awaited<ReturnType<typeof start>>;

/** Преподаватель A входит первым (в окне урока), чтобы дети могли зайти. */
async function openRoom(s: S) { s.at(55); assert.equal((await s.call('TeacherA', 'POST', s.room(s.L.a1) + '/enter')).status, 200); }

// ---------- (а) пропуск ----------
test('(а) допущены: записанные ученики, их родители (наблюдатель), назначенный преподаватель, владелец; остальные — одинаковый 403', async () => {
  const s = await start();
  s.at(55);
  const room = s.room(s.L.a1);
  const missing = await s.call('KidA', 'GET', s.room(999999));
  assert.equal(missing.status, 403);
  // чужие: преподаватель другого урока, не записанные ученики, чужой родитель, родитель взрослого ученика
  s.db.prepare('INSERT INTO parent_child(parent_id, child_id) VALUES (?,?)').run(s.U('ParentA').id, s.U('AdultD').id);   // AdultD — взрослый
  for (const who of ['TeacherB', 'TeenC', 'AdultD', 'ParentC']) {
    for (const [m, p] of [['GET', room], ['POST', room + '/enter'], ['GET', room + '/video'], ['POST', room + '/call-owner']] as const) {
      const r = await s.call(who, m, p);
      assert.equal(r.status, 403, `${who} ${m} ${p}`);
      assert.equal(r.text, missing.text, 'ответ не отличается от «урока нет»');
    }
  }
  assert.equal((await s.call('TeenC', 'POST', room + '/chat', { body: 'hi' })).status, 403);
  // родитель взрослого ученика на уроке взрослого: не наблюдатель
  assert.equal((await s.call('ParentA', 'GET', s.room(s.L.b2))).status, 403);
  // допущенные
  assert.equal((await s.call('TeacherA', 'GET', room)).json.me.mode, 'teacher');
  assert.equal((await s.call('KidA', 'GET', room)).json.me.mode, 'participant');
  assert.equal((await s.call('KidB', 'GET', room)).json.me.mode, 'participant');
  assert.equal((await s.call('ParentA', 'GET', room)).json.me.mode, 'observer');
  assert.equal((await s.call('ParentB', 'GET', room)).json.me.mode, 'observer');
  assert.equal((await s.call('Owner', 'GET', room)).json.me.mode, 'owner');
  // отменённая запись — доступ пропал сразу
  s.db.prepare(`UPDATE lesson_enrollments SET status = 'cancelled' WHERE lesson_id = ? AND student_id = ?`).run(s.L.a1, s.U('KidB').id);
  assert.equal((await s.call('KidB', 'GET', room)).status, 403);
  assert.equal((await s.call('ParentB', 'GET', room)).status, 403);
});

test('(а) замещающий преподаватель допущен, после снятия замены — нет; роль не со слов клиента', async () => {
  const s = await start();
  s.at(55);
  const room = s.room(s.L.a1);
  assert.equal((await s.call('TeacherB', 'GET', room)).status, 403);
  assignSubstitute(s.db, actorOf(s.db, s.U('Owner').id), s.L.a1, s.U('TeacherB').id, s.T0);
  assert.equal((await s.call('TeacherB', 'GET', room)).json.me.mode, 'teacher');
  s.db.prepare('UPDATE lessons SET substitute_id = NULL WHERE id = ?').run(s.L.a1);
  assert.equal((await s.call('TeacherB', 'GET', room)).status, 403);
});

// ---------- (б) время ----------
test('(б) пропуск с T-10 минут до конца; раньше/позже/отменённый урок — room_closed; чужим даже тут 403', async () => {
  const s = await start();
  const room = s.room(s.L.a1);
  for (const who of ['TeacherA', 'ParentA', 'Owner']) {
    s.at(60 - 10 - 1 / 60);   // на секунду раньше
    assert.equal((await s.call(who, 'GET', room)).status, 409, who);
    assert.equal((await s.call(who, 'GET', room)).json.error, 'room_closed');
  }
  s.at(50);      assert.equal((await s.call('TeacherA', 'GET', room)).status, 200, 'ровно за 10 минут');
  s.at(60 + 50 - 1 / 60); assert.equal((await s.call('TeacherA', 'GET', room)).status, 200, 'за секунду до конца');
  s.at(60 + 50); assert.equal((await s.call('TeacherA', 'GET', room)).status, 409, 'в момент конца — закрыто');
  s.at(60 + 51);
  for (const p of ['', '/video']) assert.equal((await s.call('Owner', 'GET', room + p)).status, 409);
  assert.equal((await s.call('Owner', 'POST', room + '/call-owner')).status, 409);
  // посторонний не узнаёт ничего по времени: 403 и до окна, и в окне, и после
  for (const t of [0, 55, 200]) { s.at(t); assert.equal((await s.call('TeacherB', 'GET', room)).status, 403); }
  // отменённый урок
  s.at(55); s.db.prepare(`UPDATE lessons SET status = 'cancelled' WHERE id = ?`).run(s.L.a1);
  assert.equal((await s.call('TeacherA', 'GET', room)).status, 409);
});

// ---------- (в) чат ----------
test('(в) чат: видят только допущенные; дети не видят чужих реплик; родитель — только своего ребёнка; ребёнок пишет лишь в комнате', async () => {
  const s = await start();
  await openRoom(s);
  const room = s.room(s.L.a1);
  assert.equal((await s.call('KidA', 'POST', room + '/chat', { body: 'KIDA-MSG hello' })).status, 201);
  assert.equal((await s.call('KidB', 'POST', room + '/chat', { body: 'KIDB-MSG hello' })).status, 201);
  assert.equal((await s.call('TeacherA', 'POST', room + '/chat', { body: 'TEACHER-MSG all' })).status, 201);
  const bodies = async (who: string) => ((await s.call(who, 'GET', room)).json.messages as { body: string }[]).map(m => m.body.split(' ')[0]);
  assert.deepEqual(await bodies('KidA'), ['KIDA-MSG', 'TEACHER-MSG']);
  assert.deepEqual(await bodies('KidB'), ['KIDB-MSG', 'TEACHER-MSG']);
  assert.deepEqual(await bodies('ParentA'), ['KIDA-MSG', 'TEACHER-MSG']);
  assert.deepEqual(await bodies('ParentB'), ['KIDB-MSG', 'TEACHER-MSG']);
  assert.deepEqual(await bodies('TeacherA'), ['KIDA-MSG', 'KIDB-MSG', 'TEACHER-MSG']);
  assert.deepEqual(await bodies('Owner'), ['KIDA-MSG', 'KIDB-MSG', 'TEACHER-MSG']);
  // посторонние ничего не читают и не пишут
  for (const who of ['TeacherB', 'TeenC', 'ParentC', 'AdultD']) {
    assert.equal((await s.call(who, 'GET', room)).status, 403);
    assert.equal((await s.call(who, 'POST', room + '/chat', { body: 'intrusion' })).status, 403);
  }
  // родитель — наблюдатель: писать нельзя ни маршрутом, ни ядром
  assert.equal((await s.call('ParentA', 'POST', room + '/chat', { body: 'hi' })).status, 403);
  // личных сообщений ребёнку и контактов нет: ни маршрута «кому-то», ни контактов
  assert.equal((await s.call('KidA', 'POST', '/api/messages', { to_id: s.U('KidB').id, body: 'hi' })).status, 403, 'маршрута личных сообщений нет');
  assert.equal((await s.call('TeacherA', 'GET', '/api/contacts/' + s.U('KidA').id)).status, 403);
  // вне окна — не пишут
  s.at(200);
  assert.equal((await s.call('KidA', 'POST', room + '/chat', { body: 'late' })).status, 409);
  assert.equal(Number((s.db.prepare('SELECT COUNT(*) c FROM room_messages').get() as { c: number }).c), 3);
});

test('(в) контактный фильтр действует в чате комнаты; тексты в журнал не попадают', async () => {
  const s = await start();
  await openRoom(s);
  const room = s.room(s.L.a1);
  const bad = ['call me +48 600 100 200', 'mail kai@example.test', 'find me on telegram', 'see https://example.test/x', 'my number is one two three four five six seven'];
  for (const b of bad) {
    for (const who of ['KidA', 'TeacherA']) {
      const r = await s.call(who, 'POST', room + '/chat', { body: b });
      assert.equal(r.status, 422, `${who}: ${b}`);
      assert.equal(r.json.error, 'message_rejected');
    }
  }
  assert.equal((await s.call('KidA', 'POST', room + '/chat', { body: '   ' })).status, 422);
  assert.equal((await s.call('KidA', 'POST', room + '/chat', { body: 'x'.repeat(2001) })).status, 422);
  assert.equal((await s.call('KidA', 'POST', room + '/chat', { body: 'See you on 12.05.2026 at 17:30' })).status, 201, 'дата и время — не телефон');
  assert.equal(Number((s.db.prepare('SELECT COUNT(*) c FROM room_messages').get() as { c: number }).c), 1);
  assert.ok((s.db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE action LIKE 'room.chat.rejected.%'`).get() as { c: number }).c >= 10);
  const dump = JSON.stringify(s.db.prepare('SELECT * FROM audit_log').all());
  for (const secret of ['600 100', 'kai@example', 'telegram', 'example.test/x', 'See you on']) assert.ok(!dump.includes(secret), `в журнале нет текста: ${secret}`);
});

// ---------- изоляция ответов ----------
test('изоляция: ученик не видит чужих учеников, родитель — только своего ребёнка, контактов нет ни в одном ответе комнаты', async () => {
  const s = await start();
  await openRoom(s);
  const room = s.room(s.L.a1);
  for (const k of ['KidA', 'KidB', 'ParentA', 'ParentB', 'Owner']) assert.equal((await s.call(k, 'POST', room + '/enter')).status, 200, k);
  await s.call('KidA', 'POST', room + '/chat', { body: 'KIDA-MSG' });
  await s.call('KidB', 'POST', room + '/chat', { body: 'KIDB-MSG' });
  const names = (k: string) => s.U(k).display_name;
  const parts = async (who: string) => (await s.call(who, 'GET', room)).json.participants as { id: number; display_name?: string; role: string }[];
  // ученик: только он сам и преподаватель/владелец
  const a = await parts('KidA');
  assert.deepEqual(a.map(p => p.id).sort(), [s.U('KidA').id, s.U('TeacherA').id, s.U('Owner').id].sort());
  // родитель: свой ребёнок + преподаватель/владелец + он сам; чужого ребёнка и чужого родителя нет
  const pa = await parts('ParentA');
  assert.deepEqual(pa.map(p => p.id).sort(), [s.U('ParentA').id, s.U('KidA').id, s.U('TeacherA').id, s.U('Owner').id].sort());
  // преподаватель: родитель без имени
  const t = await parts('TeacherA');
  assert.ok(t.filter(p => p.role === 'parent').every(p => p.display_name === undefined));
  const all = ['KidA', 'KidB', 'ParentA', 'ParentB', 'TeacherA', 'Owner', 'TeacherB', 'TeenC', 'ParentC', 'AdultD'];
  const secrets = all.flatMap(k => [s.U(k).email, s.U(k).phone, s.U(k).password]).concat(s.demo.surnames);
  const respOf: Record<string, string> = {};
  for (const who of ['KidA', 'KidB', 'ParentA', 'ParentB', 'TeacherA', 'Owner']) {
    const texts = [(await s.call(who, 'GET', room)).text, (await s.call(who, 'GET', room + '/video')).text, (await s.call(who, 'POST', room + '/enter')).text];
    respOf[who] = texts.join('\n');
    for (const sec of secrets) assert.ok(!respOf[who].includes(sec), `${who}: в ответах комнаты нет «${sec}»`);
    assert.ok(!/email|phone|"login"|password|token|livekit/i.test(respOf[who]), `${who}: нет контактных/секретных полей`);
  }
  for (const who of ['KidA', 'ParentA']) {
    assert.ok(!respOf[who].includes(names('KidB')) && !respOf[who].includes('KIDB-MSG') && !respOf[who].includes(names('ParentB')), `${who} не видит семью B`);
  }
  for (const who of ['KidB', 'ParentB']) assert.ok(!respOf[who].includes(names('KidA')) && !respOf[who].includes('KIDA-MSG') && !respOf[who].includes(names('ParentA')), `${who} не видит семью A`);
  assert.ok(!respOf.TeacherA.includes(names('ParentA')) && !respOf.TeacherA.includes(names('ParentB')), 'преподаватель не видит имён родителей');
  assert.ok(!respOf.KidA.includes(names('TeacherB')) && !respOf.TeacherA.includes(names('TeenC')), 'чужие не светятся');
  // ответ вызова владельца и списка вызовов — тоже без контактов
  await s.call('KidA', 'POST', room + '/call-owner');
  const calls = (await s.call('Owner', 'GET', '/api/room-calls')).text;
  for (const sec of secrets) assert.ok(!calls.includes(sec), `в списке вызовов нет «${sec}»`);
});

// ---------- (г) аварийный выключатель и ребёнок не один ----------
test('(г) «позвать владельца»: любой допущенный; запись в журнале без текста чата; владелец видит; чужой — нет', async () => {
  const s = await start();
  await openRoom(s);
  const room = s.room(s.L.a1);
  await s.call('KidA', 'POST', room + '/chat', { body: 'PRIVATE-CHAT-TEXT' });
  assert.equal((await s.call('KidA', 'POST', room + '/call-owner')).status, 200);
  assert.equal((await s.call('ParentB', 'POST', room + '/call-owner')).status, 200);
  assert.equal((await s.call('TeacherA', 'POST', room + '/call-owner')).status, 200);
  assert.equal((await s.call('TeacherB', 'POST', room + '/call-owner')).status, 403);
  assert.equal((await s.call('TeenC', 'POST', room + '/call-owner')).status, 403);
  const r = await s.call('Owner', 'GET', '/api/room-calls');
  assert.equal(r.status, 200);
  const calls = r.json.calls as { lesson_id: number; caller_id: number; caller_role: string; ts: string }[];
  assert.deepEqual(calls.map(c => c.caller_id).sort(), [s.U('KidA').id, s.U('ParentB').id, s.U('TeacherA').id].sort());
  assert.ok(calls.every(c => c.lesson_id === s.L.a1 && c.ts));
  for (const who of ['TeacherA', 'KidA', 'ParentA']) assert.equal((await s.call(who, 'GET', '/api/room-calls')).status, 403);
  assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM audit_log').all()).includes('PRIVATE-CHAT-TEXT'));
  assert.ok(!r.text.includes('PRIVATE-CHAT-TEXT'));
});

test('(г) ребёнка нельзя оставить без взрослого: ребёнок не входит в пустую комнату, единственный взрослый не может уйти; флаги', async () => {
  const s = await start();
  s.at(55);
  const room = s.room(s.L.a1);
  let r = await s.call('KidA', 'POST', room + '/enter');
  assert.equal(r.status, 409); assert.equal(r.json.error, 'wait_for_adult');
  assert.equal((await s.call('TeacherA', 'POST', room + '/enter')).json.flags.child_present, false);
  r = await s.call('KidA', 'POST', room + '/enter');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.flags, { child_present: true, supervising_adults: 1, child_alone: false, child_without_second_adult: true });
  // преподаватель уйти не может
  r = await s.call('TeacherA', 'POST', room + '/leave');
  assert.equal(r.status, 409); assert.equal(r.json.error, 'child_would_be_alone');
  // второй взрослый (родитель) — теперь можно; флаг «нет второго взрослого» снят
  r = await s.call('ParentA', 'POST', room + '/enter');
  assert.equal(r.json.flags.child_without_second_adult, false);
  assert.equal((await s.call('TeacherA', 'POST', room + '/leave')).status, 200);
  // но теперь единственный взрослый — родитель, он тоже не может оставить ребёнка
  assert.equal((await s.call('ParentA', 'POST', room + '/leave')).json.error, 'child_would_be_alone');
  // ребёнок ушёл — взрослый уходит свободно
  assert.equal((await s.call('KidA', 'POST', room + '/leave')).status, 200);
  assert.equal((await s.call('ParentA', 'POST', room + '/leave')).status, 200);
  assert.equal((await s.call('TeenC', 'POST', room + '/leave')).status, 403);
  assert.ok((s.db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE action = 'room.leave.would_leave_child_alone' AND outcome = 'denied'`).get() as { c: number }).c >= 2);
});

// ---------- (д) запись ----------
test('(д) запись выключена по умолчанию; включает только владелец при согласии родителей; в журнал — кто и когда; участники видят «идёт запись»', async () => {
  const s = await start();
  s.at(55);
  const room = s.room(s.L.a1);
  assert.equal((s.db.prepare('SELECT recording FROM lessons WHERE id = ?').get(s.L.a1) as { recording: number }).recording, 0);
  assert.equal((await s.call('KidA', 'GET', room)).json.recording, false);
  for (const who of ['TeacherA', 'TeacherB', 'KidA', 'ParentA', 'TeenC']) assert.equal((await s.call(who, 'POST', room + '/recording', { on: true })).status, 403, who);
  assert.equal((s.db.prepare('SELECT recording FROM lessons WHERE id = ?').get(s.L.a1) as { recording: number }).recording, 0);
  assert.equal((await s.call('Owner', 'POST', room + '/recording', { on: 'yes' })).status, 400);
  // без согласия родителей — отказ даже владельцу
  let r = await s.call('Owner', 'POST', room + '/recording', { on: true });
  assert.equal(r.status, 409); assert.equal(r.json.error, 'recording_consent_missing');
  assert.equal((s.db.prepare('SELECT recording FROM lessons WHERE id = ?').get(s.L.a1) as { recording: number }).recording, 0);
  for (const [p, c] of [['ParentA', 'KidA'], ['ParentB', 'KidB']]) grantConsent(s.db, actorOf(s.db, s.U(p).id), s.U(c).id, 'lesson_recording');
  r = await s.call('Owner', 'POST', room + '/recording', { on: true });
  assert.equal(r.status, 200);
  const row = s.db.prepare('SELECT recording, recording_set_by, recording_set_at FROM lessons WHERE id = ?').get(s.L.a1) as any;
  assert.equal(row.recording, 1); assert.equal(row.recording_set_by, s.U('Owner').id); assert.ok(row.recording_set_at);
  const log = s.db.prepare(`SELECT actor_id, ts, outcome FROM audit_log WHERE action = 'room.recording.on'`).all() as any[];
  assert.equal(log.length, 1); assert.equal(log[0].actor_id, s.U('Owner').id); assert.ok(log[0].ts); assert.equal(log[0].outcome, 'allowed');
  for (const who of ['KidA', 'KidB', 'ParentA', 'TeacherA', 'Owner']) assert.equal((await s.call(who, 'GET', room)).json.recording, true, who);
  assert.equal((await s.call('TeacherB', 'GET', room)).status, 403);
  // чужой урок (b1) запись не затронута
  assert.equal((s.db.prepare('SELECT recording FROM lessons WHERE id = ?').get(s.L.b1) as { recording: number }).recording, 0);
  // выключение тоже в журнале
  assert.equal((await s.call('Owner', 'POST', room + '/recording', { on: false })).status, 200);
  assert.equal((await s.call('KidA', 'GET', room)).json.recording, false);
  assert.equal((s.db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE action = 'room.recording.off'`).get() as { c: number }).c, 1);
});

// ---------- (е) видео ----------
test('(е) видео — заглушка: без ключей и токенов, только допущенным в окне', async () => {
  const s = await start();
  s.at(55);
  const room = s.room(s.L.a1);
  const r = await s.call('KidA', 'GET', room + '/video');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['note', 'provider', 'status']);
  assert.equal(r.json.provider, 'stub');
  assert.ok(!/key|secret|token|livekit|wss?:/i.test(JSON.stringify(r.json).replace('provider', '')));
  assert.equal((await s.call('TeenC', 'GET', room + '/video')).status, 403);
  s.at(0); assert.equal((await s.call('KidA', 'GET', room + '/video')).status, 409);
});

// ---------- вторая линия: даже при ошибочно выданном праве ядро проверяет принадлежность/роль само ----------
test('ядро не полагается на матрицу прав: выдали лишнее право — запись включить и писать родителю всё равно нельзя', async () => {
  const s = await start();
  s.at(55);
  s.db.prepare(`INSERT INTO role_permissions(role, permission) VALUES ('teacher','room.recording.set'),('parent','room.chat.send'),('student','room.recording.set')`).run();
  const { setRecording, postRoomMessage } = await import('../src/room.ts');
  const { Denied } = await import('../src/access.ts');
  for (const who of ['TeacherA', 'KidA', 'ParentA']) assert.throws(() => setRecording(s.db, actorOf(s.db, s.U(who).id), s.L.a1, true, s.clock.now), Denied, who);
  assert.equal((s.db.prepare('SELECT recording FROM lessons WHERE id = ?').get(s.L.a1) as { recording: number }).recording, 0);
  assert.throws(() => postRoomMessage(s.db, actorOf(s.db, s.U('ParentA').id), s.L.a1, 'hello', s.clock.now), /observer_read_only/);
  assert.equal(Number((s.db.prepare('SELECT COUNT(*) c FROM room_messages').get() as { c: number }).c), 0);
});
