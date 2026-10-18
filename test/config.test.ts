// Ф12: конфигурация и секреты. Ключи — только из окружения; prod без нормального секрета не стартует; значения не попадают в вывод.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, assertSeedAllowed, weakSecretReason, ConfigError } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { seedDemo } from '../src/seed.ts';

// Тестовые «секреты» собираются на лету и в репозитории литералами не лежат.
const STRONG = 'Zq' + 'x7Lm3Rt9Vb2Kd8Wn5Hs4Jc6Pf1Gy0Aeu'.repeat(1) + 'Xo';
const prod = (extra: Record<string, string> = {}) => ({ LUMO_MODE: 'prod', DATABASE_PATH: '/tmp/x-lumo.sqlite', COOKIE_SECURE: '1', ...extra });
const msgOf = (f: () => unknown): string => { try { f(); } catch (e) { assert.ok(e instanceof ConfigError); return (e as Error).message; } assert.fail('ожидался отказ'); };

test('STRONG действительно проходит правила силы', () => { assert.equal(weakSecretReason(STRONG), null); });

test('prod без секрета → отказ', () => {
  assert.match(msgOf(() => loadConfig(prod())), /SESSION_SECRET is required/);
  assert.match(msgOf(() => loadConfig(prod({ SESSION_SECRET: '' }))), /SESSION_SECRET is required/);
});

test('режим не задан = prod (отказ по умолчанию)', () => {
  assert.throws(() => loadConfig({ DATABASE_PATH: '/tmp/x.sqlite', COOKIE_SECURE: '1' }), ConfigError);
});

test('prod со слабым секретом → отказ (короткий, слова-заглушки, повторы, пробелы)', () => {
  const weak = [
    'short', 'a'.repeat(31), 'a'.repeat(64), 'abababababababababababababababababab', '1234567890'.repeat(5),
    'changeme' + 'Qw8Zk2Lp9Xv3'.repeat(3), 'my-SECRET-' + 'Qw8Zk2Lp9Xv3Rt'.repeat(3), 'Test' + 'Qw8Zk2Lp9Xv3Rt'.repeat(3),
    'password' + 'Qw8Zk2Lp9Xv3Rt'.repeat(3), 'Qw8Zk2Lp9Xv3Rt Qw8Zk2Lp9Xv3Rt Qw8Zk2Lp',
    'Qw8Zk2Lp9Xv3RtYh7Bn4Mc6Jd1Gf5S',   // 30 разнообразных символов: ловит только порог длины
  ];
  for (const w of weak) {
    const m = msgOf(() => loadConfig(prod({ SESSION_SECRET: w })));
    assert.match(m, /SESSION_SECRET is too weak/, `слабый секрет принят: длина ${w.length}`);
    if (w.length >= 12) assert.ok(!m.includes(w), 'сообщение содержит секрет');   // 'short' — подстрока слова «shorter», это не утечка
  }
});

test('prod с нормальным секретом → ок; секрет не виден в JSON/inspect/строке', () => {
  const c = loadConfig(prod({ SESSION_SECRET: STRONG }));
  assert.equal(c.mode, 'prod');
  assert.equal(c.sessionSecret, STRONG);
  for (const s of [JSON.stringify(c), String(c), `${c}`, JSON.stringify(Object.entries(c))]) assert.ok(!s.includes(STRONG));
  assert.ok(!(globalThis as { process: NodeJS.Process }).process.versions.node.includes(STRONG));
});

test('dev/test без секрета → случайный, разный при двух запусках', () => {
  for (const mode of ['dev', 'test']) {
    const a = loadConfig({ LUMO_MODE: mode }), b = loadConfig({ LUMO_MODE: mode });
    assert.ok(a.sessionSecret.length >= 32);
    assert.notEqual(a.sessionSecret, b.sessionSecret);
    assert.equal(a.databasePath, ':memory:');
  }
});

test('prod: база — файл, куки Secure; формат переменных проверяется', () => {
  assert.match(msgOf(() => loadConfig({ LUMO_MODE: 'prod', SESSION_SECRET: STRONG, COOKIE_SECURE: '1' })), /DATABASE_PATH is required/);
  assert.match(msgOf(() => loadConfig(prod({ SESSION_SECRET: STRONG, DATABASE_PATH: ':memory:' }))), /must be a file/);
  assert.match(msgOf(() => loadConfig({ ...prod({ SESSION_SECRET: STRONG }), COOKIE_SECURE: '0' })), /COOKIE_SECURE=1/);
  for (const [k, v] of [['PORT', '0'], ['PORT', '70000'], ['PORT', 'abc'], ['BACKUP_KEEP', '0'], ['BACKUP_KEEP', '-3'], ['RETENTION_MESSAGE_DAYS', '1.5'], ['COOKIE_SECURE', 'yes'], ['LUMO_MODE', 'staging']])
    assert.throws(() => loadConfig({ LUMO_MODE: 'dev', [k]: v }), ConfigError, `${k}=${v}`);
  const c = loadConfig({ LUMO_MODE: 'dev', PORT: '9000', BACKUP_KEEP: '7', RETENTION_MESSAGE_DAYS: '100' });
  assert.deepEqual([c.port, c.backupKeep, c.messageRetentionDays, c.loginAttemptRetentionDays], [9000, 7, 100, null]);
});

