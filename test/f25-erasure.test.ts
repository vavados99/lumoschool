// Ф25: удаление данных по просьбе (HTTP-ручка) + срок хранения чата урока и журнала + фиксация порогов 16/18.
// Реальные HTTP-запросы, подставляемые часы, выдуманные данные (seedDemo). Список поломок для проверки силы тестов — в docs/ВОРОТА.md.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import { seedDemo } from '../src/seed.ts';
import { createApp, listen, COOKIE } from '../src/server.ts';
import { actorOf, isMinor, grantConsent } from '../src/access.ts';
import { isChild } from '../src/messages.ts';
import { setRecording, RoomRefused } from '../src/room.ts';
import { runRetention, CHAT_RETENTION_DAYS, AUDIT_RETENTION_DAYS, ERASED_ID } from '../src/consent.ts';
import { loadConfig, ConfigError } from '../src/config.ts';
import { cleanupOnce, buildTasks, createScheduler } from '../src/scheduler.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });
const MIN = 60_000, DAY = 86_400_000;
const sqlTs = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

async function start() {
  const T0 = Date.now();
  const clock = { now: T0 };
  const db = openDb(':memory:');
  const demo = seedDemo(db, T0);
  const server = createApp(db, { now: () => clock.now, rateLimit: false });
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
  const rawLogin = (key: string) => fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: demo.users[key].login, password: demo.users[key].password }) });
  for (const k of Object.keys(demo.users)) {
    const r = await rawLogin(k);
    assert.equal(r.status, 200);
    jar[k] = /sid=([0-9a-f]+)/.exec(r.headers.get('set-cookie') ?? '')![1];
  }
  const L = demo.lessons;
  const startAt = (id: number, offsetMin: number) => db.prepare(`UPDATE lessons SET starts_at = ?, status = 'planned' WHERE id = ?`).run(new Date(T0 + offsetMin * MIN).toISOString(), id);
  startAt(L.a1, 60); startAt(L.a2, 600); startAt(L.b1, 60); startAt(L.b2, 60);
  const at = (offsetMin: number) => { clock.now = T0 + offsetMin * MIN; };
  const U = (k: string) => demo.users[k];
  const n = (sql: string, ...p: (string | number)[]) => Number((db.prepare(sql).get(...p) as { c: number }).c);
  return { db, demo, call, rawLogin, at, T0, L, U, n };
}
type S = Awaited<ReturnType<typeof start>>;
const body = (s: S, k: string) => (s.db.prepare('SELECT display_name, birth_date, anonymized_at FROM users WHERE id = ?').get(s.U(k).id) as any);

// ---------- (A) ручка удаления: кто может ----------
test('Ф25 ручка: преподаватель, ученик и аноним не могут (403/401), ничего не стёрто; без confirm — 400', async () => {
  const s = await start();
  const kid = s.U('KidA').id;
  for (const who of ['TeacherA', 'TeacherB', 'KidA', 'KidB', 'AdultD', 'TeenC'] as const) {
    const r = await s.call(who, 'POST', `/api/erase/${kid}`, { confirm: true });
    assert.equal(r.status, 403, `${who} не должен мочь`);
  }
  assert.equal((await s.call(null, 'POST', `/api/erase/${kid}`, { confirm: true })).status, 401);
  assert.equal((await s.call('Owner', 'POST', `/api/erase/${kid}`, {})).status, 400);                    // без явного подтверждения
  assert.equal((await s.call('Owner', 'POST', `/api/erase/${kid}`, { confirm: 'yes' })).status, 400);    // не true
  assert.equal(body(s, 'KidA').display_name, 'Kai');
  assert.equal(body(s, 'KidA').anonymized_at, null);
  assert.equal(s.n('SELECT COUNT(*) c FROM credentials WHERE user_id = ?', kid), 1);
});

