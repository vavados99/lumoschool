// Ф5: чистка сессий, нормализация логина, блок по IP (+ по паре логин+IP).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.ts';
import {
  register, login, currentUser, purgeExpiredSessions, purgeOldAttempts, normalizeLogin, AuthError,
  MAX_FAILS, MAX_FAILS_PER_IP, WINDOW_MS, DEFAULT_TTL_MS,
} from '../src/auth.ts';
import { readAudit } from '../src/access.ts';

const PW = 'correct horse 42';
const T0 = 1_800_000_000_000;
const BAD = 'bad password!!';
const threw = (fn: () => unknown): string => { try { fn(); } catch (e) { assert.ok(e instanceof AuthError); return e.message; } assert.fail('no throw'); };
const setup = () => {
  const s = seed();
  register(s.db, s.ids.adultC, 'adultc', PW);
  register(s.db, s.ids.owner, 'boss', 'owner-password-1');
  return s;
};
const count = (db: ReturnType<typeof seed>['db'], t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;

// ---------- чистка сессий ----------
test('чистка: просроченные удаляются, живые остаются и работают, возвращается число', () => {
  const { db, ids } = setup();
  const dead1 = login(db, 'adultc', PW, T0, 1000);
  const dead2 = login(db, 'boss', 'owner-password-1', T0, 5000);
  const live = login(db, 'adultc', PW, T0, DEFAULT_TTL_MS);
  assert.equal(count(db, 'sessions'), 3);
  assert.equal(purgeExpiredSessions(db, T0 + 999), 0);            // ещё живы
  assert.equal(count(db, 'sessions'), 3);
  assert.equal(purgeExpiredSessions(db, T0 + 5000), 2);           // граница: expires_at <= now
  assert.equal(count(db, 'sessions'), 1);
  assert.equal(currentUser(db, dead1, T0 + 1), null);
  assert.equal(currentUser(db, dead2, T0 + 1), null);
  assert.deepEqual(currentUser(db, live, T0 + 6000), { id: ids.adultC, role: 'student' });
  assert.equal(purgeExpiredSessions(db, T0 + 5000), 0);           // повтор — пусто
  const log = readAudit(db, { id: ids.owner, role: 'owner' }) as { action: string }[];
  assert.ok(log.some(r => r.action === 'auth.sessions.purged'));
});

test('чистка попыток входа: старше окна удаляются, свежие остаются', () => {
  const { db } = setup();
  threw(() => login(db, 'adultc', BAD, T0));
  threw(() => login(db, 'adultc', BAD, T0 + WINDOW_MS));
  const n = purgeOldAttempts(db, T0 + WINDOW_MS + 1);
  assert.equal(n, 1);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM login_attempts WHERE ts = ?').get(T0) as { c: number }).c, 0);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM login_attempts WHERE ts = ?').get(T0 + WINDOW_MS) as { c: number }).c, 1);
});

// ---------- нормализация логина ----------
test('нормализация: trim + lowercase + NFKC при регистрации и входе', () => {
  const { db, ids } = setup();
  register(db, ids.teacherA, '  Alice\u00A0 ', PW);                 // пробелы и NBSP по краям, регистр
  assert.equal((db.prepare('SELECT login l FROM credentials WHERE user_id=?').get(ids.teacherA) as { l: string }).l, 'alice');
  for (const variant of ['alice', 'ALICE', ' Alice ', 'ａｌｉｃｅ', 'Ａlice\u3000']) {   // полноширинные, идеографический пробел
    assert.ok(login(db, variant, PW, T0), `вход как «${variant}»`);
  }
  // лигатура: NFKC 'ﬁsh' → 'fish'
  register(db, ids.teacherB, 'ﬁsh', PW);
  assert.ok(login(db, 'FISH', PW, T0));
  assert.equal(normalizeLogin('ＡＢＣ \t'), 'abc');
});

test('нормализация: дубликат по другому написанию отклоняется; пустой логин — нет', () => {
  const { db, ids } = setup();
  assert.throws(() => register(db, ids.teacherA, 'ADULTC', PW), AuthError);
  assert.throws(() => register(db, ids.teacherA, ' ａｄｕｌｔｃ ', PW), AuthError);
  assert.throws(() => register(db, ids.teacherA, '   \u3000 ', PW), AuthError);
  assert.equal(count(db, 'credentials'), 2);
});

