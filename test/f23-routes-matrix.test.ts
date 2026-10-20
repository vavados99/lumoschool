// Ф23: построчная сверка КАЖДОГО маршрута сервера с матрицей прав: «маршрут × роль → ожидаемый статус»
// + изоляция по содержимому ответов (контакты, чужие ученики, родители) + подмена id внутри разрешённой роли.
// Реальные HTTP-запросы, выдуманные данные (seedDemo). Время зафиксировано за 5 минут до первого урока преподавателя A.
//
// Как читать таблицу: ключ роли → { as: кто ходит, path, body, status }. Если у роли ответ 403, а в routeTable() роль
// ЕСТЬ — это «ядро отказало независимо» (HTTP шире права в role_permissions); такие ячейки помечены комментарием.
// Полнота: тест требует ячейку для КАЖДОГО маршрута routeTable() и КАЖДОЙ из пяти ролей — новый маршрут без строки здесь = красный тест.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import { seedDemo, type Demo } from '../src/seed.ts';
import { createApp, listen, routeTable, COOKIE } from '../src/server.ts';

type Res = { status: number; text: string; json: any };
const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

const MIN = 60_000, DAY = 86_400_000;

async function start() {
  const db = openDb(':memory:');
  const demo: Demo = seedDemo(db);
  const a1 = db.prepare('SELECT starts_at FROM lessons WHERE id = ?').get(demo.lessons.a1) as { starts_at: string };
  const clock = { t: Date.parse(a1.starts_at) - 5 * MIN };   // комната урока a1 открыта (допуск за 10 минут до начала)
  const lessonStart = Date.parse(a1.starts_at);
  const ins = (teacher: string, offsetDays: number, audience: string) => Number(db.prepare(
    'INSERT INTO lessons(teacher_id, starts_at, audience, max_students) VALUES (?,?,?,?)')
    .run(demo.users[teacher].id, new Date(lessonStart + offsetDays * DAY).toISOString(), audience, audience === 'adult' ? 8 : 6).lastInsertRowid);
  const lx = ins('TeacherB', 20, 'adult');   // свободный взрослый урок (запись AdultD)
  const ly = ins('TeacherB', 21, 'minor');   // свободный детский урок (запись детей родителем/владельцем)
  const lz = ins('TeacherA', 22, 'minor');   // будущий детский урок с записью KidA (отмена вне окна 24 ч)
  for (const k of ['KidA']) db.prepare('INSERT INTO lesson_enrollments(lesson_id, student_id) VALUES (?,?)').run(lz, demo.users[k].id);
  // Ф28: фикстура для ячеек канала удаления — открытая заявка №1 (KidA ждёт родителя; напрямую в таблицу: через API KidA младше 16 подать не может)
  db.prepare(`INSERT INTO erasure_requests(subject_id, requested_by, via, status) VALUES (?,?,'self','pending_parent')`).run(demo.users.KidA.id, demo.users.KidA.id);
  const server = createApp(db, { now: () => clock.t, rateLimit: false });
  servers.push(server);
  const port = await listen(server, 0);
  const base = `http://127.0.0.1:${port}`;
  const jar: Record<string, string> = {};
  const log: { as: string | null; method: string; path: string; status: number; text: string }[] = [];
  const call = async (as: string | null, method: string, path: string, body?: unknown): Promise<Res> => {
    const headers: Record<string, string> = {};
    if (as && jar[as]) headers.cookie = `${COOKIE}=${jar[as]}`;
    let payload: string | undefined;
    if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + path, { method, headers, body: payload });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* не JSON */ }
    log.push({ as, method, path, status: r.status, text });
    return { status: r.status, text, json };
  };
  const loginAs = async (...keys: string[]) => {
    for (const key of keys) {
      const u = demo.users[key];
      const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: u.login, password: u.password }) });
      assert.equal(r.status, 200, `login ${key}`);
      const m = /sid=([0-9a-f]+)/.exec(r.headers.get('set-cookie') ?? '');
      assert.ok(m, 'cookie');
      jar[key] = m[1];
    }
  };
  const id = (k: string) => demo.users[k].id;
  return { db, demo, call, loginAs, clock, log, lx, ly, lz, id, lessonStart };
}
type S = Awaited<ReturnType<typeof start>>;

// ---------- таблица «маршрут × роль» ----------
type Role5 = 'anon' | 'student' | 'parent' | 'teacher' | 'owner';
type Cell = { as: string | null; path: string; body?: unknown; status: number };
const ORDER: Role5[] = ['teacher', 'owner', 'parent', 'student', 'anon'];   // порядок выполнения (комната: преподаватель входит первым)
const ROLE_OF: Record<Role5, string | null> = { anon: null, student: 'student', parent: 'parent', teacher: 'teacher', owner: 'owner' };
const ALL5 = ['student', 'parent', 'teacher', 'owner'] as const;

