// Ф21: слабые места Ф20. (1) остановка с дожиданием запросов в полёте; (2) «живость» планировщика; (3) как считается лимит частоты (29 vs 31).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect, createServer as netServer } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.ts';
import { seedDemo, type Demo } from '../src/seed.ts';
import { createApp, listen, stopGracefully, COOKIE } from '../src/server.ts';
import { createScheduler } from '../src/scheduler.ts';
import { loadConfig, ConfigError } from '../src/config.ts';

const servers: Server[] = [];
after(() => { for (const x of servers) { x.closeAllConnections(); x.close(); } });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Медленный запрос: заголовки + половина тела сейчас, остаток — по команде. Ответ читаем до закрытия сокета. */
function slowLogin(port: number, login: string, password: string) {
  const body = JSON.stringify({ login, password });
  const half = Math.floor(body.length / 2);
  const sock = connect(port, '127.0.0.1');
  let data = '';
  const done = new Promise<string>(res => { sock.on('data', c => { data += c; }); sock.on('close', () => res(data)); sock.on('error', () => res(data)); });
  sock.write(`POST /api/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body.slice(0, half)}`);
  return { finish: () => sock.write(body.slice(half)), done };
}

test('Ф21-1: остановка дожидается запроса в полёте — он получает полный ответ; новые соединения после остановки не принимаются; база закрывается после', async () => {
  const db = openDb(':memory:'); const demo: Demo = seedDemo(db);
  const server = createApp(db); servers.push(server);
  const port = await listen(server, 0);
  const u = demo.users.ParentA;
  const slow = slowLogin(port, u.login, u.password);
  await sleep(150);   // запрос принят сервером, тело не дочитано
  let stopped = false;
  const stop = stopGracefully(server, 5000).then(r => { stopped = true; return r; });
  await sleep(150);
  assert.equal(stopped, false, 'остановка обязана ждать запрос в полёте');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`), 'новое соединение после начала остановки не принимается');
  slow.finish();
  const resp = await slow.done;
  assert.match(resp, /^HTTP\/1\.1 200 /, resp.slice(0, 200));
  assert.match(resp, /"role":"parent"/);   // ответ полный, а не оборванный
  const r = await stop;
  assert.deepEqual(r, { forced: false });
  db.close();   // база закрывается только после дожидания
});

test('Ф21-1: запрос, не успевший за предельное время, обрывается — остановка не висит вечно', async () => {
  const db = openDb(':memory:'); seedDemo(db);
  const server = createApp(db); servers.push(server);
  const port = await listen(server, 0);
  const slow = slowLogin(port, 'x', 'y');   // тело никогда не дочитаем
  await sleep(100);
  const t0 = Date.now();
  const r = await stopGracefully(server, 300);
  assert.equal(r.forced, true);
  assert.ok(Date.now() - t0 < 3000);
  await slow.done;
});

test('Ф21-1: SHUTDOWN_TIMEOUT_MS настраивается и проверяется', () => {
  assert.equal(loadConfig({ LUMO_MODE: 'dev' }).shutdownTimeoutMs, 10_000);
  assert.equal(loadConfig({ LUMO_MODE: 'dev', SHUTDOWN_TIMEOUT_MS: '2500' }).shutdownTimeoutMs, 2500);
  assert.throws(() => loadConfig({ LUMO_MODE: 'dev', SHUTDOWN_TIMEOUT_MS: '5' }), ConfigError);
  assert.throws(() => loadConfig({ LUMO_MODE: 'dev', SHUTDOWN_TIMEOUT_MS: 'abc' }), ConfigError);
});

const freePort = () => new Promise<number>((res, rej) => {
  const s = netServer(); s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

test('Ф21-1: живой процесс — SIGTERM при запросе в полёте: запрос получает полный ответ, процесс выходит с кодом 0, база цела', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumo-f21-'));
  const dbPath = join(dir, 'live.sqlite');
  try {
    const d = openDb(dbPath); seedDemo(d); d.close();
    const port = await freePort();
    const env = { ...process.env, LUMO_MODE: 'dev', DATABASE_PATH: dbPath, PORT: String(port), SESSION_SECRET: randomBytes(32).toString('hex'), SHUTDOWN_TIMEOUT_MS: '8000' };
    const child = spawn(process.execPath, ['src/server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { out += c; });
    const exited = new Promise<{ code: number | null; signal: string | null }>(r => child.once('exit', (code, signal) => r({ code, signal })));
    const dl = Date.now() + 15_000;
    while (!/scheduler: on/.test(out) && Date.now() < dl) await sleep(50);
    const slow = slowLogin(port, 'owner', 'demo-password-001');
    await sleep(200);
    child.kill('SIGTERM');
    await sleep(300);
    const early = await Promise.race([exited.then(() => 'exited'), sleep(100).then(() => 'alive')]);
    assert.equal(early, 'alive', 'процесс не должен выйти, пока запрос в полёте');
    slow.finish();
    const resp = await slow.done;
    assert.match(resp, /^HTTP\/1\.1 200 /);
    assert.match(resp, /"role":"owner"/);
    const res = await Promise.race([exited, sleep(10_000).then(() => { throw new Error('не вышел'); })]);
    assert.deepEqual(res, { code: 0, signal: null });
    const { DatabaseSync } = await import('node:sqlite');
    const chk = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal((chk.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    // вход, начатый в полёте, записал сессию до закрытия базы
    assert.ok((chk.prepare('SELECT COUNT(*) n FROM sessions').get() as { n: number }).n >= 1);
    chk.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- (2) «живость» планировщика ----------
test('Ф21-2: планировщик помнит последний успешный тик по задаче; сбой его не двигает; ошибка текстом не хранится', async () => {
  let t = 1000; let fail = false;
  const s = createScheduler([
    { name: 'outbox', intervalMs: 10_000, run: () => { /* ok */ } },
    { name: 'backup', intervalMs: 10_000, run: () => { if (fail) throw new TypeError('secret+79990001122'); } },
  ], { now: () => t, timers: { setInterval: () => 0, clearInterval: () => {} } });
  let h = s.health();
  assert.equal(h.outbox.lastOkAt, null); assert.equal(h.backup.lastEvent, null);   // до первого тика — пусто
  await s.tick('outbox'); await s.tick('backup');
  t = 2000; await s.tick('outbox');
  t = 3000; fail = true; await s.tick('backup');
  h = s.health();
  assert.equal(h.outbox.lastOkAt, 2000); assert.equal(h.outbox.okCount, 2);
  assert.equal(h.backup.lastOkAt, 1000, 'сбой не должен обновлять время последнего успеха');
  assert.equal(h.backup.lastEvent, 'failed'); assert.equal(h.backup.lastEventAt, 3000); assert.equal(h.backup.failCount, 1);
  assert.ok(!JSON.stringify(h).includes('79990001122') && !JSON.stringify(h).includes('secret'));
});

test('Ф21-2: GET /api/owner/scheduler — только владелец; тики не пишут в журнал действий; в ответе нет данных пользователей', async () => {
  const db = openDb(':memory:'); const demo = seedDemo(db);
  let t = 5000;
  const s = createScheduler([{ name: 'outbox', intervalMs: 10_000, run: () => {} }, { name: 'cleanup', intervalMs: 10_000, run: () => {} }],
    { now: () => t, timers: { setInterval: () => 0, clearInterval: () => {} } });
  const server = createApp(db, { schedulerHealth: () => s.health() }); servers.push(server);
  const port = await listen(server, 0); const base = `http://127.0.0.1:${port}`;
  const sid: Record<string, string> = {};
  for (const k of ['Owner', 'TeacherA', 'ParentA', 'KidA'] as const) {
    const u = demo.users[k];
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: u.login, password: u.password }) });
    assert.equal(r.status, 200, k); sid[k] = /sid=([0-9a-f]+)/.exec(r.headers.get('set-cookie')!)![1];
  }
  const count = () => (db.prepare('SELECT COUNT(*) n FROM audit_log').get() as { n: number }).n;
  await s.tick('outbox'); await s.tick('cleanup'); await s.tick('outbox');
  const before = count();
  for (let i = 0; i < 5; i++) await s.tick('outbox');
  assert.equal(count(), before, 'тики планировщика не должны раздувать audit_log');
  const get = (k: string | null) => fetch(base + '/api/owner/scheduler', { headers: k ? { cookie: `${COOKIE}=${sid[k]}` } : {} });
  const ok = await get('Owner');
  assert.equal(ok.status, 200);
  const j = await ok.json() as any;
  assert.equal(j.enabled, true);
  assert.equal(j.tasks.outbox.lastOkAt, 5000); assert.equal(j.tasks.outbox.okCount, 7);
  assert.deepEqual(Object.keys(j.tasks).sort(), ['cleanup', 'outbox']);
  const text = JSON.stringify(j);
  assert.ok(!/example\.test|@|\+00 000|display_name/.test(text), 'в ответе нет данных пользователей');
  for (const k of ['TeacherA', 'ParentA', 'KidA']) assert.equal((await get(k)).status, 403, k);
  assert.equal((await get(null)).status, 401);
  assert.equal(count(), before, 'чтение «живости» журнал не пополняет');   // 403 отказы в audit не пишутся маршрутом; фиксируем фактическое
});

