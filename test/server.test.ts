// Ф8: веб-каркас. Реальные HTTP-запросы к серверу на случайном порту, выдуманные данные.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import { seedDemo, type Demo } from '../src/seed.ts';
import { createApp, listen, routeTable, COOKIE } from '../src/server.ts';

type Res = { status: number; text: string; json: any; headers: Headers };
const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

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
    if (body !== undefined) { headers['content-type'] ??= 'application/json'; payload = typeof body === 'string' ? body : JSON.stringify(body); }
    const r = await fetch(base + path, { method, headers, body: payload });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* не JSON */ }
    return { status: r.status, text, json, headers: r.headers };
  };
  const loginAs = async (key: string) => {
    const u = demo.users[key];
    const r = await call(null, 'POST', '/api/login', { login: u.login, password: u.password });
    assert.equal(r.status, 200, `login ${key}`);
    const m = /sid=([0-9a-f]+)/.exec(r.headers.get('set-cookie') ?? '');
    assert.ok(m, 'cookie set');
    jar[key] = m[1];
    return r;
  };
  return { db, demo, base, call, loginAs, jar, server };
}

const KEYS = ['Owner', 'TeacherA', 'TeacherB', 'ParentA', 'ParentB', 'ParentC', 'KidA', 'KidB', 'TeenC', 'AdultD'];
const subst = (pattern: string, id: number) => pattern.replace(/:id/g, String(id));

// ---------- (г) без сессии — 401 на всё, кроме входа ----------
test('(г) без сессии все /api/* кроме входа дают 401 (включая неизвестные пути и методы)', async () => {
  const s = await start();
  for (const r of routeTable()) {
    const res = await s.call(null, r.method, subst(r.pattern, 1), r.method === 'POST' ? {} : undefined);
    assert.equal(res.status, 401, `${r.method} ${r.pattern}`);
  }
  for (const [m, p] of [['GET', '/api/nope'], ['DELETE', '/api/me'], ['PUT', '/api/lessons'], ['GET', '/api/'], ['GET', '/api/me/../audit']] as const)
    assert.equal((await s.call(null, m, p)).status, 401, `${m} ${p}`);
  // вход с неверным паролем — 401, а не 200; сессия с мусорным токеном — 401
  assert.equal((await s.call(null, 'POST', '/api/login', { login: 'owner', password: 'wrong-password' })).status, 401);
  const bad = await fetch(s.base + '/api/me', { headers: { cookie: `${COOKIE}=deadbeef` } });
  assert.equal(bad.status, 401);
  assert.equal((await s.call(null, 'GET', '/api/me')).status, 401);
});