/** Ячейка «анонимно»: всегда 401. */
const anon = (path: string, body?: unknown): Cell => ({ as: null, path, body, status: 401 });

function matrix(s: S): Record<string, Record<Role5, Cell>> {
  const id = s.id;
  const lA1 = s.demo.lessons.a1, lA2 = s.demo.lessons.a2, th = s.demo.lessons.thread;
  const per = '?from=2026-01-01&to=2026-12-31';
  const all200 = (path: string, who: Record<string, string>, body?: unknown) => ({
    anon: anon(path, body),
    student: { as: who.student, path, body, status: 200 }, parent: { as: who.parent, path, body, status: 200 },
    teacher: { as: who.teacher, path, body, status: 200 }, owner: { as: who.owner, path, body, status: 200 },
  });
  const W = { student: 'KidA', parent: 'ParentA', teacher: 'TeacherA', owner: 'Owner' };
  const only = (ok: Role5[], path: string, status: number, who: Partial<Record<Role5, string>> = {}, body?: unknown, denied = 403) => {
    const row: any = { anon: anon(path, body) };
    for (const r of ALL5) row[r] = { as: who[r] ?? W[r], path, body, status: ok.includes(r) ? status : denied };
    return row as Record<Role5, Cell>;
  };
  const post = (p: string) => p;   // для читаемости
  return {
    'GET /api/me': all200('/api/me', W),
    'POST /api/logout': all200(post('/api/logout'), W, {}),
    'GET /api/me/contacts': only(['student', 'parent', 'owner'], '/api/me/contacts', 200),
    'GET /api/contacts/:id': only(['owner'], `/api/contacts/${id('KidA')}`, 200),
    'GET /api/students': all200('/api/students', W),
    'GET /api/lessons': all200('/api/lessons', W),
    'POST /api/lessons': only(['teacher'], '/api/lessons', 201, {}, { starts_at: new Date(s.lessonStart + 40 * DAY).toISOString(), duration_min: 50 }),
    'POST /api/lessons/:id/enroll': {
      anon: anon(`/api/lessons/${s.lx}/enroll`, {}),
      student: { as: 'AdultD', path: `/api/lessons/${s.lx}/enroll`, body: { student_id: id('AdultD') }, status: 200 },
      parent: { as: 'ParentA', path: `/api/lessons/${s.ly}/enroll`, body: { student_id: id('KidA') }, status: 200 },
      teacher: { as: 'TeacherA', path: `/api/lessons/${s.ly}/enroll`, body: { student_id: id('KidA') }, status: 403 },
      owner: { as: 'Owner', path: `/api/lessons/${s.ly}/enroll`, body: { student_id: id('KidB') }, status: 200 },
    },
    'POST /api/lessons/:id/cancel': {
      anon: anon(`/api/lessons/${lA2}/cancel`, {}),
      student: { as: 'KidA', path: `/api/lessons/${lA2}/cancel`, body: { student_id: id('KidA') }, status: 200 },
      parent: { as: 'ParentA', path: `/api/lessons/${s.lz}/cancel`, body: { student_id: id('KidA') }, status: 200 },
      teacher: { as: 'TeacherA', path: `/api/lessons/${lA1}/cancel`, body: { student_id: id('KidA') }, status: 403 },
      owner: { as: 'Owner', path: `/api/lessons/${lA1}/cancel`, body: { student_id: id('KidB') }, status: 200 },
    },
    'GET /api/threads': all200('/api/threads', W),
    'POST /api/threads': only(['student', 'parent', 'teacher'], '/api/threads', 201, {}, { teacher_id: id('TeacherA'), student_id: id('KidA') }),   // owner: HTTP-список ролей его не содержит
    'GET /api/threads/:id': only(['student', 'parent', 'teacher'], `/api/threads/${th}`, 200),   // owner: 403 — права message.read_any нет (намеренно)
    'POST /api/threads/:id/messages': only(['student', 'parent', 'teacher'], `/api/threads/${th}/messages`, 201, {}, { body: 'See you at the lesson' }),
    'GET /api/notifications': only(['parent'], '/api/notifications', 200),
    'GET /api/consents/:id': {
      anon: anon(`/api/consents/${id('AdultD')}`),
      student: { as: 'AdultD', path: `/api/consents/${id('AdultD')}`, status: 200 },   // ученик 16+ — свои; KidA (<16) — см. extra
      parent: { as: 'ParentA', path: `/api/consents/${id('KidA')}`, status: 200 },
      teacher: { as: 'TeacherA', path: `/api/consents/${id('KidA')}`, status: 403 },
      owner: { as: 'Owner', path: `/api/consents/${id('KidA')}`, status: 200 },
    },
    'POST /api/consents/:id': only(['parent'], `/api/consents/${id('KidA')}`, 201, {}, { scope: 'lesson_recording' }),
    'POST /api/consents/:id/revoke': only(['parent'], `/api/consents/${id('KidA')}/revoke`, 200, {}, {}),
    'POST /api/erase/:id': {   // Ф25: родитель — своего ребёнка; владелец — любого ученика; ученик и преподаватель — 403 (ещё до разбора тела)
      anon: anon(`/api/erase/${id('KidB')}`, { confirm: true }),
      student: { as: 'AdultD', path: `/api/erase/${id('AdultD')}`, body: { confirm: true }, status: 403 },
      parent: { as: 'ParentA', path: `/api/erase/${id('KidA')}`, body: { confirm: true }, status: 200 },
      teacher: { as: 'TeacherA', path: `/api/erase/${id('KidA')}`, body: { confirm: true }, status: 403 },
      owner: { as: 'Owner', path: `/api/erase/${id('KidB')}`, body: { confirm: true }, status: 200 },
    },
    // Ф28: канал просьб об удалении. Фикстура start(): заявка №1 (pending_parent) на KidA. Преподаватель и (где нет роли) владелец — 403 до разбора тела.
    'POST /api/erasure-requests': {
      anon: anon('/api/erasure-requests', {}),
      student: { as: 'AdultD', path: '/api/erasure-requests', body: {}, status: 201 },                          // 18+ → владельцу
      parent: { as: 'ParentB', path: '/api/erasure-requests', body: { student_id: id('KidB') }, status: 201 },  // за своего ребёнка
      teacher: { as: 'TeacherA', path: '/api/erasure-requests', body: { student_id: id('KidA') }, status: 403 },
      owner: { as: 'Owner', path: '/api/erasure-requests', body: { student_id: id('KidA') }, status: 403 },
    },
    'GET /api/erasure-requests': only(['student', 'parent'], '/api/erasure-requests', 200),
    'POST /api/erasure-requests/:id/parent-confirm': only(['parent'], '/api/erasure-requests/1/parent-confirm', 200, {}, {}),
    'POST /api/erasure-requests/:id/parent-reject': only(['parent'], '/api/erasure-requests/1/parent-reject', 200, {}, {}),
    'GET /api/owner/erasure-requests': only(['owner'], '/api/owner/erasure-requests', 200),
    'POST /api/owner/erasure-requests/:id/decision': only(['owner'], '/api/owner/erasure-requests/1/decision', 200, {}, { decision: 'reject', identity_checked: false, note: 'other' }),
    'GET /api/export/:id': {
      anon: anon(`/api/export/${id('AdultD')}`),
      student: { as: 'AdultD', path: `/api/export/${id('AdultD')}`, status: 200 },
      parent: { as: 'ParentA', path: `/api/export/${id('KidA')}`, status: 200 },
      teacher: { as: 'TeacherA', path: `/api/export/${id('KidA')}`, status: 403 },
      owner: { as: 'Owner', path: `/api/export/${id('KidA')}`, status: 403 },   // data.export_any намеренно не выдано; HTTP шире, ядро отказывает
    },
    'GET /api/rooms/:id': all200(`/api/rooms/${lA1}`, W),
    'POST /api/rooms/:id/enter': all200(`/api/rooms/${lA1}/enter`, W, {}),
    'POST /api/rooms/:id/leave': all200(`/api/rooms/${lA1}/leave`, W, {}),
    'POST /api/rooms/:id/chat': only(['student', 'teacher', 'owner'], `/api/rooms/${lA1}/chat`, 201, {}, { body: 'Hello class' }),
    'POST /api/rooms/:id/call-owner': all200(`/api/rooms/${lA1}/call-owner`, W, {}),
    'POST /api/rooms/:id/recording': only(['owner'], `/api/rooms/${lA1}/recording`, 200, {}, { on: false }),
    'GET /api/rooms/:id/video': all200(`/api/rooms/${lA1}/video`, W),
    'GET /api/room-calls': only(['owner'], '/api/room-calls', 200),
    'GET /api/audit': only(['owner'], '/api/audit', 200),
    'GET /api/owner/scheduler': only(['owner'], '/api/owner/scheduler', 200),
    'GET /api/owner/dashboard': only(['owner'], `/api/owner/dashboard${per}`, 200),
    'GET /api/owner/audit': only(['owner'], '/api/owner/audit', 200),
  };
}