// ---------- (3) лимит частоты: 29 против 31 ----------
// Причина «29-го вместо 31-го» в Ф20: лимит считает ВСЕ изменяющие запросы пользователя за фиксированную минуту (POST/PUT/PATCH/DELETE),
// включая завершившиеся 403/404 и /api/logout; вход и GET не считаются, отказанные (429) — тоже. В живом прогоне до серии из 40
// запросов тот же пользователь уже сделал 2 изменяющих (по логу сценария), они и «съели» 2 из 30. Сам лимитер считает точно.
test('Ф21-3: лимит пользователя — ровно 30 прошли, 31-й → 429; вход, GET и сами 429 в счёт не идут; предыдущие изменяющие (в т.ч. 403/404) идут', async () => {
  const mk = async () => {
    const db = openDb(':memory:'); const demo = seedDemo(db);
    const server = createApp(db); servers.push(server);
    const port = await listen(server, 0); const base = `http://127.0.0.1:${port}`;
    const u = demo.users.ParentA;
    const lr = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: u.login, password: u.password }) });
    const cookie = `${COOKIE}=${/sid=([0-9a-f]+)/.exec(lr.headers.get('set-cookie')!)![1]}`;
    const post = async (path = '/api/lessons/987654/cancel') => { const r = await fetch(base + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ student_id: demo.users.KidA.id }) }); await r.text(); return r.status; };
    const get = async () => { const r = await fetch(base + '/api/me', { headers: { cookie } }); await r.text(); return r.status; };
    return { post, get, base, demo };
  };
  const firstBlock = async (post: () => Promise<number>) => { for (let i = 1; i <= 40; i++) if (await post() === 429) return i; return 0; };

  // чистый пользователь: 31-й
  const a = await mk();
  for (let i = 0; i < 20; i++) assert.equal(await a.get(), 200);                 // GET не считаются
  assert.equal(await firstBlock(a.post), 31);
  assert.equal(await a.post(), 429); assert.equal(await a.post(), 429);            // 429 не продлевает и не копится

  // два изменяющих до серии (один 403 по роли, один 404) → блок на 29-м
  const b = await mk();
  assert.equal(await b.post('/api/lessons'), 403);          // POST /api/lessons — не для родителя
  assert.equal(await b.post('/api/lessons/987654/cancel'), 404);
  assert.equal(await firstBlock(b.post), 29);

  // повторный вход — не изменяющий для лимита: серия остаётся 31-й
  const c = await mk();
  for (let i = 0; i < 3; i++) { const r = await fetch(c.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: c.demo.users.ParentB.login, password: c.demo.users.ParentB.password }) }); await r.text(); assert.equal(r.status, 200); }
  assert.equal(await firstBlock(c.post), 31);
});
