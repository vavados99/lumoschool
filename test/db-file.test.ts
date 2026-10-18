// Ф8б: существующий файл базы открывается повторно, данные целы; файл старой версии (без отметки версии) мигрирует.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';
import { createApp, listen, COOKIE } from '../src/server.ts';

const count = (db: DatabaseSync, t: string) => Number((db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c);
const ver = (db: DatabaseSync) => Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);

test('seed в файл → openDb → сервер отвечает → повторный openDb сохраняет данные', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumo-db-'));
  const file = join(dir, 'demo.sqlite');
  try {
    const r = spawnSync(process.execPath, ['src/seed.ts'], { env: { ...process.env, DATABASE_PATH: file, LUMO_MODE: 'dev' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const m = /owner \[([^\]]+)\]/.exec(r.stdout);
    assert.ok(m, 'сид напечатал логин владельца');

    const db = openDb(file);                       // раньше падало: table users already exists
    const users = count(db, 'users'), lessons = count(db, 'lessons');
    assert.ok(users >= 10 && lessons >= 4);
    assert.equal(ver(db), 2);
    const server = createApp(db);
    const port = await listen(server, 0);
    try {
      assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
      const login = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'owner', password: m[1] }) });
      assert.equal(login.status, 200);
      const sid = /sid=([0-9a-f]+)/.exec(login.headers.get('set-cookie') ?? '')![1];
      const me = await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { cookie: `${COOKIE}=${sid}` } });
      assert.equal((await me.json() as { role: string }).role, 'owner');
    } finally { server.close(); }
    db.prepare(`INSERT INTO settings(key, value) VALUES ('probe', '1')`).run();
    db.close();

    for (let i = 0; i < 2; i++) {                  // повторные открытия: данные на месте, схема не дублируется
      const again = openDb(file);
      assert.equal(count(again, 'users'), users);
      assert.equal(count(again, 'lessons'), lessons);
      assert.equal((again.prepare(`SELECT value FROM settings WHERE key = 'probe'`).get() as { value: string }).value, '1');
      assert.equal(ver(again), 2);
      assert.equal(count(again, 'role_permissions'), count(openDb(':memory:'), 'role_permissions'), 'права не задублировались');
      again.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('файл старой версии (схема v1 без user_version) мигрирует до v2 и не теряет данные', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumo-db-'));
  const file = join(dir, 'old.sqlite');
  try {
    const old = new DatabaseSync(file);
    old.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));   // как делал старый openDb
    old.prepare(`INSERT INTO users(role, display_name) VALUES ('owner', 'Olga')`).run();
    old.close();
    const db = openDb(file);
    assert.equal(ver(db), 2);
    assert.equal(count(db, 'users'), 1);
    assert.equal((db.prepare('SELECT recording FROM lessons LIMIT 1').all() as unknown[]).length, 0, 'колонка recording есть');
    db.close();
    assert.equal(count(openDb(file), 'users'), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