test('Ф23: таблица «маршрут × роль → статус» покрывает ВСЕ маршруты routeTable() и все 5 ролей', async () => {
  const probe = await start();
  const m = matrix(probe);
  const keys = routeTable().map(r => `${r.method} ${r.pattern}`).sort();
  assert.deepEqual(Object.keys(m).sort(), keys, 'таблица ячеек и routeTable() расходятся (новый/удалённый маршрут)');
  assert.equal(keys.length, 37);
  // таблица ячеек согласована со списком ролей маршрута: 403 «роль вне списка» ↔ роли нет в routeTable
  for (const r of routeTable()) {
    const row = m[`${r.method} ${r.pattern}`];
    for (const role of ALL5) {
      const inList = (r.roles as readonly string[]).includes(role);
      if (!inList) assert.equal(row[role].status, 403, `${r.method} ${r.pattern} ${role}: вне списка ролей должен быть 403`);
    }
    assert.equal(row.anon.status, 401);
  }
});

// Каждый маршрут — на СВЕЖЕМ сервере и базе (запросы изменяют состояние, ячейки не мешают друг другу).
for (const key of Object.keys(matrix({ id: () => 1, demo: { lessons: { a1: 1, a2: 2, thread: 1 } }, lx: 1, ly: 2, lz: 3, lessonStart: 0 } as unknown as S))) {
  test(`Ф23 матрица: ${key} × (аноним, ученик, родитель, преподаватель, владелец)`, async () => {
    const s = await start();
    await s.loginAs('Owner', 'TeacherA', 'ParentA', 'ParentB', 'KidA', 'AdultD');
    const row = matrix(s)[key];
    const [method, ...rest] = key.split(' ');
    void rest;
    for (const role of ORDER) {
      const c = row[role];
      const res = await s.call(c.as, method, c.path, method === 'POST' ? (c.body ?? {}) : undefined);
      assert.equal(res.status, c.status, `${key} как ${role} (${c.as ?? 'аноним'}) → ${res.status} ${res.text.slice(0, 120)}`);
    }
  });
}

