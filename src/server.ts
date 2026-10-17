// Веб-каркас (Ф8): HTTP/JSON поверх тестированного ядра. Без внешних зависимостей.
// Принципы:
//  * deny by default: любой /api/* без сессии → 401; маршрут без явного списка ролей → 403;
//  * роль берётся ТОЛЬКО из базы по сессии (auth.currentUser), клиент её не присылает;
//  * ответы строятся сериализаторами с белым списком полей, строка из базы целиком не отдаётся;
//  * ошибки — короткий код без стека и внутренних сообщений.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { AuthError, BAD_LOGIN, BLOCKED, currentUser, login, logout } from './auth.ts';
import {
  Denied, ScheduleError, getContacts, listStudents, readAudit, grantConsent, CONSENT_SCOPES,
  type Actor, type Role, type ConsentScope,
} from './access.ts';
import { cancelMine, createSlot, enrollMe, myLessons, type LessonView, type Student } from './schedule.ts';
import { MessageRejected, listThreads, openThread, postMessage, readThread, type Post } from './messages.ts';
import { exportData, listConsents, revokeConsent } from './consent.ts';

export const COOKIE = 'sid';
export const DEFAULT_MAX_BODY = 16 * 1024;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type ServerOptions = {
  maxBody?: number;
  now?: () => number;
  secureCookie?: boolean;   // true за HTTPS-прокси (COOKIE_SECURE=1)
};

// ---------- сериализаторы: белый список полей, отдельный на роль ----------
type Json = Record<string, unknown>;
const pickStudent = (s: Student): Json => ({ id: s.id, display_name: s.display_name, level: s.level });

/** Урок для роли. Преподаватель: только id/имя/уровень учеников своего урока — никаких контактов и родителей. */
function serializeLesson(role: Role, l: LessonView): Json {
  const base: Json = { id: l.id, teacher_id: l.teacher_id, teacher_name: l.teacher_name, starts_at: l.starts_at, duration_min: l.duration_min, status: l.status };
  switch (role) {
    case 'teacher': return { ...base, students: l.students.map(pickStudent) };
    case 'student': return { ...base, students: l.students.map(pickStudent) };
    case 'parent':  return { ...base, students: l.students.map(pickStudent) };
    case 'owner':   return { ...base, students: l.students.map(pickStudent) };
    default: return {};
  }
}

/** Реплика ветки. Преподавателю родитель показывается ролью без имени. */
function serializePost(role: Role, p: Post & { role?: string }): Json {
  const out: Json = { id: p.id, from_id: p.from_id, body: p.body, created_at: p.created_at };
  if (!(role === 'teacher' && p.role === 'parent')) out.from_name = p.from_name;
  if (p.role) out.from_role = p.role;
  return out;
}

// ---------- ошибки ----------
class HttpError extends Error {
  status: number; code: string; extra: Json;
  constructor(status: number, code: string, extra: Json = {}) { super(code); this.name = 'HttpError'; this.status = status; this.code = code; this.extra = extra; }
}

// ---------- маршруты ----------
type Ctx = { db: DatabaseSync; actor: Actor; now: number; params: string[]; body: Json; token: string };
type Route = { method: string; path: string; re: RegExp; roles: readonly Role[]; run: (c: Ctx) => { status?: number; body: Json } };
const ALL: readonly Role[] = ['student', 'parent', 'teacher', 'owner'];

const int = (v: unknown, what: string): number => {
  const n = typeof v === 'string' ? (/^\d{1,12}$/.test(v) ? Number(v) : NaN) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new HttpError(400, 'bad_request', { field: what });
  return n;
};
const str = (v: unknown, what: string, max = 2100): string => {
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, 'bad_request', { field: what });
  return v;
};