test('нормализация: варианты написания считаются одним логином в блоке', () => {
  const { db } = setup();
  const variants = ['adultc', 'ADULTC', ' adultc', 'ａｄｕｌｔｃ', 'AdultC '];
  for (let i = 0; i < MAX_FAILS; i++) threw(() => login(db, variants[i], BAD, T0 + i, DEFAULT_TTL_MS, '1.1.1.1'));
  assert.match(threw(() => login(db, 'aDuLtC', PW, T0 + 10, DEFAULT_TTL_MS, '1.1.1.1')), /too many/);
});

// ---------- блок по IP ----------
test('чужой перебор логина с другого IP не блокирует настоящего владельца', () => {
  const { db, ids } = setup();
  for (let i = 0; i < MAX_FAILS + 3; i++) threw(() => login(db, 'adultc', BAD, T0 + i, DEFAULT_TTL_MS, '6.6.6.6'));
  // атакующий заблокирован, даже с верным паролем
  assert.match(threw(() => login(db, 'adultc', PW, T0 + 50, DEFAULT_TTL_MS, '6.6.6.6')), /too many/);
  // настоящий владелец с другого адреса входит
  const tok = login(db, 'adultc', PW, T0 + 51, DEFAULT_TTL_MS, '2.2.2.2');
  assert.deepEqual(currentUser(db, tok, T0 + 52), { id: ids.adultC, role: 'student' });
});

test('блок пары логин+IP снимается через окно; на другой логин с того же IP не распространяется', () => {
  const { db } = setup();
  for (let i = 0; i < MAX_FAILS; i++) threw(() => login(db, 'adultc', BAD, T0 + i, DEFAULT_TTL_MS, '6.6.6.6'));
  assert.match(threw(() => login(db, 'adultc', PW, T0 + 10, DEFAULT_TTL_MS, '6.6.6.6')), /too many/);
  assert.ok(login(db, 'boss', 'owner-password-1', T0 + 11, DEFAULT_TTL_MS, '6.6.6.6'));   // другой логин с этого IP: пока только пара
  assert.ok(login(db, 'adultc', PW, T0 + WINDOW_MS + 10, DEFAULT_TTL_MS, '6.6.6.6'));
});

test('лимит по IP: перебор разных логинов с одного адреса блокирует этот адрес целиком, другие адреса — нет', () => {
  const { db } = setup();
  // 20 неудач по разным (в т.ч. неизвестным) логинам, по 4 на логин: ни одна пара не достигает порога 5
  for (let i = 0; i < MAX_FAILS_PER_IP; i++) threw(() => login(db, `ghost${i % 5}`, BAD, T0 + i, DEFAULT_TTL_MS, '9.9.9.9'));
  assert.match(threw(() => login(db, 'adultc', PW, T0 + 100, DEFAULT_TTL_MS, '9.9.9.9')), /too many/);
  assert.match(threw(() => login(db, 'boss', 'owner-password-1', T0 + 101, DEFAULT_TTL_MS, '9.9.9.9')), /too many/);
  assert.ok(login(db, 'adultc', PW, T0 + 102, DEFAULT_TTL_MS, '3.3.3.3'));
  assert.ok(login(db, 'adultc', PW, T0 + WINDOW_MS + 100, DEFAULT_TTL_MS, '9.9.9.9'));    // через окно — снова можно
});

test('IP нормализуется (регистр/пробелы), блок пишется в журнал без паролей', () => {
  const { db, ids } = setup();
  for (let i = 0; i < MAX_FAILS; i++) threw(() => login(db, 'adultc', BAD, T0 + i, DEFAULT_TTL_MS, i % 2 ? ' 2001:DB8::1 ' : '2001:db8::1'));
  assert.match(threw(() => login(db, 'adultc', PW, T0 + 10, DEFAULT_TTL_MS, '2001:db8::1')), /too many/);
  const log = readAudit(db, { id: ids.owner, role: 'owner' }) as { action: string }[];
  assert.ok(log.some(r => r.action === 'auth.login.blocked'));
  assert.ok(!JSON.stringify(log).includes(BAD));
});