test('Ф25 ручка: родитель не может удалить чужого ребёнка, чужого родителя, владельца, преподавателя; владелец — не владельца и не преподавателя', async () => {
  const s = await start();
  for (const [who, target] of [['ParentA', 'KidB'], ['ParentA', 'TeenC'], ['ParentB', 'KidA'], ['ParentA', 'ParentB'], ['ParentA', 'Owner'], ['ParentA', 'TeacherA'],
    ['Owner', 'Owner'], ['Owner', 'TeacherA']] as const) {
    const r = await s.call(who, 'POST', `/api/erase/${s.U(target).id}`, { confirm: true });
    assert.equal(r.status, 403, `${who} → ${target}`);
    assert.notEqual(body(s, target).display_name, 'Deleted user', `${target} стёрт!`);
  }
  assert.equal((await s.call('Owner', 'POST', '/api/erase/999999', { confirm: true })).status, 403);    // несуществующий — тот же ответ
  // ни одна из попыток не изменила ни одной строки людей
  assert.equal(s.n('SELECT COUNT(*) c FROM users WHERE anonymized_at IS NOT NULL'), 0);
  assert.ok(s.n(`SELECT COUNT(*) c FROM audit_log WHERE action = 'data.erase' AND outcome = 'denied'`) >= 1, 'отказ записан в журнал');
});