function buildRoutes(): Route[] {
  const R: Route[] = [];
  const add = (method: string, path: string, roles: readonly Role[], run: Route['run']) =>
    R.push({ method, path, re: new RegExp('^' + path.replace(/:id/g, '(\\d{1,12})') + '$'), roles, run });

  add('GET', '/api/me', ALL, ({ db, actor }) => {
    const r = db.prepare('SELECT id, role, display_name FROM users WHERE id = ?').get(actor.id) as { id: number; role: string; display_name: string };
    return { body: { id: r.id, role: r.role, display_name: r.display_name } };
  });
  add('POST', '/api/logout', ALL, ({ db, token }) => { logout(db, token); return { body: { ok: true } }; });

  // свои контакты: у преподавателя права own_contacts.read нет вообще
  add('GET', '/api/me/contacts', ['student', 'parent', 'owner'], ({ db, actor }) => {
    const c = getContacts(db, actor, actor.id);
    return { body: { email: c.email, phone: c.phone } };
  });
  // чужие контакты — только владелец
  add('GET', '/api/contacts/:id', ['owner'], ({ db, actor, params }) => {
    const c = getContacts(db, actor, int(params[0], 'id'));
    return { body: { email: c.email, phone: c.phone } };
  });

  add('GET', '/api/students', ALL, ({ db, actor, now }) =>
    ({ body: { students: listStudents(db, actor, now).map(pickStudent) } }));

  add('GET', '/api/lessons', ALL, ({ db, actor, now, token }) =>
    ({ body: { lessons: myLessons(db, token, now).map(l => serializeLesson(actor.role, l)) } }));
  add('POST', '/api/lessons', ['teacher'], ({ db, now, token, body }) => {
    const id = createSlot(db, token, now, str(body.starts_at, 'starts_at', 40),
      body.duration_min === undefined ? 50 : int(body.duration_min, 'duration_min'),
      body.audience === undefined ? 'minor' : (str(body.audience, 'audience', 10) as 'minor'));
    return { status: 201, body: { id } };
  });
  add('POST', '/api/lessons/:id/enroll', ['student', 'parent', 'owner'], ({ db, now, token, params, body }) => {
    enrollMe(db, token, now, int(params[0], 'id'), int(body.student_id, 'student_id'));
    return { body: { ok: true } };
  });
  add('POST', '/api/lessons/:id/cancel', ['student', 'parent', 'owner'], ({ db, now, token, params, body }) => {
    cancelMine(db, token, now, int(params[0], 'id'), int(body.student_id, 'student_id'));
    return { body: { ok: true } };
  });

  add('GET', '/api/threads', ['student', 'parent', 'teacher', 'owner'], ({ db, actor }) =>
    ({ body: { threads: listThreads(db, actor).map(id => ({ id })) } }));
  add('POST', '/api/threads', ['student', 'parent', 'teacher'], ({ db, actor, body }) => {
    const id = openThread(db, actor, int(body.teacher_id, 'teacher_id'), int(body.student_id, 'student_id'));
    return { status: 201, body: { id } };
  });
  add('GET', '/api/threads/:id', ['student', 'parent', 'teacher', 'owner'], ({ db, actor, params }) => {
    const posts = readThread(db, actor, int(params[0], 'id')) as (Post & { role?: string })[];
    const roles = new Map((db.prepare('SELECT id, role FROM users').all() as { id: number; role: string }[]).map(u => [u.id, u.role]));
    return { body: { posts: posts.map(p => serializePost(actor.role, { ...p, role: roles.get(p.from_id) })) } };
  });
  add('POST', '/api/threads/:id/messages', ['student', 'parent', 'teacher'], ({ db, actor, params, body }) => {
    const id = postMessage(db, actor, int(params[0], 'id'), str(body.body, 'body'));
    return { status: 201, body: { id } };
  });

  // согласия
  const scopeOf = (v: unknown): ConsentScope => {
    if (v === undefined) return 'data_processing';
    if (typeof v !== 'string' || !(CONSENT_SCOPES as readonly string[]).includes(v)) throw new HttpError(400, 'bad_request', { field: 'scope' });
    return v as ConsentScope;
  };
  add('GET', '/api/consents/:id', ['student', 'parent', 'owner'], ({ db, actor, now, params }) =>
    ({ body: { consents: listConsents(db, actor, int(params[0], 'id'), now).map(c => ({ scope: c.scope, text_version: c.text_version, granted_at: c.granted_at, revoked_at: c.revoked_at, active: c.active })) } }));
  add('POST', '/api/consents/:id', ['parent'], ({ db, actor, now, params, body }) => {
    grantConsent(db, actor, int(params[0], 'id'), scopeOf(body.scope), undefined, now);
    return { status: 201, body: { ok: true } };
  });
  add('POST', '/api/consents/:id/revoke', ['parent'], ({ db, actor, now, params, body }) => {
    const r = revokeConsent(db, actor, int(params[0], 'id'), scopeOf(body.scope), now);
    return { body: { cancelled: r.cancelled } };
  });
  add('GET', '/api/export/:id', ['student', 'parent', 'owner'], ({ db, actor, now, params }) => {
    const e = exportData(db, actor, int(params[0], 'id'), now);
    return { body: e as unknown as Json };   // структура уже без чужих контактов (см. consent.ts); контакты — только самому человеку
  });

  add('GET', '/api/audit', ['owner'], ({ db, actor }) =>
    ({ body: { entries: (readAudit(db, actor) as { id: number; ts: string; actor_id: number | null; action: string; target_type: string | null; target_id: number | null; outcome: string }[])
      .slice(-500).map(r => ({ id: r.id, ts: r.ts, actor_id: r.actor_id, action: r.action, target_type: r.target_type, target_id: r.target_id, outcome: r.outcome })) } }));
  return R;
}

/** Список маршрутов (для тестов: перебрать ВСЕ). */
export function routeTable(): { method: string; pattern: string; roles: readonly Role[] }[] {
  return buildRoutes().map(r => ({ method: r.method, pattern: r.path, roles: r.roles }));
}

// ---------- сервер ----------
function send(res: ServerResponse, status: number, body: Json, extra: Record<string, string> = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...extra,
  });
  res.end(data);
}

