// Ф11: бэкап и восстановление НА ДЕЛЕ. Файловые базы во временной папке, выдуманные данные.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync, lstatSync, existsSync, symlinkSync, mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';
import { seedDemo } from '../src/seed.ts';
import { backupDb, BACKUP_NAME, backupName } from '../src/backup.ts';
import { restoreDb } from '../src/restore.ts';
import { createApp, listen, COOKIE } from '../src/server.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'lumo-bk-'));
const TABLES = ['users', 'contact_vault', 'students', 'teachers', 'parent_child', 'parental_consents', 'lessons', 'lesson_enrollments',
  'role_permissions', 'audit_log', 'credentials', 'sessions', 'login_attempts', 'settings', 'msg_threads', 'msg_posts', 'room_messages', 'room_presence'];

/** количество строк и контрольная сумма содержимого каждой таблицы */
function fingerprint(file: string): Record<string, string> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const out: Record<string, string> = {};
    for (const t of TABLES) {
      const rows = (db.prepare(`SELECT * FROM ${t}`).all() as object[]).map(r => JSON.stringify(r)).sort();
      out[t] = `${rows.length}:${createHash('sha256').update(rows.join('\n')).digest('hex')}`;
    }
    return out;
  } finally { db.close(); }
}
const mode = (f: string) => statSync(f).mode & 0o777;

function seeded(dir: string) {
  const file = join(dir, 'live.sqlite');
  const db = openDb(file);
  const demo = seedDemo(db);
  db.prepare(`INSERT INTO audit_log(actor_id, action, target_type, outcome) VALUES (?,?,?,?)`).run(demo.users.Owner.id, 'test.probe', 'x', 'allowed');
  return { file, db, demo };
}