// ---------- подмена id внутри разрешённой роли (IDOR): чужой объект → отказ, и ТЕМ ЖЕ кодом, что и несуществующий ----------
test('Ф23 IDOR: чужой id внутри разрешённой роли даёт отказ (согласия, экспорт, запись, ветки, комната, контакты)', async () => {
  const s = await start();
  await s.loginAs('ParentA', 'ParentB', 'ParentC', 'KidA', 'KidB', 'TeenC', 'AdultD', 'TeacherA', 'TeacherB');
  const id = s.id, { a1, b1, thread } = s.demo.lessons;
  const cases: [string, string, string, unknown, number][] = [
    // родитель B → ребёнок A
    ['ParentB', 'GET', `/api/consents/${id('KidA')}`, undefined, 403],
    ['ParentB', 'POST', `/api/consents/${id('KidA')}`, {}, 403],
    ['ParentB', 'POST', `/api/consents/${id('KidA')}/revoke`, {}, 403],
    ['ParentB', 'GET', `/api/export/${id('KidA')}`, undefined, 403],
    ['ParentB', 'POST', `/api/lessons/${s.ly}/enroll`, { student_id: id('KidA') }, 403],
    ['ParentB', 'POST', `/api/lessons/${a1}/cancel`, { student_id: id('KidA') }, 403],
    ['ParentB', 'GET', `/api/threads/${thread}`, undefined, 403],
    ['ParentB', 'POST', `/api/threads/${thread}/messages`, { body: 'hello' }, 403],
    ['ParentB', 'POST', '/api/threads', { teacher_id: id('TeacherA'), student_id: id('KidA') }, 403],
    ['ParentB', 'GET', `/api/rooms/${s.demo.lessons.a2}`, undefined, 403],   // a2: только KidA
    // ученики
    ['KidB', 'GET', `/api/consents/${id('KidA')}`, undefined, 403],
    ['KidB', 'GET', `/api/export/${id('KidA')}`, undefined, 403],
    ['KidB', 'GET', `/api/threads/${thread}`, undefined, 403],
    ['KidB', 'POST', `/api/threads/${thread}/messages`, { body: 'hello' }, 403],
    ['AdultD', 'POST', `/api/lessons/${s.lx}/enroll`, { student_id: id('KidA') }, 403],
    ['AdultD', 'POST', `/api/lessons/${a1}/cancel`, { student_id: id('KidA') }, 403],
    ['AdultD', 'GET', `/api/consents/${id('KidA')}`, undefined, 403],
    ['AdultD', 'GET', `/api/export/${id('KidA')}`, undefined, 403],
    ['AdultD', 'GET', `/api/rooms/${a1}`, undefined, 403],
    ['AdultD', 'GET', `/api/rooms/${a1}/video`, undefined, 403],
    ['KidA', 'GET', `/api/rooms/${b1}`, undefined, 403],
    ['KidA', 'GET', `/api/consents/${id('KidA')}`, undefined, 403],   // до 16 лет — только через родителя
    ['KidA', 'GET', `/api/export/${id('KidA')}`, undefined, 403],     // то же
    ['KidA', 'POST', `/api/lessons/${s.ly}/enroll`, { student_id: id('KidA') }, 403],   // до 16 сам не записывается
    ['TeenC', 'GET', `/api/rooms/${a1}`, undefined, 403],
    ['TeenC', 'POST', `/api/rooms/${a1}/chat`, { body: 'hi' }, 403],
    ['KidA', 'GET', `/api/contacts/${id('ParentA')}`, undefined, 403],
    ['KidA', 'GET', `/api/contacts/${id('KidA')}`, undefined, 403],
    ['ParentA', 'GET', `/api/contacts/${id('KidA')}`, undefined, 403],
    ['ParentC', 'GET', `/api/rooms/${a1}`, undefined, 403],
    ['ParentC', 'POST', `/api/rooms/${a1}/call-owner`, {}, 403],
    ['ParentC', 'GET', `/api/consents/${id('KidA')}`, undefined, 403],
    // преподаватель B → всё от преподавателя A
    ['TeacherB', 'GET', `/api/rooms/${a1}`, undefined, 403],
    ['TeacherB', 'POST', `/api/rooms/${a1}/enter`, {}, 403],
    ['TeacherB', 'POST', `/api/rooms/${a1}/chat`, { body: 'hi' }, 403],
    ['TeacherB', 'POST', `/api/rooms/${a1}/call-owner`, {}, 403],
    ['TeacherB', 'GET', `/api/rooms/${a1}/video`, undefined, 403],
    ['TeacherB', 'GET', `/api/threads/${thread}`, undefined, 403],
    ['TeacherB', 'POST', `/api/threads/${thread}/messages`, { body: 'hi' }, 403],
    ['TeacherB', 'POST', '/api/threads', { teacher_id: id('TeacherA'), student_id: id('KidA') }, 403],
    ['TeacherA', 'POST', '/api/threads', { teacher_id: id('TeacherA'), student_id: id('TeenC') }, 403],   // ученик не его
    // несуществующие id отвечают так же, как чужие (нет оракула существования)
    ['TeacherA', 'GET', '/api/rooms/999999', undefined, 403],
    ['KidA', 'GET', '/api/rooms/999999', undefined, 403],
    ['ParentA', 'GET', '/api/threads/999999', undefined, 403],
    ['ParentA', 'GET', '/api/consents/999999', undefined, 403],
    ['AdultD', 'GET', '/api/export/999999', undefined, 403],
  ];
  for (const [who, method, path, body, status] of cases) {
    const r = await s.call(who, method, path, method === 'POST' ? (body ?? {}) : undefined);
    assert.equal(r.status, status, `${who} ${method} ${path} → ${r.status} ${r.text.slice(0, 100)}`);
    assert.ok(!/stack|\bat \w+.*\.ts/.test(r.text), 'в отказе нет стека');
  }
  // побочных эффектов нет: чужие записи на месте, согласия не отозваны
  const act = (s.db.prepare(`SELECT COUNT(*) c FROM lesson_enrollments WHERE student_id = ? AND status = 'active'`).get(id('KidA')) as { c: number }).c;
  assert.equal(act, 3, 'записи KidA не тронуты');
  const rev = (s.db.prepare('SELECT COUNT(*) c FROM parental_consents WHERE revoked_at IS NOT NULL').get() as { c: number }).c;
  assert.equal(rev, 0, 'согласия не отозваны чужим родителем');
});