test('seed в prod (и без заданного режима) → отказ; в dev/test разрешён', () => {
  assert.throws(() => assertSeedAllowed({ LUMO_MODE: 'prod' }), ConfigError);
  assert.throws(() => assertSeedAllowed({}), ConfigError);
  assert.doesNotThrow(() => assertSeedAllowed({ LUMO_MODE: 'dev' }));
  const old = process.env.LUMO_MODE;
  try {
    process.env.LUMO_MODE = 'prod';
    const db = openDb(':memory:');
    assert.throws(() => seedDemo(db), ConfigError);
    assert.equal((db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c, 0, 'в prod ничего не записано');
  } finally { if (old === undefined) delete process.env.LUMO_MODE; else process.env.LUMO_MODE = old; }
});

const run = (script: string, env: Record<string, string>, args: string[] = []) =>
  spawnSync(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 20000 });

test('CLI: seed в prod не запускается, пароли демо-пользователей не печатаются', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumo-cfg-'));
  try {
    const r = run('src/seed.ts', { LUMO_MODE: 'prod', DATABASE_PATH: join(dir, 'p.sqlite') });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /seed refused/);
    assert.ok(!/demo-password/.test(r.stdout + r.stderr));
    assert.deepEqual(readdirSync(dir), [], 'файл базы не создан');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: сервер в prod без/со слабым секретом не стартует; значение секрета нигде не печатается', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumo-cfg-'));
  try {
    const base = { LUMO_MODE: 'prod', DATABASE_PATH: join(dir, 'p.sqlite'), COOKIE_SECURE: '1', PORT: '38917' };
    const none = run('src/server.ts', base);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /config error: SESSION_SECRET is required/);
    const WEAKV = 'changeme-changeme-changeme-changeme-xyz';
    const weak = run('src/server.ts', { ...base, SESSION_SECRET: WEAKV });
    assert.equal(weak.status, 1);
    assert.match(weak.stderr, /too weak/);
    assert.ok(!(weak.stdout + weak.stderr).includes(WEAKV), 'слабый секрет напечатан');
    assert.deepEqual(readdirSync(dir), [], 'база не создана при отказе');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: сервер с нормальным секретом стартует, секрет не попадает в stdout/stderr, 500 и ошибки его не содержат', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumo-cfg-'));
  const port = String(39000 + Math.floor(Math.random() * 900));
  const child = spawn(process.execPath, ['src/server.ts'], {
    env: { PATH: process.env.PATH ?? '', LUMO_MODE: 'prod', DATABASE_PATH: join(dir, 'p.sqlite'), COOKIE_SECURE: '1', PORT: port, SESSION_SECRET: STRONG },
  });
  let out = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  try {
    for (let i = 0; i < 100 && !/listening/.test(out); i++) await new Promise(r => setTimeout(r, 100));
    assert.match(out, /listening on 127\.0\.0\.1:\d+ \(mode prod\)/);
    const bad = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'x', password: STRONG }) });
    const txt = await bad.text();
    assert.ok(!txt.includes(STRONG));
    await new Promise(r => setTimeout(r, 200));
    assert.ok(!out.includes(STRONG), 'секрет в логе сервера');
  } finally { child.kill(); await new Promise(r => setTimeout(r, 100)); rmSync(dir, { recursive: true, force: true }); }
});

// ---------- сторож: в src/ нет строк, похожих на ключи ----------
const SECRET_LIKE: [string, RegExp][] = [
  ['sk-…', /\bsk-(ant-)?[A-Za-z0-9_-]{16,}/],
  ['ghp_/github_pat_', /\b(ghp_|github_pat_)[A-Za-z0-9_]{16,}/],
  ['AKIA…', /AKIA[0-9A-Z]{12,}/],
  ['xox…', /\bxox[abp]-[A-Za-z0-9-]{10,}/],
  ['PEM', /-----BEGIN/],
  ['длинный hex-литерал', /['"`][0-9a-fA-F]{32,}['"`]/],
  ['длинный base64-литерал', /['"`][A-Za-z0-9+/_-]{40,}={0,2}['"`]/],
  ['присвоение секрета литералом', /\b(secret|api_?key|token|passw(or)?d)\w*\s*[:=]\s*['"`][^'"`\s$]{12,}['"`]/i],
];
/** Строки, где литерал — не секрет (пояснено): пароли выдуманных демо-пользователей. */
const ALLOWED_LINE = /demo-password-|dummy-password-for-timing/;

export function scanSource(name: string, text: string): string[] {
  const hits: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (ALLOWED_LINE.test(line)) return;
    for (const [what, re] of SECRET_LIKE) if (re.test(line)) hits.push(`${name}:${i + 1}: ${what}`);
  });
  return hits;
}

test('сторож: src/ не содержит строк, похожих на ключи', () => {
  const files = readdirSync('src').filter(f => f.endsWith('.ts'));
  assert.ok(files.length > 10);
  const hits = files.flatMap(f => scanSource(`src/${f}`, readFileSync(join('src', f), 'utf8')));
  assert.deepEqual(hits, []);
});

test('сторож действительно срабатывает на фейковых ключах (проверка самого сторожа)', () => {
  const fake = [
    `const k = '${'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2'}';`,
    `const k = "${'AK' + 'IA' + 'ABCDEFGHIJKLMNOP'}";`,
    `// ${'-----' + 'BEGIN PRIVATE KEY-----'}`,
    `const h = '${'0123456789abcdef'.repeat(2)}';`,
    `const b = '${'Zm9vYmFyYmF6'.repeat(5)}';`,
    `const password = '${'Hunter2Hunter2xx'}';`,
    `const t = '${'gh' + 'p_' + 'abcdefghijklmnopqrstuvwxyz0123'}';`,
  ];
  for (const f of fake) assert.ok(scanSource('fake.ts', f).length > 0, f.slice(0, 20));
  assert.deepEqual(scanSource('ok.ts', `const a = process.env.X; const s = 'hello';`), []);
});