function readCookie(req: IncomingMessage, name: string): string {
  const h = req.headers.cookie;
  if (typeof h !== 'string') return '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function readBody(req: IncomingMessage, limit: number): Promise<Json> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) { reject(new HttpError(413, 'payload_too_large')); return; }
    const chunks: Buffer[] = [];
    let size = 0, done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; reject(new HttpError(413, 'payload_too_large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (size === 0) { resolve({}); return; }
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw 0;
        resolve(v as Json);
      } catch { reject(new HttpError(400, 'bad_json')); }
    });
    req.on('error', () => { if (!done) { done = true; reject(new HttpError(400, 'bad_request')); } });
  });
}

export function createApp(db: DatabaseSync, opts: ServerOptions = {}): Server {
  const maxBody = opts.maxBody ?? DEFAULT_MAX_BODY;
  const clock = opts.now ?? Date.now;
  const routes = buildRoutes();
  const cookieAttrs = `Path=/; HttpOnly; SameSite=Strict${opts.secureCookie ? '; Secure' : ''}`;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const now = clock();

    if (path === '/healthz' && method === 'GET') return send(res, 200, { ok: true });
    if (!path.startsWith('/api/')) throw new HttpError(404, 'not_found');

    // единственная публичная точка API — вход
    const isLogin = method === 'POST' && path === '/api/login';
    const token = readCookie(req, COOKIE);
    const actor = isLogin ? null : currentUser(db, token, now);
    if (!isLogin && !actor) throw new HttpError(401, 'unauthorized');

    // CSRF-страховка поверх SameSite=Strict: изменяющие запросы только JSON.
    // Тело читается ПОСЛЕ проверки роли (кроме входа): запрещённый маршрут отвечает 403 до разбора тела.
    let body: Json = {};
    const readJson = async () => {
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) throw new HttpError(415, 'unsupported_media_type');
      body = await readBody(req, maxBody);
    };
    const mutating = method !== 'GET' && method !== 'HEAD';

    if (isLogin) {
      await readJson();
      const ip = req.socket.remoteAddress ?? 'unknown';
      let t: string;
      try { t = login(db, str(body.login, 'login', 200), str(body.password, 'password', 200), now, SESSION_TTL_MS, ip); }
      catch (e) {
        if (e instanceof AuthError) throw new HttpError(e.message === BLOCKED ? 429 : 401, e.message === BLOCKED ? 'too_many_attempts' : 'invalid_credentials');
        throw e;
      }
      const me = currentUser(db, t, now)!;
      const u = db.prepare('SELECT id, role, display_name FROM users WHERE id = ?').get(me.id) as { id: number; role: string; display_name: string };
      return send(res, 200, { id: u.id, role: u.role, display_name: u.display_name },
        { 'Set-Cookie': `${COOKIE}=${t}; ${cookieAttrs}; Max-Age=${SESSION_TTL_MS / 1000}` });
    }

    // единая точка проверки роли: нет маршрута или роли в его списке → 403
    let hit: { r: Route; m: RegExpMatchArray } | null = null;
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = path.match(r.re);
      if (m) { hit = { r, m }; break; }
    }
    if (!hit || !hit.r.roles.includes(actor!.role)) throw new HttpError(403, 'forbidden');

    if (mutating) await readJson();
    const out = hit.r.run({ db, actor: actor!, now, params: hit.m.slice(1), body, token });
    const extra: Record<string, string> = path === '/api/logout' ? { 'Set-Cookie': `${COOKIE}=; ${cookieAttrs}; Max-Age=0` } : {};
    return send(res, out.status ?? 200, out.body, extra);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(e => {
      if (res.headersSent) { res.destroy(); return; }
      const close = { Connection: 'close' };
      if (e instanceof HttpError) return send(res, e.status, { error: e.code, ...e.extra }, e.status === 413 ? close : {});
      if (e instanceof MessageRejected) return send(res, 422, { error: 'message_rejected', reason: e.reason, message: e.message });
      if (e instanceof Denied) return send(res, 403, { error: 'forbidden' });       // внутреннее имя права наружу не отдаём
      if (e instanceof ScheduleError) return send(res, 409, { error: 'conflict', message: e.message });
      if (e instanceof AuthError) return send(res, 401, { error: 'unauthorized' });
      console.error('internal error:', e instanceof Error ? e.name : typeof e);       // в лог — только тип, не стек и не данные
      return send(res, 500, { error: 'internal_error' });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;
  return server;
}

/** Запуск: только 127.0.0.1, порт из PORT. */
export function listen(server: Server, port = Number(process.env.PORT ?? 8787)): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { openDb } = await import('./db.ts');
  const db = openDb(process.env.DATABASE_PATH ?? ':memory:');
  const port = await listen(createApp(db, { secureCookie: process.env.COOKIE_SECURE === '1' }));
  console.log(`listening on 127.0.0.1:${port}`);
}