// ---------- роль вне списка — 403 ещё ДО разбора тела; неизвестный путь под сессией — 403 ----------
test('Ф23: запрещённый маршрут отвечает 403 без разбора тела; неизвестные пути и методы — 403 (deny by default)', async () => {
  const s = await start();
  await s.loginAs('KidA', 'TeacherA', 'Owner');
  assert.equal((await s.call('KidA', 'POST', '/api/lessons', { starts_at: 'x'.repeat(5000) })).status, 403);
  assert.equal((await s.call('TeacherA', 'POST', '/api/consents/1', { scope: 'nonsense' })).status, 403);
  for (const who of ['KidA', 'TeacherA', 'Owner'])
    for (const [m, p] of [['GET', '/api/nope'], ['DELETE', '/api/me'], ['PUT', '/api/lessons'], ['PATCH', '/api/students'], ['GET', '/api/owner'], ['GET', '/api/threads/abc'], ['GET', '/api/rooms/1/chat']] as const)
      assert.equal((await s.call(who, m, p, m === 'GET' ? undefined : {})).status, 403, `${who} ${m} ${p}`);
  // вход и healthz — единственные публичные
  assert.equal((await s.call(null, 'GET', '/healthz')).status, 200);
  assert.equal((await s.call(null, 'POST', '/api/login', { login: 'nobody', password: 'x' })).status, 401);
  assert.equal((await s.call(null, 'GET', '/api/login')).status, 401);   // GET на вход — не вход: сессии нет
  assert.equal((await s.call(null, 'GET', '/other')).status, 404);
});

