// Ф20: живой процесс. Настоящий `node src/server.ts` на временной базе: поднимается, планировщик включён,
// вход работает, SIGTERM останавливает процесс с кодом 0, порт закрывается, база цела.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';
import { seedDemo } from '../src/seed.ts';

const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer(); s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

test('Ф20: живой сервер — старт с планировщиком, вход, аккуратная остановка по SIGTERM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumo-f20-'));
  const dbPath = join(dir, 'live.sqlite');
  try {
    const d = openDb(dbPath); seedDemo(d); d.close();
    const port = await freePort();
    const env = { ...process.env, LUMO_MODE: 'dev', DATABASE_PATH: dbPath, PORT: String(port), SESSION_SECRET: randomBytes(32).toString('hex') };
    delete (env as Record<string, string | undefined>).SCHEDULER;
    const child = spawn(process.execPath, ['src/server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { out += c; });
    const exited = new Promise<{ code: number | null; signal: string | null }>(r => child.once('exit', (code, signal) => r({ code, signal })));
    const deadline = Date.now() + 15_000;
    while (!/scheduler: on/.test(out) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    try {
      assert.match(out, /listening on 127\.0\.0\.1:/);
      assert.match(out, /scheduler: on/);
      const r = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'owner', password: 'demo-password-001' }) });
      assert.equal(r.status, 200);
      assert.equal(((await r.json()) as { role: string }).role, 'owner');
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/me`)).status, 401);
    } finally { child.kill('SIGTERM'); }
    const res = await Promise.race([exited, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('сервер не остановился за 10 с после SIGTERM')), 10_000).unref())]);
    assert.deepEqual(res, { code: 0, signal: null });
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/me`));   // порт закрыт
    const chk = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal((chk.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    chk.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