test('а) копия → восстановление в новый файл → строки и контрольные суммы совпадают', () => {
  const dir = tmp();
  try {
    const { file, db } = seeded(dir);
    const { file: bk } = backupDb(db, join(dir, 'bk'));
    db.close();
    const before = fingerprint(file);
    assert.ok(Number(before.users.split(':')[0]) >= 10);
    for (const t of ['contact_vault', 'parental_consents', 'audit_log', 'credentials']) assert.ok(Number(before[t].split(':')[0]) > 0, t);
    const target = join(dir, 'restored.sqlite');
    const r = restoreDb(bk, target);
    assert.equal(r.safetyCopy, null);
    assert.deepEqual(fingerprint(target), before);
    assert.equal(mode(target), 0o600);
    // и путь к файлу как источник
    const again = backupDb(file, join(dir, 'bk2'), { now: Date.now() + 5 });
    assert.deepEqual(fingerprint(again.file), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('б) копия, снятая пока идёт запись, цела и не содержит половины транзакции', async () => {
  const dir = tmp();
  const file = join(dir, 'live.sqlite');
  openDb(file).close();
  const w = spawn(process.execPath, [join(import.meta.dirname, 'backup-writer.ts')], { env: { ...process.env, DATABASE_PATH: file }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise<void>((res, rej) => { w.stdout.once('data', () => res()); w.once('error', rej); w.once('exit', c => rej(new Error('writer exit ' + c))); });
    const sizes: number[] = [];
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 20));
      const { file: bk } = backupDb(file, join(dir, 'bk'), { now: Date.now() + i, keep: 20 });
      const db = new DatabaseSync(bk, { readOnly: true });
      assert.deepEqual((db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]).map(r => r.integrity_check), ['ok']);
      const n = Number((db.prepare(`SELECT COUNT(*) c FROM settings WHERE key LIKE 'w%'`).get() as { c: number }).c);
      const lone = db.prepare(`SELECT COUNT(*) c FROM settings s WHERE key LIKE 'w%a' AND NOT EXISTS (SELECT 1 FROM settings p WHERE p.key = substr(s.key,1,length(s.key)-1)||'b')`).get() as { c: number };
      assert.equal(n % 2, 0, 'пары целиком');
      const vers = Number((db.prepare('SELECT COUNT(DISTINCT ver) c FROM ledger').get() as { c: number }).c);
      assert.equal(vers, 1, 'ledger: все строки одной версии (снимок не рваный)');
      assert.equal(Number(lone.c), 0);
      sizes.push(n);
      db.close();
    }
    assert.ok(sizes[sizes.length - 1] > sizes[0], `запись шла во время копий: ${sizes}`);
  } finally { w.kill('SIGKILL'); await new Promise(r => setTimeout(r, 100)); rmSync(dir, { recursive: true, force: true }); }
});

test('в) повреждённая копия не восстанавливается и рабочую базу не трогает', () => {
  const dir = tmp();
  try {
    const { file, db } = seeded(dir);
    const { file: bk } = backupDb(db, join(dir, 'bk'));
    db.close();
    const liveBefore = readFileSync(file);
    const variants: Record<string, (b: Buffer) => Buffer> = {
      'середина': b => { const c = Buffer.from(b); for (let i = 0; i < 4096; i++) c[(b.length >> 1) + i] = 0xff; return c; },
      'заголовок': b => { const c = Buffer.from(b); c.fill(0x41, 0, 100); return c; },
      'обрезан': b => b.subarray(0, 5000),
      'пустой': () => Buffer.alloc(0),
    };
    for (const [name, f] of Object.entries(variants)) {
      const bad = join(dir, `bad-${name}.sqlite`);
      writeFileSync(bad, f(readFileSync(bk)));
      assert.throws(() => restoreDb(bad, file), /backup rejected/, name);
      assert.ok(readFileSync(file).equals(liveBefore), `рабочая база не изменилась (${name})`);
      assert.deepEqual(readdirSync(dir).filter(n => /restoring|pre-restore/.test(n)), [], 'мусора нет');
    }
    // порча страниц данных (не заголовка) — integrity_check должен поймать
    const c = readFileSync(bk); for (let p = 1; p < c.length / 4096; p++) c.fill(0xFF, p * 4096, p * 4096 + 8);   // заголовки страниц b-tree (кроме первой)
    const bad2 = join(dir, 'bad-pages.sqlite'); writeFileSync(bad2, c);
    assert.throws(() => restoreDb(bad2, file), /backup rejected/);
    assert.ok(readFileSync(file).equals(liveBefore));
    // чужая база без наших таблиц и неверный user_version
    const alien = join(dir, 'alien.sqlite'); const a = new DatabaseSync(alien); a.exec('CREATE TABLE t(x); PRAGMA user_version = 2'); a.close();
    assert.throws(() => restoreDb(alien, file), /missing tables/);
    const future = join(dir, 'future.sqlite'); writeFileSync(future, readFileSync(bk)); const f = new DatabaseSync(future); f.exec('PRAGMA user_version = 99'); f.close();
    assert.throws(() => restoreDb(future, file), /newer/);
    const zero = join(dir, 'zero.sqlite'); writeFileSync(zero, readFileSync(bk)); const z = new DatabaseSync(zero); z.exec('PRAGMA user_version = 0'); z.close();
    assert.throws(() => restoreDb(zero, file), /user_version/);
    assert.throws(() => restoreDb(join(dir, 'нет.sqlite'), file), /not found/);
    assert.ok(readFileSync(file).equals(liveBefore));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('в2) восстановление поверх существующей базы кладёт рядом страховку «как было», в том числе для испорченной рабочей', () => {
  const dir = tmp();
  try {
    const { file, db } = seeded(dir);
    const before = fingerprint(file);
    const { file: bk } = backupDb(db, join(dir, 'bk'));
    db.close();
    const fd = openSync(file, 'r+'); writeSync(fd, Buffer.alloc(8192, 0x41), 0, 8192, 0); closeSync(fd);   // рабочая база испорчена
    const damaged = readFileSync(file);
    const r = restoreDb(bk, file);
    assert.ok(r.safetyCopy && existsSync(r.safetyCopy));
    assert.ok(readFileSync(r.safetyCopy!).equals(damaged), 'страховка = прежние байты');
    assert.equal(mode(r.safetyCopy!), 0o600);
    // Ф26: рабочая база нечитаема → «надгробия» не получить: громкое предупреждение + одна строка в журнале; остальное как в копии
    assert.equal(r.warnings.length, 1); assert.match(r.warnings[0], /could NOT be re-erased/);
    const after = fingerprint(file);
    assert.equal(after.audit_log.split(':')[0], String(Number(before.audit_log.split(':')[0]) + 1));
    assert.equal(openDb(file).prepare(`SELECT COUNT(*) c FROM audit_log WHERE action = 'restore.tombstones_unreadable'`).get()!.c, 1);
    for (const k of Object.keys(before)) if (k !== 'audit_log') assert.equal(after[k], before[k], k);
    assert.throws(() => restoreDb(file, file), /same file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('г) ротация: удаляет только старые копии нашего шаблона, чужое не трогает', () => {
  const dir = tmp();
  try {
    const { db } = seeded(dir);
    const bk = join(dir, 'bk'); mkdirSync(bk);
    const foreign = ['notes.txt', 'lumo-backup-old.sqlite', 'lumo-backup-20200101T000000000Z.sqlite.bak', 'production.sqlite', 'xlumo-backup-20200101T000000000Z.sqlite', '.hidden'];
    for (const n of foreign) writeFileSync(join(bk, n), 'не моё');
    mkdirSync(join(bk, 'lumo-backup-20190101T000000000Z.sqlite'));            // каталог с «нашим» именем — не файл
    const outside = join(dir, 'outside.txt'); writeFileSync(outside, 'снаружи');
    symlinkSync(outside, join(bk, 'lumo-backup-20180101T000000000Z.sqlite')); // ссылка с «нашим» именем — не трогать
    const t0 = Date.UTC(2026, 0, 1);
    const made: string[] = [];
    for (let i = 0; i < 6; i++) made.push(backupDb(db, bk, { keep: 3, now: t0 + i * 86_400_000 }).file);
    const ours = readdirSync(bk).filter(n => BACKUP_NAME.test(n) && lstatSync(join(bk, n)).isFile());
    assert.deepEqual(ours.sort(), made.slice(3).map(f => f.split('/').pop()!).sort(), 'остались 3 свежих');
    for (const n of foreign) assert.equal(readFileSync(join(bk, n), 'utf8'), 'не моё', n);
    assert.ok(statSync(join(bk, 'lumo-backup-20190101T000000000Z.sqlite')).isDirectory());
    assert.equal(readFileSync(outside, 'utf8'), 'снаружи');
    assert.ok(lstatSync(join(bk, "lumo-backup-20180101T000000000Z.sqlite")).isSymbolicLink(), "ссылка цела");
    assert.match(backupName(t0), BACKUP_NAME);
    assert.equal(backupName(t0), 'lumo-backup-20260101T000000000Z.sqlite', 'UTC');
    assert.throws(() => backupDb(db, bk, { keep: 0 }), /keep/);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('д) права на копию 0600 (и каталог 0700, и страховка), даже при мягкой umask', () => {
  const dir = tmp();
  const old = process.umask(0o000);
  try {
    const { db } = seeded(dir);
    const r = backupDb(db, join(dir, 'newbk'));
    assert.equal(mode(r.file), 0o600);
    assert.equal(mode(join(dir, 'newbk')), 0o700);
    assert.deepEqual(readdirSync(join(dir, 'newbk')).filter(n => n.startsWith('.')), [], 'временных файлов не осталось');
    db.close();
    const t = join(dir, 'r.sqlite');
    restoreDb(r.file, t);
    assert.equal(mode(t), 0o600);
  } finally { process.umask(old); rmSync(dir, { recursive: true, force: true }); }
});

test('е) после восстановления сервер поднимается на восстановленной базе, роли изолированы', async () => {
  const dir = tmp();
  try {
    const { db, demo } = seeded(dir);
    const { file: bk } = backupDb(db, join(dir, 'bk'));
    db.close();
    const target = join(dir, 'restored.sqlite');
    restoreDb(bk, target);
    const rdb = openDb(target);
    const server = createApp(rdb);
    const port = await listen(server, 0);
    const base = `http://127.0.0.1:${port}`;
    const sid = async (key: string) => {
      const u = demo.users[key];
      const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: u.login, password: u.password }) });
      assert.equal(r.status, 200, `login ${key}`);
      return `${COOKIE}=${/sid=([0-9a-f]+)/.exec(r.headers.get('set-cookie') ?? '')![1]}`;
    };
    try {
      assert.equal((await fetch(`${base}/healthz`)).status, 200);
      const owner = await sid('Owner'), teacher = await sid('TeacherA');
      const me = await (await fetch(`${base}/api/me`, { headers: { cookie: teacher } })).json() as { role: string };
      assert.equal(me.role, 'teacher');
      const kid = demo.users.KidA;
      const oc = await fetch(`${base}/api/contacts/${kid.id}`, { headers: { cookie: owner } });
      assert.equal(oc.status, 200);
      assert.equal(((await oc.json()) as { email: string }).email, kid.email, 'владелец видит контакты — данные на месте');
      for (const p of [`/api/contacts/${kid.id}`, `/api/contacts/${demo.users.ParentA.id}`, '/api/me/contacts', `/api/export/${kid.id}`]) {
        assert.equal((await fetch(base + p, { headers: { cookie: teacher } })).status, 403, `преподаватель: ${p}`);
      }
      for (const p of ['/api/students', '/api/lessons', '/api/threads']) {
        const body = await (await fetch(base + p, { headers: { cookie: teacher } })).text();
        for (const u of Object.values(demo.users)) { assert.ok(!body.includes(u.email), `${p} без почты`); assert.ok(!body.includes(u.phone), `${p} без телефона`); }
      }
    } finally { server.close(); rdb.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