// ---------- содержимое ответов: контакты, чужие ученики, родители ----------
const wordRe = (w: string) => new RegExp(`(?<![\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`, 'u');
/** Сценарий для обхода: все участвуют в комнате урока a1, пишут в чат и ветку; затем каждая роль обходит ВСЕ GET-маршруты. */
async function populated() {
  const s = await start();
  await s.loginAs('Owner', 'TeacherA', 'TeacherB', 'ParentA', 'ParentB', 'ParentC', 'KidA', 'KidB', 'TeenC', 'AdultD');
  const { a1, thread } = s.demo.lessons;
  for (const k of ['TeacherA', 'ParentA', 'ParentB', 'KidA', 'KidB', 'Owner']) {
    const r = await s.call(k, 'POST', `/api/rooms/${a1}/enter`, {});
    assert.equal(r.status, 200, `enter ${k}`);
  }
  assert.equal((await s.call('KidA', 'POST', `/api/rooms/${a1}/chat`, { body: 'Hello from Kai' })).status, 201);
  assert.equal((await s.call('KidB', 'POST', `/api/rooms/${a1}/chat`, { body: 'Hello from Kira' })).status, 201);
  assert.equal((await s.call('TeacherA', 'POST', `/api/rooms/${a1}/chat`, { body: 'Welcome everyone' })).status, 201);
  assert.equal((await s.call('ParentA', 'POST', `/api/threads/${thread}/messages`, { body: 'Thanks again' })).status, 201);
  return s;
}
const GETS = (s: S) => [
  '/api/me', '/api/me/contacts', '/api/students', '/api/lessons', '/api/threads', `/api/threads/${s.demo.lessons.thread}`, '/api/notifications',
  `/api/consents/${s.id('KidA')}`, `/api/export/${s.id('KidA')}`, `/api/rooms/${s.demo.lessons.a1}`, `/api/rooms/${s.demo.lessons.a1}/video`,
  `/api/contacts/${s.id('KidA')}`, `/api/contacts/${s.id('ParentA')}`,
];
async function sweep(s: S, who: string) {
  const out: { path: string; res: Res }[] = [];
  for (const p of GETS(s)) out.push({ path: p, res: await s.call(who, 'GET', p) });
  return out;
}
const allContacts = (s: S) => Object.values(s.demo.users).flatMap(u => [u.email, u.phone, u.phone.replace(/ /g, ''), u.phone.replace(/\D/g, '')]);

test('Ф23 изоляция: ПРЕПОДАВАТЕЛЬ — ни одного контакта; только ученики своих уроков; родители без имени и id', async () => {
  const s = await populated();
  const text: string[] = [];
  for (const who of ['TeacherA', 'TeacherB']) for (const x of await sweep(s, who)) text.push(x.res.text);
  // + изменяющие маршруты преподавателя (успехи и отказы)
  text.push((await s.call('TeacherA', 'POST', '/api/threads', { teacher_id: s.id('TeacherA'), student_id: s.id('KidA') })).text);
  text.push((await s.call('TeacherA', 'POST', `/api/rooms/${s.demo.lessons.a1}/call-owner`, {})).text);
  text.push((await s.call('TeacherA', 'GET', `/api/contacts/${s.id('KidA')}`)).text);
  text.push((await s.call('TeacherA', 'GET', '/api/me/contacts')).text);
  const dumpA = text.join('\n').toLowerCase();
  for (const c of allContacts(s)) assert.ok(!dumpA.includes(c.toLowerCase()), `у преподавателя утёк контакт ${c}`);
  assert.ok(!dumpA.includes('example.test'));
  // преподаватель A: ученики только своего урока a1 (Kai, Kira); чужие ученики (Tess, Dan) — нет
  const A = await sweep(s, 'TeacherA');
  const stu = A.find(x => x.path === '/api/students')!.res.json.students as { id: number; display_name: string; level: string }[];
  assert.deepEqual(stu.map(x => x.display_name).sort(), ['Kai', 'Kira']);
  for (const x of stu) assert.deepEqual(Object.keys(x).sort(), ['display_name', 'id', 'level']);
  const lessons = A.find(x => x.path === '/api/lessons')!.res.json.lessons as any[];
  assert.ok(lessons.every(l => l.teacher_id === s.id('TeacherA')), 'уроки только свои');
  for (const l of lessons) for (const st of l.students) assert.deepEqual(Object.keys(st).sort(), ['display_name', 'id', 'level']);
  const dump = A.map(x => x.res.text).join('\n');
  for (const n of ['Tess', 'Dan', 'Tom']) assert.ok(!wordRe(n).test(dump), `преподаватель A видит чужого: ${n}`);
  // родители: ни имён, ни id в ветке и в комнате
  for (const n of ['Paula', 'Pavel', 'Petra']) assert.ok(!wordRe(n).test(dump), `преподаватель видит имя родителя ${n}`);
  const thr = A.find(x => x.path === `/api/threads/${s.demo.lessons.thread}`)!.res.json.posts as any[];
  assert.ok(thr.some(p => p.from_role === 'parent'), 'реплика родителя есть');
  for (const p of thr.filter(p => p.from_role === 'parent')) assert.ok(!('from_id' in p) && !('from_name' in p), 'у реплики родителя нет id/имени');
  const room = A.find(x => x.path === `/api/rooms/${s.demo.lessons.a1}`)!.res.json;
  for (const p of room.participants.filter((p: any) => p.role === 'parent')) assert.deepEqual(Object.keys(p), ['role']);
  const parentIds = [s.id('ParentA'), s.id('ParentB'), s.id('ParentC')];
  assert.ok(!room.participants.some((p: any) => parentIds.includes(p.id)), 'id родителей в комнате не отдаются');
  // преподаватель B: у него только ученики b1 (Tess, Kira) и b2 (Dan); Kai (урок преподавателя A) — нет
  const B = await sweep(s, 'TeacherB');
  const sb = (B.find(x => x.path === '/api/students')!.res.json.students as any[]).map(x => x.display_name).sort();
  assert.deepEqual(sb, ['Dan', 'Kira', 'Tess']);
  assert.ok(!wordRe('Kai').test(B.map(x => x.res.text).join('\n')), 'преподаватель B видит Kai');
});