// ---------- (A) что происходит после ----------
test('Ф25 владелец обезличивает ученика: данные стёрты, вход невозможен, имя и id не видны ни одной роли, журнал обезличен и пополнен', async () => {
  const s = await start();
  const kid = s.U('KidA').id;
  // чат урока: реплики ребёнка и преподавателя; ветка сообщений уже есть в seed (th)
  s.db.prepare(`INSERT INTO room_messages(lesson_id, from_id, body) VALUES (?,?,?)`).run(s.L.a1, kid, 'KID-CHAT-SECRET');
  s.db.prepare(`INSERT INTO room_messages(lesson_id, from_id, body) VALUES (?,?,?)`).run(s.L.a1, s.U('TeacherA').id, 'teacher chat line');
  s.at(55);
  const viewers = ['TeacherA', 'KidB', 'ParentB', 'ParentA', 'Owner', 'TeacherB'] as const;
  const endpoints = ['/api/students', '/api/lessons', `/api/rooms/${s.L.a1}`, `/api/threads/${s.demo.lessons.thread}`, '/api/threads', '/api/notifications', '/api/owner/audit'];
  const dump = async (who: string) => { let all = ''; for (const e of endpoints) all += (await s.call(who, 'GET', e)).text + '\n'; return all; };

  // контроль: ДО удаления ребёнок виден (иначе проверки «не виден» пустые)
  assert.ok((await dump('TeacherA')).includes('Kai'), 'до удаления преподаватель видит Kai');
  assert.ok((await dump('KidB')).includes('KID-CHAT-SECRET') || (await dump('TeacherA')).includes('KID-CHAT-SECRET'), 'до удаления реплика ребёнка видна в чате');

  const auditBefore = s.n('SELECT COUNT(*) c FROM audit_log');
  const r = await s.call('Owner', 'POST', `/api/erase/${kid}`, { confirm: true });
  assert.equal(r.status, 200, r.text);
  const auditAfterErase = s.n('SELECT MAX(id) c FROM audit_log');   // дальше проверки сами пишут отказы с этим id — они уже после удаления

  // строка человека
  assert.deepEqual({ ...body(s, 'KidA') }, { display_name: 'Deleted user', birth_date: null, anonymized_at: body(s, 'KidA').anonymized_at });
  assert.ok(body(s, 'KidA').anonymized_at);
  for (const t of ['contact_vault', 'credentials', 'sessions']) assert.equal(s.n(`SELECT COUNT(*) c FROM ${t} WHERE user_id = ?`, kid), 0, t);
  assert.equal(s.n('SELECT COUNT(*) c FROM msg_posts p JOIN msg_threads t ON t.id = p.thread_id WHERE t.student_id = ?', kid), 0);
  assert.equal(s.n('SELECT COUNT(*) c FROM room_messages WHERE from_id = ?', kid), 0, 'реплики в чате урока стёрты');
  assert.equal(s.n('SELECT COUNT(*) c FROM parent_child WHERE child_id = ?', kid), 0, 'связи родитель—ребёнок удалены');
  assert.equal(s.n(`SELECT COUNT(*) c FROM parental_consents WHERE child_id = ? AND revoked_at IS NOT NULL AND retain_until IS NOT NULL`, kid), 1, 'согласие отозвано и хранится как доказательство');
  assert.equal(s.n(`SELECT COUNT(*) c FROM parental_consents WHERE child_id = ? AND revoked_at IS NULL`, kid), 0);

  // вход невозможен: прежняя сессия мертва, новый вход отвергнут
  assert.equal((await s.call('KidA', 'GET', '/api/me')).status, 401);
  assert.equal((await s.rawLogin('KidA')).status, 401);

  // ни одна роль не видит ни имя, ни реплику, ни id ребёнка в списках людей
  for (const who of viewers) {
    const t = await dump(who);
    assert.ok(!t.includes('Kai'), `${who} видит имя`);
    assert.ok(!t.includes('KID-CHAT-SECRET'), `${who} видит реплику ребёнка в чате`);
    assert.ok(!t.includes('Deleted user'), `${who} видит заглушку имени как участника`);
    const st = (await s.call(who, 'GET', '/api/students')).json.students as { id: number }[];
    assert.ok(!st.some(x => x.id === kid), `${who}: ребёнок в списке учеников`);
    const ls = (await s.call(who, 'GET', '/api/lessons')).json.lessons as { students: { id: number }[] }[];
    assert.ok(!ls.some(l => l.students.some(x => x.id === kid)), `${who}: ребёнок среди учеников урока`);
  }
  assert.ok((await dump('TeacherA')).includes('teacher chat line'), 'чужие реплики чата не задеты');
  // экспорт и согласия удалённого — недоступны
  assert.equal((await s.call('ParentA', 'GET', `/api/export/${kid}`)).status, 403);
  assert.equal((await s.call('ParentA', 'GET', `/api/consents/${kid}`)).status, 403);

  // повторное удаление — отказ (уже обезличен)
  assert.equal((await s.call('Owner', 'POST', `/api/erase/${kid}`, { confirm: true })).status, 403);

  // журнал: строки НЕ удалены (их стало больше), ссылки на человека обезличены, само действие записано
  assert.ok(s.n('SELECT COUNT(*) c FROM audit_log') > auditBefore, 'журнал не уменьшился');
  assert.equal(s.n('SELECT COUNT(*) c FROM audit_log WHERE actor_id = ? AND id <= ?', kid, auditAfterErase), 0, 'actor_id человека обезличен');
  assert.equal(s.n(`SELECT COUNT(*) c FROM audit_log WHERE target_id = ? AND action != 'data.erased' AND id <= ? AND target_type IN ('student','person_data','user','consent','contact_vault')`, kid, auditAfterErase), 0, 'target_id человека обезличен (кроме строки об удалении)');
  assert.ok(s.n('SELECT COUNT(*) c FROM audit_log WHERE actor_id = ?', ERASED_ID) >= 1, 'его прежние действия остались строками с actor_id=0');
  assert.equal(s.n(`SELECT COUNT(*) c FROM audit_log WHERE action = 'data.erased' AND actor_id = ? AND outcome = 'allowed'`, s.U('Owner').id), 1, 'действие записано, автор — владелец');
});

test('Ф25 родитель удаляет своего ребёнка и сам себя: 200, ребёнок обезличен, чужой ребёнок цел; сессия родителя после самоудаления мертва', async () => {
  const s = await start();
  assert.equal((await s.call('ParentA', 'POST', `/api/erase/${s.U('KidA').id}`, { confirm: true })).status, 200);
  assert.equal(body(s, 'KidA').display_name, 'Deleted user');
  assert.equal(body(s, 'KidB').display_name, 'Kira');
  assert.equal(s.n('SELECT COUNT(*) c FROM credentials WHERE user_id = ?', s.U('KidB').id), 1);
  assert.equal((await s.call('ParentB', 'POST', `/api/erase/${s.U('ParentB').id}`, { confirm: true })).status, 200);
  assert.equal(body(s, 'ParentB').display_name, 'Deleted user');
  assert.equal((await s.call('ParentB', 'GET', '/api/me')).status, 401);
  // самоудаление родителя: журнал — ссылки на него обезличены, кроме строки об удалении
  assert.equal(s.n(`SELECT COUNT(*) c FROM audit_log WHERE actor_id = ? AND action != 'data.erased'`, s.U('ParentB').id), 0);
});

