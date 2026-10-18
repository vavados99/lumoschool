// Ф19a: лимит частоты на изменяющие маршруты (POST/PUT/PATCH/DELETE). Список поломок для проверки силы — docs/ВОРОТА.md.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import { seedDemo, type Demo } from '../src/seed.ts';
import { createApp, listen, createRateLimiter, COOKIE, DEFAULT_RATE_USER, DEFAULT_RATE_IP } from '../src/server.ts';
import { LANGS, hasKey, t } from '../src/i18n.ts';

const servers: Server[] = [];
after(() => { for (const x of servers) x.close(); });
type Res = { status: number; text: string; json: any; headers: Headers };
const BIG = [{ windowMs: 60_000, max: 100_000 }];

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
  return { db, demo, call, loginAs };
}
// дешёвый изменяющий запрос: ответ 404, но он считается лимитом
const poke = (s: Awaited<ReturnType<typeof start>>, as: string, extra: Record<string, string> = {}) =>
  s.call(as, 'POST', '/api/lessons/987654/cancel', { student_id: s.demo.users.KidA.id }, extra);

test('Ф19a: превышение лимита пользователя → 429 error.rate_limited, Retry-After, локализация; GET не считаются', async () => {
  const s = await start({ rateLimit: { user: [{ windowMs: 60_000, max: 3 }], ip: BIG } });
  await s.loginAs('ParentA');
  for (let i = 0; i < 3; i++) assert.notEqual((await poke(s, 'ParentA')).status, 429, `запрос ${i + 1}`);
  const r = await poke(s, 'ParentA');
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'rate_limited');
  assert.ok(Number(r.headers.get('retry-after')) >= 1 && Number(r.headers.get('retry-after')) <= 60);
  // читающие маршруты лимитом не затронуты
  for (let i = 0; i < 10; i++) assert.equal((await s.call('ParentA', 'GET', '/api/me')).status, 200);
  // локализованный текст: ключ есть во всех языках и отличается от ключа
  for (const lang of LANGS) {
    assert.ok(hasKey('error.rate_limited'), lang);
    const rl = await poke(s, 'ParentA', {});
    assert.equal(rl.status, 429);
    const loc = await s.call('ParentA', 'POST', `/api/lessons/987654/cancel?lang=${lang}`, { student_id: 1 });
    assert.equal(loc.status, 429);
    assert.equal(loc.json.lang, lang);
    assert.equal(loc.json.message_localized, t(lang, 'error.rate_limited'));
    assert.notEqual(loc.json.message_localized, 'error.rate_limited');
  }
});

test('Ф19a: 429 по лимиту раньше разбора тела и роли: запрещённый по роли запрос считается; без сессии — 401 и счёт не трогает', async () => {
  const s = await start({ rateLimit: { user: [{ windowMs: 60_000, max: 2 }], ip: BIG } });
  await s.loginAs('KidA');
  assert.equal((await s.call('KidA', 'POST', '/api/lessons', { starts_at: 'x' })).status, 403);   // запрет роли, но запрос считается
  assert.equal((await s.call('KidA', 'POST', '/api/lessons', { starts_at: 'x' })).status, 403);
  assert.equal((await s.call('KidA', 'POST', '/api/lessons', { starts_at: 'x' })).status, 429);
  // без сессии — 401, счётчик не трогаем
  for (let i = 0; i < 5; i++) assert.equal((await s.call(null, 'POST', '/api/lessons', {})).status, 401);
});

test('Ф19a: работа ниже лимита по умолчанию не ломается (запись, отмена, согласие, чат, экспорт подряд)', async () => {
  const s = await start();
  const d = s.demo;
  await s.loginAs('ParentA');
  for (let i = 0; i < 6; i++) {
    const e = await s.call('ParentA', 'POST', `/api/lessons/${d.lessons.a1}/enroll`, { student_id: d.users.KidA.id });
    const c = await s.call('ParentA', 'POST', `/api/lessons/${d.lessons.a1}/cancel`, { student_id: d.users.KidA.id });
    assert.notEqual(e.status, 429); assert.notEqual(c.status, 429);
    assert.ok(e.status < 500 && c.status < 500, `итерация ${i}: ${e.status}/${c.status}`);
  }
  assert.equal((await s.call('ParentA', 'POST', `/api/consents/${d.users.KidA.id}`, { scope: 'data_processing' })).status, 201);
  assert.equal((await s.call('ParentA', 'GET', `/api/export/${d.users.KidA.id}`)).status, 200);
  // значения по умолчанию разумны: короткое окно строже длинного на единицу времени, адрес щедрее пользователя
  assert.ok(DEFAULT_RATE_USER[0].max >= 10 && DEFAULT_RATE_IP[0].max > DEFAULT_RATE_USER[0].max);
});