test('вход/выход: cookie HttpOnly+SameSite=Strict, /api/me, выход гасит сессию', async () => {
  const s = await start();
  const r = await s.loginAs('KidA');
  const sc = r.headers.get('set-cookie')!;
  assert.match(sc, /HttpOnly/i);
  assert.match(sc, /SameSite=Strict/i);
  assert.match(sc, /Path=\//);
  assert.deepEqual(Object.keys(r.json).sort(), ['display_name', 'id', 'role']);
  const me = await s.call('KidA', 'GET', '/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.role, 'student');
  const out = await s.call('KidA', 'POST', '/api/logout', {});
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie')!, /Max-Age=0/);
  assert.equal((await s.call('KidA', 'GET', '/api/me')).status, 401, 'старый токен мёртв');
  // Secure — когда включён флаг
  const s2 = await start({ secureCookie: true });
  assert.match((await s2.loginAs('KidA')).headers.get('set-cookie')!, /;\s*Secure/i);
});

test('роль берётся из базы: клиент не может подставить роль', async () => {
  const s = await start();
  await s.loginAs('KidA');
  const r = await s.call('KidA', 'GET', '/api/lessons', undefined, { 'x-role': 'owner' });
  assert.equal(r.status, 200);
  assert.ok(r.json.lessons.every((l: any) => l.students.every((st: any) => st.id === s.demo.users.KidA.id)));
  assert.equal((await s.call('KidA', 'GET', '/api/audit?role=owner')).status, 403);
  const login = await s.call(null, 'POST', '/api/login', { login: 'kida', password: s.demo.users.KidA.password, role: 'owner' });
  assert.equal(login.json.role, 'student');
});

// ---------- (д) чужая роль на маршруте владельца — 403 ----------
test('(д) маршруты владельца и чужие по роли дают 403', async () => {
  const s = await start();
  for (const k of KEYS) await s.loginAs(k);
  const ownerOnly = routeTable().filter(r => r.roles.length === 1 && r.roles[0] === 'owner');
  assert.ok(ownerOnly.length >= 2);
  for (const k of KEYS.filter(k => k !== 'Owner'))
    for (const r of ownerOnly) {
      const res = await s.call(k, r.method, subst(r.pattern, s.demo.users.KidA.id), r.method === 'POST' ? {} : undefined);
      assert.equal(res.status, 403, `${k} ${r.method} ${r.pattern}`);
    }
  // по ВСЕЙ таблице: роль вне списка → 403
  for (const k of KEYS) {
    const role = ({ Owner: 'owner', TeacherA: 'teacher', TeacherB: 'teacher', ParentA: 'parent', ParentB: 'parent', ParentC: 'parent' } as Record<string, string>)[k] ?? 'student';
    for (const r of routeTable().filter(r => !(r.roles as readonly string[]).includes(role))) {
      const res = await s.call(k, r.method, subst(r.pattern, 1), r.method === 'POST' ? {} : undefined);
      assert.equal(res.status, 403, `${k}(${role}) ${r.method} ${r.pattern}`);
    }
  }
  // неизвестный маршрут под сессией — тоже 403 (deny by default), не 404
  assert.equal((await s.call('Owner', 'GET', '/api/nothing-here')).status, 403);
  assert.equal((await s.call('Owner', 'DELETE', '/api/lessons')).status, 403);
  // владелец проходит
  assert.equal((await s.call('Owner', 'GET', '/api/audit')).status, 200);
  assert.equal((await s.call('Owner', 'GET', `/api/contacts/${s.demo.users.KidA.id}`)).json.email, 'kida@example.test');
});

// ---------- (а) ГЛАВНЫЙ: преподаватель не получает контактов ни в одном ответе ----------
test('(а) преподаватель: ни один ответ (успехи и ошибки) не содержит контактов seed', async () => {
  const s = await start();
  const secrets: string[] = [];
  for (const u of Object.values(s.demo.users)) {
    secrets.push(u.email.toLowerCase(), u.phone, u.phone.replace(/\D/g, ''), u.phone.replace(/ /g, ''));
    secrets.push(u.email.split('@')[0] + '@');
  }
  secrets.push('example.test', ...s.demo.surnames.map(x => x.toLowerCase()));
  const dump: string[] = [];
  const statuses: number[] = [];
  const hit = (what: string, r: Res) => {
    statuses.push(r.status);
    const hay = (r.text + ' ' + [...r.headers.entries()].filter(([k]) => k !== 'set-cookie').map(([k, v]) => k + v).join(' ')).toLowerCase();
    dump.push(`${what} → ${r.status}`);
    for (const sec of secrets) assert.ok(!hay.includes(sec.toLowerCase()), `УТЕЧКА «${sec}» в ${what}: ${r.text.slice(0, 200)}`);
  };
  const allIds = Object.values(s.demo.users).map(u => u.id);
  const lessonIds = Object.values(s.demo.lessons);

  for (const t of ['TeacherA', 'TeacherB']) {
    await s.loginAs(t);
    // 1) все маршруты × все id × GET/POST с разными телами
    const bodies: unknown[] = [{}, { student_id: s.demo.users.KidA.id, teacher_id: s.demo.users.TeacherA.id, scope: 'data_processing', body: 'hello there', starts_at: '2099-01-01T10:00:00Z' },
      { student_id: s.demo.users.AdultD.id, teacher_id: s.demo.users.TeacherB.id, body: 'Hi' }];
    for (const r of routeTable().filter(r => r.pattern !== '/api/logout')) {   // выход гасит сессию — иначе дальше всё было бы 401 и проверка пустая
      const ids = r.pattern.includes(':id') ? [...new Set([...allIds, ...lessonIds, 0, 9999])] : [0];
      for (const id of ids) {
        const path = subst(r.pattern, id);
        if (r.method === 'GET') hit(`${t} GET ${path}`, await s.call(t, 'GET', path));
        else for (const b of bodies) hit(`${t} POST ${path}`, await s.call(t, 'POST', path, b));
      }
    }
    // 2) ошибки: битый JSON, не тот тип, неизвестные пути, большое тело, чужие id
    hit(`${t} bad json`, await s.call(t, 'POST', '/api/threads', '{not json'));
    hit(`${t} wrong ctype`, await s.call(t, 'POST', '/api/threads', 'x=1', { 'content-type': 'text/plain' }));
    hit(`${t} unknown`, await s.call(t, 'GET', '/api/whatever/' + s.demo.users.ParentA.email));
    hit(`${t} big`, await s.call(t, 'POST', '/api/threads', { body: 'x'.repeat(200_000) }));
    hit(`${t} sql-ish`, await s.call(t, 'GET', "/api/threads/1'%20OR%201=1--"));
    hit(`${t} contacts via direct`, await s.call(t, 'GET', `/api/contacts/${s.demo.users.ParentA.id}`));
    hit(`${t} export parent`, await s.call(t, 'GET', `/api/export/${s.demo.users.ParentA.id}`));
    hit(`${t} message w/ contact`, await s.call(t, 'POST', `/api/threads/${s.demo.lessons.thread}/messages`, { body: `write me ${s.demo.users.ParentA.email}` }));
  }
  // обычная работа преподавателя возможна (тест не пустой): виден свой урок и ученики без контактов
  await s.loginAs('TeacherA');   // таблица маршрутов включала /api/logout
  const l = await s.call('TeacherA', 'GET', '/api/lessons');
  assert.equal(l.status, 200);
  assert.ok(l.json.lessons.length >= 2);
  assert.ok(dump.length > 100, `проверено ответов: ${dump.length}`);
  // защита от пустой проверки: среди ответов были и успешные (сессия не отвалилась), и 403, и ошибки валидации
  const cnt = (f: (x: number) => boolean) => statuses.filter(f).length;
  assert.ok(cnt(x => x === 200) >= 8, `200: ${cnt(x => x === 200)}`);
  assert.ok(cnt(x => x === 401) <= 2, `401 (протухшая сессия?): ${cnt(x => x === 401)}`);
  assert.ok(cnt(x => x === 403) > 50 && cnt(x => x === 422 || x === 409 || x === 400) > 0);
  // вход с неверным паролем и сам ответ входа
  hit('login bad', await s.call(null, 'POST', '/api/login', { login: s.demo.users.ParentA.email, password: 'x'.repeat(12) }));
  // тот же прогон «контрольный»: владелец контакты получает, значит сканер действительно умеет их находить
  await s.loginAs('Owner');
  const oc = await s.call('Owner', 'GET', `/api/contacts/${s.demo.users.ParentA.id}`);
  assert.ok(oc.text.includes('parenta@example.test'));
});

test('(а2) преподаватель: на уроке — только id/имя/уровень своих учеников; чужого урока нет', async () => {
  const s = await start();
  await s.loginAs('TeacherA');
  const r = await s.call('TeacherA', 'GET', '/api/lessons');
  const d = s.demo.users;
  assert.deepEqual(r.json.lessons.map((l: any) => l.id).sort(), [s.demo.lessons.a1, s.demo.lessons.a2].sort());
  for (const l of r.json.lessons) {
    assert.deepEqual(Object.keys(l).sort(), ['duration_min', 'id', 'starts_at', 'status', 'students', 'teacher_id', 'teacher_name']);
    for (const st of l.students) assert.deepEqual(Object.keys(st).sort(), ['display_name', 'id', 'level']);
  }
  const ids = new Set(r.json.lessons.flatMap((l: any) => l.students.map((x: any) => x.id)));
  assert.deepEqual([...ids].sort(), [d.KidA.id, d.KidB.id].sort());   // KidB ходит и к A (a1)
  assert.ok(!ids.has(d.TeenC.id) && !ids.has(d.AdultD.id), 'ученики только чужих уроков не видны');
  const st = await s.call('TeacherA', 'GET', '/api/students');
  assert.deepEqual(st.json.students.map((x: any) => x.id).sort(), [d.KidA.id, d.KidB.id].sort());
  // свои контакты и «чужие» — 403
  assert.equal((await s.call('TeacherA', 'GET', '/api/me/contacts')).status, 403);
  assert.equal((await s.call('TeacherA', 'GET', `/api/contacts/${d.KidA.id}`)).status, 403);
  // в ветке родитель показан ролью без имени
  const th = await s.call('TeacherA', 'GET', `/api/threads/${s.demo.lessons.thread}`);
  assert.equal(th.status, 200);
  const parentPost = th.json.posts.find((p: any) => p.from_role === 'parent');
  assert.ok(parentPost && !('from_name' in parentPost));
});

// ---------- (б) ученик не видит чужих ----------
test('(б) ученик не видит чужих учеников, уроки, ветки, согласия', async () => {
  const s = await start();
  const d = s.demo.users;
  for (const k of ['KidA', 'KidB', 'AdultD']) await s.loginAs(k);
  const a = await s.call('KidA', 'GET', '/api/lessons');
  assert.deepEqual(a.json.lessons.map((l: any) => l.id).sort(), [s.demo.lessons.a1, s.demo.lessons.a2].sort());
  for (const l of a.json.lessons) assert.deepEqual(l.students.map((x: any) => x.id), [d.KidA.id], 'в уроке виден только он сам, хотя там есть KidB');
  assert.deepEqual((await s.call('KidA', 'GET', '/api/students')).json.students.map((x: any) => x.id), [d.KidA.id]);
  const dd = await s.call('AdultD', 'GET', '/api/lessons');
  assert.deepEqual(dd.json.lessons.map((l: any) => l.students.map((x: any) => x.id)), [[d.AdultD.id]]);
  assert.equal(JSON.stringify([a.json, dd.json]).includes('Kira'), false);
  assert.equal((await s.call('KidA', 'GET', `/api/contacts/${d.KidB.id}`)).status, 403);
  assert.equal((await s.call('KidA', 'GET', `/api/consents/${d.KidB.id}`)).status, 403);
  assert.equal((await s.call('KidB', 'GET', `/api/threads/${s.demo.lessons.thread}`)).status, 403, 'чужая ветка');
  // запись/отмена за другого — отказ
  assert.equal((await s.call('KidA', 'POST', `/api/lessons/${s.demo.lessons.b1}/enroll`, { student_id: d.KidB.id })).status, 403);
  assert.equal((await s.call('KidA', 'POST', `/api/lessons/${s.demo.lessons.b1}/cancel`, { student_id: d.KidB.id })).status, 403);
  // свои контакты видит
  assert.equal((await s.call('AdultD', 'GET', '/api/me/contacts')).json.email, 'adultd@example.test');
});

// ---------- (в) родитель видит только своего ребёнка ----------
test('(в) родитель видит только своего ребёнка', async () => {
  const s = await start();
  const d = s.demo.users;
  for (const k of ['ParentA', 'ParentB', 'ParentC']) await s.loginAs(k);
  const a = await s.call('ParentA', 'GET', '/api/lessons');
  assert.deepEqual(a.json.lessons.map((l: any) => l.id).sort(), [s.demo.lessons.a1, s.demo.lessons.a2].sort());
  for (const l of a.json.lessons) assert.deepEqual(l.students.map((x: any) => x.id), [d.KidA.id]);
  assert.deepEqual((await s.call('ParentA', 'GET', '/api/students')).json.students.map((x: any) => x.id), [d.KidA.id]);
  const b = await s.call('ParentB', 'GET', '/api/lessons');
  assert.ok(b.json.lessons.every((l: any) => l.students.every((x: any) => x.id === d.KidB.id)));
  assert.equal(JSON.stringify(a.json).includes('Kira'), false);
  assert.equal((await s.call('ParentA', 'GET', `/api/consents/${d.KidB.id}`)).status, 403);
  assert.equal((await s.call('ParentA', 'GET', `/api/consents/${d.KidA.id}`)).status, 200);
  assert.equal((await s.call('ParentA', 'GET', `/api/export/${d.KidB.id}`)).status, 403);
  assert.equal((await s.call('ParentA', 'POST', `/api/consents/${d.KidB.id}/revoke`, {})).status, 403);
  assert.equal((await s.call('ParentA', 'POST', `/api/lessons/${s.demo.lessons.b1}/enroll`, { student_id: d.KidB.id })).status, 403);
  assert.equal((await s.call('ParentB', 'GET', `/api/threads/${s.demo.lessons.thread}`)).status, 403);
  assert.equal((await s.call('ParentA', 'GET', `/api/threads/${s.demo.lessons.thread}`)).status, 200);
  assert.equal((await s.call('ParentA', 'GET', `/api/contacts/${d.KidA.id}`)).status, 403);
  // экспорт своего ребёнка — без контактов ребёнка
  const ex = await s.call('ParentA', 'GET', `/api/export/${d.KidA.id}`);
  assert.equal(ex.status, 200);
  assert.equal(ex.json.contacts, null);
  assert.equal(ex.text.includes('kida@example.test'), false);
});

test('согласия и запись: полный сценарий родителя и отмена', async () => {
  const s = await start();
  const d = s.demo.users;
  await s.loginAs('ParentA'); await s.loginAs('TeacherA');
  const lessons = s.demo.lessons;
  const rev = await s.call('ParentA', 'POST', `/api/consents/${d.KidA.id}/revoke`, {});
  assert.equal(rev.status, 200);
  assert.equal(rev.json.cancelled, 2);
  const en = await s.call('ParentA', 'POST', `/api/lessons/${lessons.a1}/enroll`, { student_id: d.KidA.id });
  assert.equal(en.status, 403, 'без согласия запись запрещена');
  assert.equal((await s.call('ParentA', 'POST', `/api/consents/${d.KidA.id}`, {})).status, 201);
  assert.equal((await s.call('ParentA', 'POST', `/api/lessons/${lessons.a1}/enroll`, { student_id: d.KidA.id })).status, 200);
  assert.equal((await s.call('ParentA', 'POST', `/api/lessons/${lessons.a1}/cancel`, { student_id: d.KidA.id })).status, 200, 'урок через 3 дня: окно 24ч не мешает');
  assert.equal((await s.call('ParentA', 'POST', `/api/lessons/${lessons.a1}/cancel`, { student_id: d.KidA.id })).status, 409, 'повторная отмена');
});

test('преподаватель создаёт слот; сообщения и фильтр каналов', async () => {
  const s = await start();
  await s.loginAs('TeacherA'); await s.loginAs('ParentA');
  const slot = await s.call('TeacherA', 'POST', '/api/lessons', { starts_at: new Date(Date.now() + 30 * 86_400_000).toISOString(), duration_min: 50, audience: 'minor' });
  assert.equal(slot.status, 201);
  const past = await s.call('TeacherA', 'POST', '/api/lessons', { starts_at: '2001-01-01T10:00:00Z' });
  assert.equal(past.status, 409);
  assert.equal((await s.call('ParentA', 'POST', '/api/lessons', { starts_at: '2099-01-01T10:00:00Z' })).status, 403);
  const th = s.demo.lessons.thread;
  const ok = await s.call('ParentA', 'POST', `/api/threads/${th}/messages`, { body: 'See you on Monday.' });
  assert.equal(ok.status, 201);
  const leak = await s.call('TeacherA', 'POST', `/api/threads/${th}/messages`, { body: 'text me at tina@example.test' });
  assert.equal(leak.status, 422);
  const list = await s.call('TeacherA', 'GET', `/api/threads/${th}`);
  assert.equal(list.json.posts.length, 3);
  assert.equal(list.text.includes('tina@example.test'), false);
});

// ---------- (е) лимит тела ----------
test('(е) тело больше лимита отклоняется (413), и в логине тоже; в пределах лимита — принимается', async () => {
  const s = await start({ maxBody: 1024 });
  await s.loginAs('ParentA');
  const th = s.demo.lessons.thread;
  const big = await s.call('ParentA', 'POST', `/api/threads/${th}/messages`, { body: 'a'.repeat(5000) });
  assert.equal(big.status, 413);
  assert.equal(big.json.error, 'payload_too_large');
  const bigLogin = await s.call(null, 'POST', '/api/login', { login: 'x', password: 'y'.repeat(5000) });
  assert.equal(bigLogin.status, 413);
  // без Content-Length (chunked): тоже режется
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode('{"a":"' + 'z'.repeat(400) + '"}')); c.close(); } });
  const r = await fetch(s.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit).catch(() => null);
  if (r) assert.equal(r.status, 413);
  const small = await s.call('ParentA', 'POST', `/api/threads/${th}/messages`, { body: 'short' });
  assert.equal(small.status, 201);
  // проверка по умолчанию (16 КБ)
  const d = await start();
  const r2 = await d.call(null, 'POST', '/api/login', { login: 'x', password: 'y'.repeat(40_000) });
  assert.equal(r2.status, 413);
});

