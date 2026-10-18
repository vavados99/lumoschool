// Вход и сессии. Роль берётся из БАЗЫ по сессии (currentUser), не от клиента.
import type { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { type Actor, type Role } from './access.ts';

export const MIN_PASSWORD = 10;
export const MAX_FAILS = 5;
export const MAX_FAILS_PER_IP = 20;   // отдельный лимит на адрес (любые логины)
export const WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
export class AuthError extends Error {
  constructor(msg: string) { super(msg); this.name = 'AuthError'; }
}
export const BAD_LOGIN = 'invalid login or password';
export const BLOCKED = 'too many attempts, try later';

/** Логин: Unicode NFKC, trim, lowercase. Одинаково при регистрации и входе. */
export function normalizeLogin(raw: unknown): string {
  return String(raw ?? '').normalize('NFKC').trim().toLowerCase();
}
export function normalizeIp(raw: unknown): string {
  const s = String(raw ?? '').normalize('NFKC').trim().toLowerCase().slice(0, 64);
  return s || 'unknown';
}

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
let sessionSecret: string | null = null;
/** Ф12: серверный секрет (SESSION_SECRET). Задан — хеш токена в базе считается HMAC-SHA256 с ним: украденная копия базы не даёт проверять токены. Смена секрета разлогинивает всех. */
export function setSessionSecret(s: string | null) { sessionSecret = s; }
const sha256 = (s: string) => (sessionSecret ? createHmac('sha256', sessionSecret) : createHash('sha256')).update(s).digest('hex');

function audit(db: DatabaseSync, actorId: number | null, action: string, outcome: 'allowed' | 'denied') {
  // без логина, паролей и токенов
  db.prepare('INSERT INTO audit_log(actor_id, action, target_type, target_id, outcome) VALUES (?,?,?,?,?)')
    .run(actorId, action, 'session', null, outcome);
}

export function register(db: DatabaseSync, userId: number, loginRaw: string, password: string) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new AuthError(`password must be at least ${MIN_PASSWORD} characters`);
  const login = normalizeLogin(loginRaw);
  if (!login) throw new AuthError('login required');
  if (db.prepare('SELECT 1 FROM credentials WHERE login = ?').get(login)) throw new AuthError('login already taken');
  db.prepare('INSERT INTO credentials(user_id, login, password_hash) VALUES (?,?,?)').run(userId, login, hashPassword(password));
}

/** Неудачи пары логин+IP: чужой перебор логина с другого адреса настоящего владельца не блокирует. */
function recentPairFails(db: DatabaseSync, login: string, ip: string, now: number): number {
  const r = db.prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE login = ? AND ip = ? AND ok = 0 AND ts > ?').get(login, ip, now - WINDOW_MS) as { c: number };
  return r.c;
}
/** Неудачи с одного адреса по любым логинам (включая неизвестные). */
function recentIpFails(db: DatabaseSync, ip: string, now: number): number {
  const r = db.prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND ok = 0 AND ts > ?').get(ip, now - WINDOW_MS) as { c: number };
  return r.c;
}

/** Возвращает токен сессии (единственный раз; в базе только его sha256). */
export function login(db: DatabaseSync, loginRaw: string, password: string, now: number, ttlMs = DEFAULT_TTL_MS, ipRaw: string = 'unknown'): string {
  const loginName = normalizeLogin(loginRaw);
  const ip = normalizeIp(ipRaw);
  if (recentPairFails(db, loginName, ip, now) >= MAX_FAILS || recentIpFails(db, ip, now) >= MAX_FAILS_PER_IP) {
    audit(db, null, 'auth.login.blocked', 'denied');
    throw new AuthError(BLOCKED);
  }
  const row = db.prepare('SELECT user_id, password_hash FROM credentials WHERE login = ?').get(loginName) as
    { user_id: number; password_hash: string } | undefined;
  // при неизвестном логине всё равно считаем хеш — одинаковое время и ответ
  const ok = verifyPassword(String(password), row?.password_hash ?? DUMMY) && !!row;
  db.prepare('INSERT INTO login_attempts(login, ts, ok, ip) VALUES (?,?,?,?)').run(loginName, now, ok ? 1 : 0, ip);
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

/** Чистка: удаляет просроченные сессии (expires_at <= now). Возвращает сколько удалено. Живые не трогает. */
export function purgeExpiredSessions(db: DatabaseSync, now: number): number {
  const n = Number(db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes);
  if (n > 0) audit(db, null, 'auth.sessions.purged', 'allowed');
  return n;
}
/** Чистка старых попыток входа (старше окна блокировки — на блок уже не влияют). */
export function purgeOldAttempts(db: DatabaseSync, now: number): number {
  return Number(db.prepare('DELETE FROM login_attempts WHERE ts <= ?').run(now - WINDOW_MS).changes);
}

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