// ---------- (B) срок хранения чата урока и журнала ----------
test('Ф25 срок: чат урока и журнал старше срока чистятся (искусственно состаренные строки), свежие и граница не тронуты', () => {
  const db = openDb(':memory:');
  const demo = seedDemo(db);
  const owner = actorOf(db, demo.users.Owner.id);
  const now = Date.now();
  const room = db.prepare('INSERT INTO room_messages(lesson_id, from_id, body, created_at) VALUES (?,?,?,?)');
  const L = demo.lessons.a1, T = demo.users.TeacherA.id;
  room.run(L, T, 'old-chat-1', sqlTs(now - (CHAT_RETENTION_DAYS + 10) * DAY));
  room.run(L, T, 'old-chat-2', sqlTs(now - 400 * DAY));
  room.run(L, T, 'edge-chat', sqlTs(now - (CHAT_RETENTION_DAYS - 1) * DAY));   // за день до границы — остаётся
  room.run(L, T, 'fresh-chat', sqlTs(now - 1 * DAY));
  const au = db.prepare(`INSERT INTO audit_log(ts, actor_id, action, target_type, target_id, outcome) VALUES (?,?,?,?,?,'allowed')`);
  au.run(sqlTs(now - (AUDIT_RETENTION_DAYS + 5) * DAY), T, 'old.probe.1', 'x', null);
  au.run(sqlTs(now - 900 * DAY), null, 'old.probe.2', 'x', null);
  au.run(sqlTs(now - (AUDIT_RETENTION_DAYS - 5) * DAY), T, 'edge.probe', 'x', null);
  au.run(sqlTs(now - 2 * DAY), T, 'fresh.probe', 'x', null);
  const freshAuditBefore = Number((db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE ts > ?`).get(sqlTs(now - 3 * DAY)) as any).c);

  const r = runRetention(db, owner, { now });
  assert.equal(r.room_messages, 2);
  assert.equal(r.audit_log, 2);
  assert.deepEqual((db.prepare('SELECT body FROM room_messages ORDER BY id').all() as any[]).map(x => x.body), ['edge-chat', 'fresh-chat']);
  const acts = (db.prepare(`SELECT action FROM audit_log WHERE action LIKE '%.probe%'`).all() as any[]).map(x => x.action).sort();
  assert.deepEqual(acts, ['edge.probe', 'fresh.probe']);
  // все свежие строки журнала на месте (+ запись о самой чистке)
  const freshAfter = Number((db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE ts > ?`).get(sqlTs(now - 3 * DAY)) as any).c);
  assert.ok(freshAfter >= freshAuditBefore, 'свежие строки журнала не тронуты');
  assert.equal(Number((db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE action = 'retention.run'`).get() as any).c) >= 1, true);
  // повторный запуск ничего больше не стирает
  const r2 = runRetention(db, owner, { now });
  assert.equal(r2.room_messages, 0); assert.equal(r2.audit_log, 0);
});

test('Ф25 срок: параметры и защита журнала — только владелец, журнал «в ноль» стереть нельзя, обычный DELETE/UPDATE журнала по-прежнему падает', () => {
  const db = openDb(':memory:');
  const demo = seedDemo(db);
  assert.throws(() => runRetention(db, actorOf(db, demo.users.TeacherA.id), { now: Date.now() }));
  assert.throws(() => runRetention(db, actorOf(db, demo.users.ParentA.id), { now: Date.now() }));
  const owner = actorOf(db, demo.users.Owner.id);
  assert.throws(() => runRetention(db, owner, { auditDays: 0 }), /bad retention/);
  assert.throws(() => runRetention(db, owner, { auditDays: 29 }), /bad retention/);
  assert.throws(() => runRetention(db, owner, { chatDays: -1 }), /bad retention/);
  const before = Number((db.prepare('SELECT COUNT(*) c FROM audit_log').get() as any).c);
  assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_log WHERE id = 1').run(), /append-only/);
  assert.throws(() => db.prepare(`UPDATE audit_log SET outcome = 'allowed'`).run(), /append-only/);
  assert.throws(() => db.prepare(`UPDATE audit_log SET action = 'x' WHERE id = 1`).run(), /append-only/);
  assert.throws(() => db.prepare(`UPDATE audit_log SET actor_id = 7 WHERE id = 1`).run(), /append-only/);   // менять можно только на 0 («обезличено»)
  assert.equal(Number((db.prepare('SELECT COUNT(*) c FROM audit_log').get() as any).c) >= before, true);
  assert.equal(Number((db.prepare('SELECT open FROM audit_purge_gate WHERE id = 1').get() as any).open), 0, 'ворота закрыты после чистки');
  runRetention(db, owner, { now: Date.now() });
  assert.equal(Number((db.prepare('SELECT open FROM audit_purge_gate WHERE id = 1').get() as any).open), 0);
  assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /append-only/);
});

test('Ф25 срок: подключено к планировщику (cleanup) и к конфигурации; параметры CHAT_RETENTION_DAYS / AUDIT_RETENTION_DAYS проверяются', async () => {
  const db = openDb(':memory:');
  const demo = seedDemo(db);
  const now = Date.now();
  const T = demo.users.TeacherA.id;
  db.prepare('INSERT INTO room_messages(lesson_id, from_id, body, created_at) VALUES (?,?,?,?)').run(demo.lessons.a1, T, 'c-20d', sqlTs(now - 20 * DAY));
  db.prepare('INSERT INTO room_messages(lesson_id, from_id, body, created_at) VALUES (?,?,?,?)').run(demo.lessons.a1, T, 'c-2d', sqlTs(now - 2 * DAY));
  db.prepare(`INSERT INTO audit_log(ts, actor_id, action, target_type, outcome) VALUES (?,?,?,?,'allowed')`).run(sqlTs(now - 50 * DAY), T, 'a.50d', 'x');
  db.prepare(`INSERT INTO audit_log(ts, actor_id, action, target_type, outcome) VALUES (?,?,?,?,'allowed')`).run(sqlTs(now - 5 * DAY), T, 'a.5d', 'x');
  // по умолчанию (90/365): ни 20-дневный чат, ни 50-дневная строка не уходят
  const cfgDefault = loadConfig({ LUMO_MODE: 'test' });
  assert.deepEqual([cfgDefault.chatRetentionDays, cfgDefault.auditRetentionDays], [null, null]);
  cleanupOnce(db, cfgDefault, now);
  assert.equal(Number((db.prepare('SELECT COUNT(*) c FROM room_messages').get() as any).c), 2);
  assert.equal(Number((db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE action LIKE 'a.%'`).get() as any).c), 2);
  // задача планировщика 'cleanup' берёт сроки из конфигурации
  const cfg = loadConfig({ LUMO_MODE: 'test', CHAT_RETENTION_DAYS: '10', AUDIT_RETENTION_DAYS: '30' });
  assert.deepEqual([cfg.chatRetentionDays, cfg.auditRetentionDays], [10, 30]);
  const events: string[] = [];
  const sch = createScheduler(buildTasks(db, cfg, null), { onEvent: e => events.push(`${e.task}:${e.event}`) });
  await sch.tick('cleanup');
  assert.deepEqual(events, ['cleanup:ok']);
  assert.deepEqual((db.prepare('SELECT body FROM room_messages').all() as any[]).map(x => x.body), ['c-2d']);
  assert.deepEqual((db.prepare(`SELECT action FROM audit_log WHERE action LIKE 'a.%'`).all() as any[]).map(x => x.action), ['a.5d']);
  // неверные значения конфигурации — отказ запуска
  for (const [k, v] of [['CHAT_RETENTION_DAYS', '0'], ['CHAT_RETENTION_DAYS', 'abc'], ['AUDIT_RETENTION_DAYS', '29'], ['AUDIT_RETENTION_DAYS', '-1'], ['AUDIT_RETENTION_DAYS', '1.5']])
    assert.throws(() => loadConfig({ LUMO_MODE: 'test', [k]: v }), ConfigError, `${k}=${v}`);
});