test('Ф23 изоляция: после окна доступа (конец + 2 ч) преподаватель не видит и своих учеников', async () => {
  const s = await populated();
  s.clock.t = s.lessonStart + 50 * MIN + 2 * 3_600_000 + MIN;   // окно закрылось
  await s.loginAs('TeacherA');
  const st = await s.call('TeacherA', 'GET', '/api/students');
  // a2 (через 2 дня) ещё в будущем — окно открыто для её ученика Kai; Kira была только в a1 → пропала
  assert.deepEqual((st.json.students as any[]).map(x => x.display_name), ['Kai']);
  const ls = await s.call('TeacherA', 'GET', '/api/lessons');
  const a1 = (ls.json.lessons as any[]).find(l => l.id === s.demo.lessons.a1);
  assert.deepEqual(a1.students, [], 'учеников закрытого окна в списке урока нет');
  assert.equal((await s.call('TeacherA', 'GET', `/api/threads/${s.demo.lessons.thread}`)).status, 200, 'ветка Kai жива: a2 впереди');
  await s.call('Owner', 'POST', `/api/lessons/${s.demo.lessons.a2}/cancel`, { student_id: s.id('KidA') });
  await s.call('Owner', 'POST', `/api/lessons/${s.lz}/cancel`, { student_id: s.id('KidA') });
  assert.deepEqual((await s.call('TeacherA', 'GET', '/api/students')).json.students, [], 'ни одного ученика вне окна');
  assert.equal((await s.call('TeacherA', 'GET', `/api/threads/${s.demo.lessons.thread}`)).status, 403, 'ветка закрыта вместе с записью');
});

test('Ф23 изоляция: УЧЕНИК — не видит чужих учеников, родителей других, чужие реплики; чужих контактов нет', async () => {
  const s = await populated();
  const contactsOf = (k: string) => { const u = s.demo.users[k]; return [u.email, u.phone, u.phone.replace(/ /g, ''), u.phone.replace(/\D/g, '')]; };
  for (const [who, others] of [['KidA', ['Kira', 'Tess', 'Dan', 'Pavel', 'Petra', 'Tom']], ['AdultD', ['Kai', 'Kira', 'Tess', 'Paula', 'Pavel', 'Petra', 'Tina']], ['KidB', ['Kai', 'Tess', 'Dan', 'Paula', 'Petra']]] as const) {
    const out = await sweep(s, who);
    const dump = out.map(x => x.res.text).join('\n');
    for (const n of others) assert.ok(!wordRe(n).test(dump), `${who} видит чужого: ${n}`);
    // чужие контакты — нигде; свои — только на /api/me/contacts и в своей выгрузке
    const foreign = Object.keys(s.demo.users).filter(k => k !== who).flatMap(contactsOf);
    for (const c of foreign) assert.ok(!dump.toLowerCase().includes(c.toLowerCase()), `${who}: чужой контакт ${c}`);
    const st = out.find(x => x.path === '/api/students')!.res.json.students as any[];
    assert.deepEqual(st.map(x => x.id), [s.id(who)], `${who}: в списке учеников только он сам`);
    for (const l of out.find(x => x.path === '/api/lessons')!.res.json.lessons as any[]) assert.ok(l.students.every((x: any) => x.id === s.id(who)));
  }
  // комната: ученик видит себя, преподавателя, владельца; чужие реплики детей — нет
  const room = (await s.call('KidA', 'GET', `/api/rooms/${s.demo.lessons.a1}`)).json;
  assert.ok(room.participants.every((p: any) => p.id === s.id('KidA') || p.role === 'teacher' || p.role === 'owner'));
  assert.ok(room.messages.every((m: any) => m.from_id === s.id('KidA') || m.from_role === 'teacher' || m.from_role === 'owner'));
  assert.ok(!room.messages.some((m: any) => /Kira/.test(m.body + m.from_name)));
  // чужая комната, чужие согласия/выгрузка/ветка — отказ
  assert.equal((await s.call('KidB', 'GET', `/api/threads/${s.demo.lessons.thread}`)).status, 403);
});