// ---------- (ж) нет секретных полей ----------
test('(ж) ни в одном ответе нет полей password/hash/token и значений токена/хеша', async () => {
  const s = await start();
  for (const k of KEYS) await s.loginAs(k);
  const bad = /"[^"]*(password|passwd|hash|token|secret|salt)[^"]*"\s*:/i;
  const hashes = (s.db.prepare('SELECT password_hash h FROM credentials').all() as { h: string }[]).map(r => r.h);
  const tokens = Object.values(s.jar);
  const ids = [...new Set([...Object.values(s.demo.users).map(u => u.id), ...Object.values(s.demo.lessons)])];
  let n = 0;
  for (const k of KEYS) {
    const role = ({ Owner: 'owner', TeacherA: 'teacher', TeacherB: 'teacher', ParentA: 'parent', ParentB: 'parent', ParentC: 'parent' } as Record<string, string>)[k] ?? 'student';
    for (const r of routeTable().filter(r => r.method === 'GET' && (r.roles as readonly string[]).includes(role)))
      for (const id of r.pattern.includes(':id') ? ids : [0]) {
        const res = await s.call(k, 'GET', subst(r.pattern, id));
        n++;
        assert.doesNotMatch(res.text, bad, `${k} GET ${r.pattern}`);
        for (const h of hashes) assert.ok(!res.text.includes(h));
        for (const t of tokens) assert.ok(!res.text.includes(t), 'токен в теле');
        assert.ok(!res.text.includes('scrypt$'));
      }
  }
  const lg = await s.call(null, 'POST', '/api/login', { login: 'owner', password: s.demo.users.Owner.password });
  assert.doesNotMatch(lg.text, bad);
  assert.ok(!lg.text.includes(s.jar.Owner));
  assert.ok(n > 80, `GET-ответов проверено: ${n}`);
});