// ---------- (C) пороги 16 и 18: фиксация осознанной разницы ----------
test('Ф25 пороги: согласие на обработку — по <16 (isMinor), согласие на запись урока — по <18 (isChild); разница НАМЕРЕННАЯ (строже = безопаснее)', () => {
  const db = openDb(':memory:');
  const demo = seedDemo(db);
  const mk = (birth: string) => Number(db.prepare(`INSERT INTO users(role, display_name, birth_date) VALUES ('student','Probe',?)`).run(birth).lastInsertRowid);
  // день рождения 2010-06-15: 15 лет до 2026-06-15, 16 с этого дня; 18 — с 2028-06-15
  const u = mk('2010-06-15');
  const d = (s: string) => new Date(s + 'T12:00:00');
  assert.equal(isMinor(db, u, d('2026-06-14')), true);   // 15 → ещё нужно согласие на обработку
  assert.equal(isMinor(db, u, d('2026-06-15')), false);  // ровно 16 → уже нет
  assert.equal(isChild(db, u, d('2026-06-15')), true);   // но 16 — всё ещё ребёнок для записи урока
  assert.equal(isChild(db, u, d('2028-06-14')), true);   // 17 лет 364 дня
  assert.equal(isChild(db, u, d('2028-06-15')), false);  // ровно 18 → взрослый
  assert.equal(isMinor(db, mk('2000-01-01')), false);
  assert.equal(isChild(db, mk('2000-01-01')), false);
  // неизвестный возраст — как ребёнок по обоим правилам
  const noDob = Number(db.prepare(`INSERT INTO users(role, display_name) VALUES ('student','NoDob')`).run().lastInsertRowid);
  assert.equal(isMinor(db, noDob), true); assert.equal(isChild(db, noDob), true);

  // поведение: 17-летний — не «minor» для согласия на обработку, но запись урока без согласия родителя ему запрещена; 18-летнему — не нужно
  const y = new Date().getFullYear();
  const owner = actorOf(db, demo.users.Owner.id);
  const teen = mk(`${y - 17}-01-01`);   // 17 лет сейчас (день рождения 1 января уже был или сегодня)
  assert.equal(isMinor(db, teen), false);
  assert.equal(isChild(db, teen), true);
  const lesson = (aud: 'minor' | 'adult') => Number(db.prepare(`INSERT INTO lessons(teacher_id, starts_at, audience, max_students) VALUES (?,?,?,6)`)
    .run(demo.users.TeacherB.id, new Date(Date.now() + 30 * DAY).toISOString(), aud).lastInsertRowid);
  const lm = lesson('minor');
  db.prepare('INSERT INTO students(user_id, level) VALUES (?, NULL)').run(teen);
  db.prepare('INSERT INTO lesson_enrollments(lesson_id, student_id) VALUES (?,?)').run(lm, teen);
  assert.throws(() => setRecording(db, owner, lm, true), (e: unknown) => e instanceof RoomRefused && e.reason === 'recording_consent_missing');
  const adult = mk(`${y - 19}-01-01`);
  const la = lesson('adult');
  db.prepare('INSERT INTO students(user_id, level) VALUES (?, NULL)').run(adult);
  db.prepare('INSERT INTO lesson_enrollments(lesson_id, student_id) VALUES (?,?)').run(la, adult);
  setRecording(db, owner, la, true);   // взрослому согласие родителя не нужно
  assert.equal(Number((db.prepare('SELECT recording c FROM lessons WHERE id = ?').get(la) as any).c), 1);
  void grantConsent;
});