test('Ф23 изоляция: РОДИТЕЛЬ — видит только своего ребёнка; нет чужих детей, родителей, контактов; в 18 лет ребёнок пропадает', async () => {
  const s = await populated();
  const contactsOf = (k: string) => { const u = s.demo.users[k]; return [u.email, u.phone, u.phone.replace(/ /g, ''), u.phone.replace(/\D/g, '')]; };
  for (const [who, kid, others] of [['ParentA', 'KidA', ['Kira', 'Tess', 'Dan', 'Pavel', 'Petra']], ['ParentB', 'KidB', ['Kai', 'Tess', 'Dan', 'Paula', 'Petra']], ['ParentC', 'TeenC', ['Kai', 'Kira', 'Dan', 'Paula', 'Pavel']]] as const) {
    const out = await sweep(s, who);
    const dump = out.map(x => x.res.text).join('\n');
    for (const n of others) assert.ok(!wordRe(n).test(dump), `${who} видит чужого: ${n}`);
    const foreign = Object.keys(s.demo.users).filter(k => k !== who).flatMap(contactsOf);
    for (const c of foreign) assert.ok(!dump.toLowerCase().includes(c.toLowerCase()), `${who}: чужой контакт ${c}`);   // контакты ребёнка и учителя родителю не отдаются
    const st = (out.find(x => x.path === '/api/students')!.res.json.students as any[]).map(x => x.id);
    assert.deepEqual(st, [s.id(kid)], `${who}: только свой ребёнок`);
    for (const l of out.find(x => x.path === '/api/lessons')!.res.json.lessons as any[]) assert.ok(l.students.every((x: any) => x.id === s.id(kid)), `${who}: в уроках только свой ребёнок`);
    assert.equal(out.find(x => x.path === '/api/contacts/' + s.id('KidA'))!.res.status, 403);
  }
  // граница 18 лет: ребёнок A взрослеет — родитель его больше не видит (список, уроки, согласия, выгрузка)
  s.db.prepare('UPDATE users SET birth_date = ? WHERE id = ?').run('2000-01-01', s.id('KidA'));
  assert.deepEqual((await s.call('ParentA', 'GET', '/api/students')).json.students, []);
  assert.deepEqual((await s.call('ParentA', 'GET', '/api/lessons')).json.lessons, []);
  assert.equal((await s.call('ParentA', 'GET', `/api/consents/${s.id('KidA')}`)).status, 403);
  assert.equal((await s.call('ParentA', 'GET', `/api/export/${s.id('KidA')}`)).status, 403);
  assert.equal((await s.call('ParentA', 'GET', `/api/rooms/${s.demo.lessons.a1}`)).status, 403);
});

test('Ф23 изоляция: ВЛАДЕЛЕЦ — чужие контакты только по /api/contacts/:id; личные ветки и выгрузка ему закрыты; ответы без hash/token', async () => {
  const s = await populated();
  const own = await sweep(s, 'Owner');
  const byPath = (p: string) => own.find(x => x.path === p)!.res;
  assert.equal(byPath(`/api/contacts/${s.id('KidA')}`).json.email, 'kida@example.test');
  assert.equal(byPath(`/api/threads/${s.demo.lessons.thread}`).status, 403, 'владелец не читает личную переписку');
  assert.deepEqual(byPath('/api/threads').json.threads, []);
  assert.equal(byPath(`/api/export/${s.id('KidA')}`).status, 403);
  assert.ok(!/Thanks again|Please bring/.test(own.map(x => x.res.text).join('\n')), 'текстов личных веток у владельца нет');
  const whole = own.map(x => x.res.text).join('\n') + (await s.call('Owner', 'GET', '/api/audit')).text;
  assert.ok(!/password|scrypt|token|hash/i.test(whole));
});