test('Ф19a: лимит одного пользователя не блокирует другого (даже с одного адреса)', async () => {
  const s = await start({ rateLimit: { user: [{ windowMs: 60_000, max: 2 }], ip: BIG } });
  await s.loginAs('ParentA'); await s.loginAs('ParentB'); await s.loginAs('KidA');
  for (let i = 0; i < 2; i++) await poke(s, 'ParentA');
  assert.equal((await poke(s, 'ParentA')).status, 429);
  assert.equal((await poke(s, 'ParentA')).status, 429);
  assert.notEqual((await poke(s, 'ParentB')).status, 429);
  assert.notEqual((await poke(s, 'KidA')).status, 429);
  // отказанные запросы окна не продлевают и не списывают у соседей
  assert.notEqual((await poke(s, 'ParentB')).status, 429);
  assert.equal((await poke(s, 'ParentB')).status, 429);   // у B свои 2
});

test('Ф19a: лимит по адресу общий для пользователей одного адреса; без TRUSTED_PROXY поддельный X-Forwarded-For обойти его не даёт', async () => {
  const s = await start({ rateLimit: { user: BIG, ip: [{ windowMs: 60_000, max: 3 }] } });
  await s.loginAs('ParentA'); await s.loginAs('ParentB');
  const st: number[] = [];
  for (let i = 0; i < 3; i++) st.push((await poke(s, i % 2 ? 'ParentA' : 'ParentB', { 'X-Forwarded-For': `203.0.113.${i + 1}` })).status);
  assert.ok(st.every(x => x !== 429), `первые три: ${st}`);
  // каждый раз новый «адрес» в заголовке — ключом он не служит
  for (let i = 10; i < 14; i++) assert.equal((await poke(s, 'ParentA', { 'X-Forwarded-For': `198.51.100.${i}` })).status, 429);
  // и заголовок не может «подарить» другое ведро чужому пользователю
  assert.equal((await poke(s, 'ParentB', { 'X-Forwarded-For': '192.0.2.77' })).status, 429);
});

test('Ф19a: с TRUSTED_PROXY адрес берётся из X-Forwarded-For (отдельное ведро на клиента за прокси)', async () => {
  const s = await start({ trustedProxies: ['127.0.0.1', '::1', '::ffff:127.0.0.1'], rateLimit: { user: BIG, ip: [{ windowMs: 60_000, max: 2 }] } });
  await s.loginAs('ParentA');
  for (let i = 0; i < 2; i++) assert.notEqual((await poke(s, 'ParentA', { 'X-Forwarded-For': '203.0.113.5' })).status, 429);
  assert.equal((await poke(s, 'ParentA', { 'X-Forwarded-For': '203.0.113.5' })).status, 429);
  assert.notEqual((await poke(s, 'ParentA', { 'X-Forwarded-For': '203.0.113.6' })).status, 429);   // другой клиент за прокси — своё ведро
});

test('Ф19a: вход имеет свою защиту и лимитом изменяющих маршрутов не режется', async () => {
  const s = await start({ loginDelayStepMs: 1, rateLimit: { user: [{ windowMs: 60_000, max: 1 }], ip: [{ windowMs: 60_000, max: 1 }] } });
  const u = s.demo.users.ParentA;
  const sts: number[] = [];
  for (let i = 0; i < 4; i++) sts.push((await s.call(null, 'POST', '/api/login', { login: u.login, password: 'wrong-password-xyz' })).status);
  assert.deepEqual(sts, [401, 401, 401, 401], 'неверные входы — 401 (не 429 лимита частоты); ограничение — задержка входа');
  await s.loginAs('ParentB');   // верный вход проходит, хотя лимит изменяющих = 1 на адрес
  assert.equal((await s.call('ParentB', 'POST', '/api/logout', {})).status, 200);
});

test('Ф19a: окно сбрасывается со временем, отказ не продлевает окно (ядро лимитера)', () => {
  const rl = createRateLimiter([{ windowMs: 1000, max: 2 }]);
  assert.equal(rl.hit('k', 0), 0); assert.equal(rl.hit('k', 100), 0);
  assert.equal(rl.hit('k', 500), 1);
  assert.equal(rl.hit('k', 900), 1);
  assert.equal(rl.hit('k', 1000), 0);   // окно открылось ровно через windowMs от первого, а не от отказов
  assert.equal(rl.hit('other', 500), 0);
  // длинное окно держит при свободном коротком
  const two = createRateLimiter([{ windowMs: 1000, max: 5 }, { windowMs: 10_000, max: 3 }]);
  assert.equal(two.hit('k', 0), 0); assert.equal(two.hit('k', 2000), 0); assert.equal(two.hit('k', 4000), 0);
  assert.ok(two.hit('k', 6000) > 0);
});
