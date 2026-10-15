import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.ts';
import { register, login, currentUser, logout, revokeAllSessions, hashPassword, AuthError, BAD_LOGIN, DEFAULT_TTL_MS } from '../src/auth.ts';
import { getContacts, readAudit, Denied } from '../src/access.ts';

const PW = 'correct horse 42';
const T0 = 1_800_000_000_000;
function setup() {
  const s = seed();
  register(s.db, s.ids.adultC, 'adultc', PW);
  register(s.db, s.ids.owner, 'boss', 'owner-password-1');
  return s;
}
const msg = (fn: () => unknown) => { try { fn(); } catch (e) { assert.ok(e instanceof AuthError); return e.message; } assert.fail('no throw'); };

test('пароль не хранится открытым; хеш разный для одинаковых паролей; короткий отклоняется', () => {
  const { db, ids } = setup();
  const h = (db.prepare('SELECT password_hash h FROM credentials WHERE user_id=?').get(ids.adultC) as { h: string }).h;
  assert.ok(!h.includes(PW));
  assert.match(h, /^scrypt\$\d+\$\d+\$\d+\$/);
  assert.notEqual(hashPassword(PW), hashPassword(PW));
  assert.throws(() => register(db, ids.teacherA, 'ta', 'short'), AuthError);
  assert.equal(db.prepare('SELECT 1 FROM credentials WHERE login=?').get('ta'), undefined);
});

test('верный вход даёт токен и роль из базы; неверный — отказ; одинаковая ошибка', () => {
  const { db, ids } = setup();
  const tok = login(db, 'adultc', PW, T0);
  assert.deepEqual(currentUser(db, tok, T0 + 1), { id: ids.adultC, role: 'student' });
  const e1 = msg(() => login(db, 'adultc', 'wrong password!!', T0));
  const e2 = msg(() => login(db, 'nobody', 'wrong password!!', T0));
  assert.equal(e1, BAD_LOGIN);
  assert.equal(e1, e2);
});

test('просроченная сессия не работает; срок — параметр', () => {
  const { db } = setup();
  const tok = login(db, 'adultc', PW, T0);
  assert.ok(currentUser(db, tok, T0 + DEFAULT_TTL_MS - 1));
  assert.equal(currentUser(db, tok, T0 + DEFAULT_TTL_MS + 1), null);
  const short = login(db, 'adultc', PW, T0, 1000);
  assert.equal(currentUser(db, short, T0 + 1001), null);
});

test('выход и отзыв всех сессий убивают сессии', () => {
  const { db, ids } = setup();
  const a = login(db, 'adultc', PW, T0), b = login(db, 'adultc', PW, T0);
  logout(db, a);
  assert.equal(currentUser(db, a, T0 + 1), null);
  assert.ok(currentUser(db, b, T0 + 1));
  const c = login(db, 'adultc', PW, T0);
  revokeAllSessions(db, ids.adultC);
  assert.equal(currentUser(db, b, T0 + 1), null);
  assert.equal(currentUser(db, c, T0 + 1), null);
});

test('блок после 5 неудач за 15 минут, даже с верным паролем; потом снимается', () => {
  const { db } = setup();
  for (let i = 0; i < 5; i++) msg(() => login(db, 'adultc', 'bad password!!', T0 + i));
  assert.match(msg(() => login(db, 'adultc', PW, T0 + 10)), /too many/);
  // неизвестный логин тоже блокируется одинаково
  for (let i = 0; i < 5; i++) msg(() => login(db, 'ghost', 'bad password!!', T0 + i));
  assert.match(msg(() => login(db, 'ghost', PW, T0 + 10)), /too many/);
  assert.ok(login(db, 'adultc', PW, T0 + 15 * 60 * 1000 + 10));
});

test('в базе нет сырого токена и пароля', () => {
  const { db } = setup();
  const tok = login(db, 'adultc', PW, T0);
  for (const t of ['sessions', 'credentials', 'login_attempts', 'audit_log', 'users', 'contact_vault']) {
    const dump = JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all());
    assert.ok(!dump.includes(tok), `токен в ${t}`);
    assert.ok(!dump.includes(PW), `пароль в ${t}`);
  }
  const row = db.prepare('SELECT token_hash h FROM sessions').get() as { h: string };
  assert.match(row.h, /^[0-9a-f]{64}$/);
});

test('журнал: успех и неудача записаны, без секретов', () => {
  const { db, ids } = setup();
  const tok = login(db, 'adultc', PW, T0);
  msg(() => login(db, 'adultc', 'bad password!!', T0));
  const log = readAudit(db, { id: ids.owner, role: 'owner' }) as { action: string }[];
  assert.ok(log.some(r => r.action === 'auth.login.ok'));
  assert.ok(log.some(r => r.action === 'auth.login.fail'));
  const s = JSON.stringify(log);
  assert.ok(!s.includes(tok) && !s.includes(PW) && !s.includes('bad password'));
});

test('подмена роли клиентом не повышает права', () => {
  const { db, ids } = setup();
  const tok = login(db, 'adultc', PW, T0);
  // клиент «заявляет» роль owner — currentUser принимает только токен и игнорирует всё остальное
  const fake = (currentUser as unknown as (...a: unknown[]) => unknown)(db, tok, T0 + 1, { id: ids.owner, role: 'owner' });
  assert.deepEqual(fake, { id: ids.adultC, role: 'student' });
  // выдуманный токен / id вместо токена — отказ
  assert.equal(currentUser(db, String(ids.owner), T0), null);
  assert.equal(currentUser(db, 'owner', T0), null);
  // даже если в базе роль сменили — берётся новая из БД, а не запомненная
  const actor = currentUser(db, tok, T0 + 1)!;
  assert.throws(() => getContacts(db, actor, ids.owner), Denied);
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ids.adultC);
  assert.equal(currentUser(db, tok, T0 + 1)!.role, 'owner');
});
