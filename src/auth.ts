// Вход и сессии. Роль берётся из БАЗЫ по сессии (currentUser), не от клиента.
import type { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { type Actor, type Role } from './access.ts';

export const MIN_PASSWORD = 10;
export const MAX_FAILS = 5;
export const WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
export class AuthError extends Error {
  constructor(msg: string) { super(msg); this.name = 'AuthError'; }
}
export const BAD_LOGIN = 'invalid login or password';
export const BLOCKED = 'too many attempts, try later';

const N = 16384, R = 8, P = 1, KEYLEN = 32;

/** Формат: scrypt$N$r$p$соль(b64)$хеш(b64) — параметры внутри строки. */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const salt = Buffer.from(parts[4], 'base64');
  const want = Buffer.from(parts[5], 'base64');
  const got = scryptSync(pw, salt, want.length, { N: n, r, p });
  return got.length === want.length && timingSafeEqual(got, want);
}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function audit(db: DatabaseSync, actorId: number | null, action: string, outcome: 'allowed' | 'denied') {
  // без логина, паролей и токенов
  db.prepare('INSERT INTO audit_log(actor_id, action, target_type, target_id, outcome) VALUES (?,?,?,?,?)')
    .run(actorId, action, 'session', null, outcome);
}

export function register(db: DatabaseSync, userId: number, login: string, password: string) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new AuthError(`password must be at least ${MIN_PASSWORD} characters`);
  if (!login) throw new AuthError('login required');
  db.prepare('INSERT INTO credentials(user_id, login, password_hash) VALUES (?,?,?)').run(userId, login, hashPassword(password));
}

function recentFails(db: DatabaseSync, login: string, now: number): number {
  const r = db.prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE login = ? AND ok = 0 AND ts > ?').get(login, now - WINDOW_MS) as { c: number };
  return r.c;
}

/** Возвращает токен сессии (единственный раз; в базе только его sha256). */
export function login(db: DatabaseSync, loginName: string, password: string, now: number, ttlMs = DEFAULT_TTL_MS): string {
  if (recentFails(db, loginName, now) >= MAX_FAILS) {
    audit(db, null, 'auth.login.blocked', 'denied');
    throw new AuthError(BLOCKED);
  }
  const row = db.prepare('SELECT user_id, password_hash FROM credentials WHERE login = ?').get(loginName) as
    { user_id: number; password_hash: string } | undefined;
  // при неизвестном логине всё равно считаем хеш — одинаковое время и ответ
  const ok = verifyPassword(String(password), row?.password_hash ?? DUMMY) && !!row;
  db.prepare('INSERT INTO login_attempts(login, ts, ok) VALUES (?,?,?)').run(loginName, now, ok ? 1 : 0);
  if (!ok) {
    audit(db, row?.user_id ?? null, 'auth.login.fail', 'denied');
    throw new AuthError(BAD_LOGIN);
  }
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(sha256(token), row!.user_id, now, now + ttlMs);
  audit(db, row!.user_id, 'auth.login.ok', 'allowed');
  return token;
}
const DUMMY = hashPassword('dummy-password-for-timing');

/** Роль — из БАЗЫ по сессии. Нет/просрочена → null. */
export function currentUser(db: DatabaseSync, token: string, now: number): Actor | null {
  if (typeof token !== 'string' || !token) return null;
  const r = db.prepare(
    `SELECT u.id, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), now) as { id: number; role: Role } | undefined;
  return r ? { id: r.id, role: r.role } : null;
}

export function logout(db: DatabaseSync, token: string) {
  const r = db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(String(token)));
  if (Number(r.changes) > 0) audit(db, null, 'auth.logout', 'allowed');
}
export function revokeAllSessions(db: DatabaseSync, userId: number) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  audit(db, userId, 'auth.revoke_all', 'allowed');
}