// ---------- (з) ошибки без стека ----------
test('(з) ошибки без стека и внутренностей; заголовки безопасности и no-store', async () => {
  const s = await start();
  await s.loginAs('KidA');
  const errs: Res[] = [
    await s.call(null, 'GET', '/api/me'),
    await s.call('KidA', 'GET', '/api/audit'),
    await s.call('KidA', 'POST', '/api/threads', '{broken'),
    await s.call('KidA', 'POST', '/api/threads', 'a=1', { 'content-type': 'text/plain' }),
    await s.call('KidA', 'POST', '/api/threads', { teacher_id: 'abc', student_id: 1 }),
    await s.call('KidA', 'POST', `/api/lessons/99999/enroll`, { student_id: s.demo.users.KidA.id }),
    await s.call('KidA', 'GET', '/api/threads/999999'),
    await s.call(null, 'POST', '/api/login', { login: 'nobody', password: 'wrong-password-1' }),
    await s.call(null, 'POST', '/api/login', { login: { $ne: 1 }, password: [] }),
    await s.call(null, 'GET', '/nonexistent'),
    await s.call('KidA', 'POST', '/api/threads/1/messages', { body: 'x'.repeat(5000) }),
  ];
  for (const r of errs) {
    assert.ok(r.status >= 400, r.text);
    assert.ok(r.json && typeof r.json.error === 'string', `JSON с error: ${r.text}`);
    assert.doesNotMatch(r.text, /\bat\s+\S+\s*\(|\.ts:\d+|node:internal|node_modules|stack|SQLITE|SELECT |INSERT |Error:|\/root\//i, r.text);
    assert.doesNotMatch(r.text, /\.permission|\.read_any|denied/i, 'имена прав не отдаём');
  }
  // одинаковый ответ на неверный пароль и неизвестный логин
  const a = await s.call(null, 'POST', '/api/login', { login: 'kida', password: 'wrong-password-1' });
  const b = await s.call(null, 'POST', '/api/login', { login: 'nobody', password: 'wrong-password-1' });
  assert.equal(a.text, b.text);
  // заголовки
  for (const r of [errs[0], errs[1], await s.call('KidA', 'GET', '/api/me'), await s.call('KidA', 'GET', '/api/lessons')]) {
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.match(r.headers.get('cache-control') ?? '', /no-store/);
    assert.match(r.headers.get('content-type') ?? '', /application\/json/);
    assert.match(r.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  }
});

test('внутренняя ошибка → 500 без деталей и без стека', async () => {
  const s = await start();
  await s.loginAs('KidA');
  s.db.exec('DROP TABLE lesson_enrollments');   // ломаем базу под сервером
  const orig = console.error; console.error = () => {};
  try {
    const r = await s.call('KidA', 'GET', '/api/lessons');
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: 'internal_error' });
  } finally { console.error = orig; }
});

test('сервер слушает только 127.0.0.1', async () => {
  const s = await start();
  const a = s.server.address() as { address: string };
  assert.equal(a.address, '127.0.0.1');
});

test('seed: все данные выдуманные (example.test, +00 000 000 NNN)', async () => {
  const s = await start();
  const rows = s.db.prepare('SELECT email, phone FROM contact_vault').all() as { email: string; phone: string }[];
  assert.equal(rows.length, 10);
  for (const r of rows) { assert.match(r.email, /^[a-z]+@example\.test$/); assert.match(r.phone, /^\+00 000 000 \d{3}$/); }
  const roles = (s.db.prepare('SELECT role, COUNT(*) c FROM users GROUP BY role').all() as { role: string; c: number }[]);
  assert.deepEqual(Object.fromEntries(roles.map(r => [r.role, r.c])), { owner: 1, teacher: 2, parent: 3, student: 4 });
});

// ---------- таблица прав маршрутов зафиксирована: расширение прав ломает тест (ядро — вторая линия, не единственная) ----------
test('таблица маршрутов и ролей совпадает с эталоном (любое расширение прав — красный тест)', () => {
  const got = routeTable().map(r => `${r.method} ${r.pattern} ${[...r.roles].sort().join(',')}`).sort();
  const ALLR = 'owner,parent,student,teacher';
  const want = [
    `GET /api/me ${ALLR}`, `POST /api/logout ${ALLR}`, 'GET /api/me/contacts owner,parent,student', 'GET /api/contacts/:id owner',
    `GET /api/students ${ALLR}`, `GET /api/lessons ${ALLR}`, 'POST /api/lessons teacher',
    'POST /api/lessons/:id/enroll owner,parent,student', 'POST /api/lessons/:id/cancel owner,parent,student',
    `GET /api/threads ${ALLR}`, 'POST /api/threads parent,student,teacher', `GET /api/threads/:id ${ALLR}`, 'POST /api/threads/:id/messages parent,student,teacher',
    'GET /api/consents/:id owner,parent,student', 'POST /api/consents/:id parent', 'POST /api/consents/:id/revoke parent',
    'GET /api/export/:id owner,parent,student', 'GET /api/audit owner',
    // Ф9: комната урока
    `GET /api/rooms/:id ${ALLR}`, `POST /api/rooms/:id/enter ${ALLR}`, `POST /api/rooms/:id/leave ${ALLR}`, `GET /api/rooms/:id/video ${ALLR}`,
    'POST /api/rooms/:id/chat owner,student,teacher', `POST /api/rooms/:id/call-owner ${ALLR}`, 'POST /api/rooms/:id/recording owner', 'GET /api/room-calls owner',
    // Ф10: дашборд и постраничный журнал владельца
    'GET /api/owner/dashboard owner', 'GET /api/owner/audit owner',
  ].sort();
  assert.deepEqual(got, want);
  // контакты — ни у одного маршрута с участием преподавателя
  for (const r of routeTable().filter(r => /contacts|export/.test(r.pattern))) assert.ok(!(r.roles as readonly string[]).includes('teacher'), r.pattern);
});
