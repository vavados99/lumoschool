// Веб-каркас (Ф8): HTTP/JSON поверх тестированного ядра. Без внешних зависимостей.
// Принципы:
//  * deny by default: любой /api/* без сессии → 401; маршрут без явного списка ролей → 403;
//  * роль берётся ТОЛЬКО из базы по сессии (auth.currentUser), клиент её не присылает;
//  * ответы строятся сериализаторами с белым списком полей, строка из базы целиком не отдаётся;
//  * ошибки — короткий код без стека и внутренних сообщений.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { AuthError, BAD_LOGIN, BLOCKED, DELAY_STEP_MS, currentUser, login, loginDelayMs, logout } from './auth.ts';
import {
  Denied, ScheduleError, NotAvailable, getContacts, listStudents, grantConsent, CONSENT_SCOPES,
  type Actor, type Role, type ConsentScope,
} from './access.ts';
import { cancelMine, createSlot, enrollMe, myLessons, type LessonView, type Student } from './schedule.ts';
import { MessageRejected, listThreads, listNotifications, openThread, postMessage, readThread, type Post } from './messages.ts';
import { enterRoom, leaveRoom, roomState, postRoomMessage, callOwner, listOwnerCalls, setRecording, videoStub, RoomRefused } from './room.ts';
import { ownerDashboard, readAuditPage, parsePeriod, AUDIT_DEFAULT_LIMIT } from './dashboard.ts';
import { t, hasKey, pickLang, fromAcceptLanguage } from './i18n.ts';
import { exportData, listConsents, revokeConsent, eraseData } from './consent.ts';

export const COOKIE = 'sid';
/** Ф18: имя куки сессии. Secure-режим → префикс __Host- (требует Secure, Path=/, без Domain — всё это у нас выполнено). */
export const cookieNameFor = (secure: boolean) => (secure ? `__Host-${COOKIE}` : COOKIE);
export const DEFAULT_MAX_BODY = 16 * 1024;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type ServerOptions = {
  maxBody?: number;
  now?: () => number;
  secureCookie?: boolean;   // true за HTTPS-прокси (COOKIE_SECURE=1)
  trustedProxies?: readonly string[];   // Ф17: адреса прокси (TRUSTED_PROXY), от которых верим X-Forwarded-For
  loginDelayStepMs?: number;            // Ф17: шаг нарастающей задержки входа (тесты ставят 1)
  loginDelayMaxMs?: number;             // Ф17: потолок задержки (по умолчанию 5 с)
  schedulerHealth?: () => unknown;      // Ф21: источник «живости» планировщика для GET /api/owner/scheduler (только владелец)
  eraser?: typeof eraseData;            // Ф26: подмена ядра стирания — ТОЛЬКО для теста слоя «маршрут» (по умолчанию eraseData)
  rateLimit?: RateLimitOptions | false; // Ф19a: лимит частоты изменяющих запросов (false — выключен, только для проверки/отладки)
};

// ---------- Ф19a: лимит частоты изменяющих маршрутов (POST/PUT/PATCH/DELETE), в памяти ----------
// Два независимых ключа: пользователь (id из сессии) и адрес (clientIp: X-Forwarded-For только от TRUSTED_PROXY).
// Окна фиксированные; у каждого ключа несколько окон (короткое и длинное). Превышение → 429 rate_limited + Retry-After.
// Вход (/api/login) сюда не входит: у него своя нарастающая задержка и лимит пары логин+адрес.
export type RateWindow = { windowMs: number; max: number };
export type RateLimitOptions = { user?: readonly RateWindow[]; ip?: readonly RateWindow[] };
export const DEFAULT_RATE_USER: readonly RateWindow[] = [{ windowMs: 60_000, max: 30 }, { windowMs: 3_600_000, max: 300 }];
// адрес щедрее: за одним NAT (школа, общежитие) сидят многие
export const DEFAULT_RATE_IP: readonly RateWindow[] = [{ windowMs: 60_000, max: 120 }, { windowMs: 3_600_000, max: 1200 }];
const RATE_MAX_KEYS = 20_000;

export function createRateLimiter(wins: readonly RateWindow[]) {
  const hits = new Map<string, { start: number; n: number }[]>();
  const longest = Math.max(...wins.map(w => w.windowMs));
  return {
    /** Считает запрос; возвращает 0 если можно, иначе секунд до сброса (≥1). Отказанный запрос окна не продлевает. */
    hit(key: string, now: number): number {
      if (hits.size >= RATE_MAX_KEYS) for (const [k, v] of hits) if (v.every(c => now - c.start >= longest)) hits.delete(k);
      let cs = hits.get(key);
      if (!cs) { cs = wins.map(() => ({ start: now, n: 0 })); hits.set(key, cs); }
      let retry = 0;
      wins.forEach((w, i) => {
        const c = cs![i];
        if (now - c.start >= w.windowMs || now < c.start) { c.start = now; c.n = 0; }
        if (c.n >= w.max) retry = Math.max(retry, Math.ceil((c.start + w.windowMs - now) / 1000) || 1);
      });
      if (retry === 0) cs.forEach(c => { c.n++; });
      return retry;
    },
  };
}

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
  const out: Json = { id: p.id, body: p.body, created_at: p.created_at };
  if (!(role === 'teacher' && p.role === 'parent')) { out.from_id = p.from_id; out.from_name = p.from_name; }   // Ф18: преподавателю — ни имени, ни id родителя
  if (p.role) out.from_role = p.role;
  return out;
}

// ---------- ошибки ----------
class HttpError extends Error {
  status: number; code: string; extra: Json; headers: Record<string, string>;
  constructor(status: number, code: string, extra: Json = {}, headers: Record<string, string> = {}) { super(code); this.name = 'HttpError'; this.status = status; this.code = code; this.extra = extra; this.headers = headers; }
}

// ---------- маршруты ----------
type Ctx = { db: DatabaseSync; actor: Actor; now: number; params: string[]; body: Json; token: string; query: URLSearchParams };
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

function buildRoutes(schedulerHealth?: () => unknown, eraser: typeof eraseData = eraseData): Route[] {
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
    const aud = body.audience === undefined ? 'minor' : str(body.audience, 'audience', 10);
    if (aud !== 'minor' && aud !== 'adult') throw new HttpError(400, 'bad_request', { field: 'audience' });   // Ф18: 'toString' и прочие служебные строки — 400, не 500
    const id = createSlot(db, token, now, str(body.starts_at, 'starts_at', 40),
      body.duration_min === undefined ? 50 : int(body.duration_min, 'duration_min'), aud);
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

  add('GET', '/api/threads', ['student', 'parent', 'teacher', 'owner'], ({ db, actor, now }) =>
    ({ body: { threads: listThreads(db, actor, now).map(id => ({ id })) } }));
  add('POST', '/api/threads', ['student', 'parent', 'teacher'], ({ db, actor, now, body }) => {
    const id = openThread(db, actor, int(body.teacher_id, 'teacher_id'), int(body.student_id, 'student_id'), now);
    return { status: 201, body: { id } };
  });
  add('GET', '/api/threads/:id', ['student', 'parent', 'teacher', 'owner'], ({ db, actor, now, params }) => {
    const posts = readThread(db, actor, int(params[0], 'id'), now) as (Post & { role?: string })[];
    const roles = new Map((db.prepare('SELECT id, role FROM users').all() as { id: number; role: string }[]).map(u => [u.id, u.role]));
    return { body: { posts: posts.map(p => serializePost(actor.role, { ...p, role: roles.get(p.from_id) })) } };
  });
  add('POST', '/api/threads/:id/messages', ['student', 'parent', 'teacher'], ({ db, actor, now, params, body }) => {
    const id = postMessage(db, actor, int(params[0], 'id'), str(body.body, 'body'), now);
    return { status: 201, body: { id } };
  });
  // Ф18: уведомления родителю о репликах преподавателя ребёнку
  add('GET', '/api/notifications', ['parent'], ({ db, actor }) => ({ body: { notifications: listNotifications(db, actor) } }));

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
  // Ф25: удаление (обезличивание) человека по просьбе. Необратимо → нужен явный {"confirm": true}.
  // HTTP: владелец (любого ученика/родителя) и родитель (себя или своего ребёнка до 18). Ученик и преподаватель — 403 ещё до разбора тела;
  // ученик 16+ просит владельца (ограничение, см. docs). Чужой ребёнок / владелец / преподаватель / уже удалённый → 403 из ядра (consent.eraseData).
  add('POST', '/api/erase/:id', ['owner', 'parent'], ({ db, actor, now, params, body }) => {
    if (body.confirm !== true) throw new HttpError(400, 'bad_request', { field: 'confirm' });
    eraser(db, actor, int(params[0], 'id'), now);
    return { body: { ok: true } };
  });
  add('GET', '/api/export/:id', ['student', 'parent', 'owner'], ({ db, actor, now, params }) => {
    const e = exportData(db, actor, int(params[0], 'id'), now);
    return { body: e as unknown as Json };   // структура уже без чужих контактов (см. consent.ts); контакты — только самому человеку
  });

  // Ф9: комната урока. Чужому и несуществующему уроку — один и тот же 403.
  const rid = (p: string[]) => int(p[0], 'id');
  add('GET', '/api/rooms/:id', ALL, ({ db, actor, now, params }) => ({ body: roomState(db, actor, rid(params), now) as unknown as Json }));
  add('POST', '/api/rooms/:id/enter', ALL, ({ db, actor, now, params }) => ({ body: enterRoom(db, actor, rid(params), now) as unknown as Json }));
  add('POST', '/api/rooms/:id/leave', ALL, ({ db, actor, now, params }) => { leaveRoom(db, actor, rid(params), now); return { body: { ok: true } }; });
  add('POST', '/api/rooms/:id/chat', ['student', 'teacher', 'owner'], ({ db, actor, now, params, body }) =>
    ({ status: 201, body: { id: postRoomMessage(db, actor, rid(params), str(body.body, 'body'), now) } }));
  add('POST', '/api/rooms/:id/call-owner', ALL, ({ db, actor, now, params }) => { callOwner(db, actor, rid(params), now); return { body: { ok: true } }; });
  add('POST', '/api/rooms/:id/recording', ['owner'], ({ db, actor, now, params, body }) => {
    if (typeof body.on !== 'boolean') throw new HttpError(400, 'bad_request', { field: 'on' });
    setRecording(db, actor, rid(params), body.on, now);
    return { body: { ok: true, recording: body.on } };
  });
  add('GET', '/api/rooms/:id/video', ALL, ({ db, actor, now, params }) => ({ body: videoStub(db, actor, rid(params), now) as unknown as Json }));
  add('GET', '/api/room-calls', ['owner'], ({ db, actor }) =>
    ({ body: { calls: listOwnerCalls(db, actor).map(c => ({ id: c.id, ts: c.ts, lesson_id: c.lesson_id, caller_id: c.caller_id, caller_role: c.caller_role, caller_name: c.caller_name })) } }));

  // Ф18: дубль /api/owner/audit. Тот же постраничный ридер: чтение журнал не пополняет, вся таблица не читается (лимит 500 → не более AUDIT_MAX_LIMIT).
  add('GET', '/api/audit', ['owner'], ({ db, actor }) => ({ body: readAuditPage(db, actor, 500) as unknown as Json }));

  // Ф21: «живость» планировщика — только владелец; время и имена задач, никаких данных пользователей; в журнал не пишется
  add('GET', '/api/owner/scheduler', ['owner'], ({ actor }) => {
    if (actor.role !== 'owner') throw new Denied('scheduler.read denied');   // Ф23: вторая линия (раньше защищал только список ролей маршрута)
    return { body: { enabled: !!schedulerHealth, tasks: (schedulerHealth?.() ?? {}) as Json } };
  });
  // Ф10: дашборд и постраничный журнал — строго владелец; чтение журнал не пополняет (см. dashboard.ts)
  add('GET', '/api/owner/dashboard', ['owner'], ({ db, actor, now, query }) => {
    const p = parsePeriod(query.get('from'), query.get('to'));
    if (!p) throw new HttpError(400, 'bad_request', { field: 'period' });
    return { body: ownerDashboard(db, actor, p, now) as unknown as Json };
  });
  add('GET', '/api/owner/audit', ['owner'], ({ db, actor, query }) => {
    const lq = query.get('limit'), bq = query.get('before');
    const limit = lq === null ? AUDIT_DEFAULT_LIMIT : int(lq, 'limit');
    if (limit < 1) throw new HttpError(400, 'bad_request', { field: 'limit' });
    return { body: readAuditPage(db, actor, limit, bq === null ? undefined : int(bq, 'before')) as unknown as Json };
  });
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

const stripV4 = (a: string) => a.replace(/^::ffff:/i, '').toLowerCase();
/** Ф17: адрес клиента. X-Forwarded-For читаем ТОЛЬКО если соединение пришло от доверенного прокси; идём справа налево
 *  и берём первый адрес, не принадлежащий доверенным (левые записи клиент подделывает сам). Иначе — адрес сокета. */
export function clientIp(req: IncomingMessage, trusted: readonly string[]): string {
  const remote = stripV4(req.socket.remoteAddress ?? 'unknown');
  const set = new Set(trusted.map(stripV4));
  if (!set.has(remote)) return remote;
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map(x => stripV4(x.trim())).filter(Boolean);
  for (let i = xff.length - 1; i >= 0; i--) if (!set.has(xff[i])) return xff[i];
  return remote;
}

export function createApp(db: DatabaseSync, opts: ServerOptions = {}): Server {
  const maxBody = opts.maxBody ?? DEFAULT_MAX_BODY;
  const clock = opts.now ?? Date.now;
  const routes = buildRoutes(opts.schedulerHealth, opts.eraser);
  const cookieAttrs = `Path=/; HttpOnly; SameSite=Strict${opts.secureCookie ? '; Secure' : ''}`;
  const cookieName = cookieNameFor(!!opts.secureCookie);   // Ф18: за HTTPS — __Host-sid (браузер не примет с чужого поддомена/пути)

  const limiters = opts.rateLimit === false ? null : {
    user: createRateLimiter(opts.rateLimit?.user ?? DEFAULT_RATE_USER),
    ip: createRateLimiter(opts.rateLimit?.ip ?? DEFAULT_RATE_IP),
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const now = clock();

    if (path === '/healthz' && method === 'GET') return send(res, 200, { ok: true });
    if (!path.startsWith('/api/')) throw new HttpError(404, 'not_found');

    // единственная публичная точка API — вход
    const isLogin = method === 'POST' && path === '/api/login';
    const token = readCookie(req, cookieName);
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

    // Ф19a: лимит частоты изменяющих запросов — после проверки сессии (чужие 401 чужой счётчик не трогают), до разбора тела
    if (mutating && !isLogin && limiters) {
      const ip = clientIp(req, opts.trustedProxies ?? []);
      const wait = Math.max(limiters.user.hit(`u:${actor!.id}`, now), limiters.ip.hit(`i:${ip}`, now));
      if (wait > 0) throw new HttpError(429, 'rate_limited', {}, { 'Retry-After': String(wait) });
    }

    if (isLogin) {
      await readJson();
      const ip = clientIp(req, opts.trustedProxies ?? []);
      const delay = loginDelayMs(db, ip, now, opts.loginDelayStepMs ?? DELAY_STEP_MS, opts.loginDelayMaxMs);
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      let t: string;
      try { t = login(db, str(body.login, 'login', 200), str(body.password, 'password', 200), now, SESSION_TTL_MS, ip); }
      catch (e) {
        if (e instanceof AuthError) throw new HttpError(e.message === BLOCKED ? 429 : 401, e.message === BLOCKED ? 'too_many_attempts' : 'invalid_credentials');
        throw e;
      }
      const me = currentUser(db, t, now)!;
      const u = db.prepare('SELECT id, role, display_name FROM users WHERE id = ?').get(me.id) as { id: number; role: string; display_name: string };
      return send(res, 200, { id: u.id, role: u.role, display_name: u.display_name },
        { 'Set-Cookie': `${cookieName}=${t}; ${cookieAttrs}; Max-Age=${SESSION_TTL_MS / 1000}` });
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
    const out = hit.r.run({ db, actor: actor!, now, params: hit.m.slice(1), body, token, query: url.searchParams });
    const extra: Record<string, string> = path === '/api/logout' ? { 'Set-Cookie': `${cookieName}=; ${cookieAttrs}; Max-Age=0` } : {};
    return send(res, out.status ?? 200, out.body, extra);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(e => {
      if (res.headersSent) { res.destroy(); return; }
      const close = { Connection: 'close' };
      // Ф13: локализованный текст — ДОБАВОЧНОЕ поле message_localized (+lang); код ошибки, статус и прежние поля не меняются
      // Без ?lang= и без Accept-Language тело ответа прежнее байт в байт (обратная совместимость).
      const qLang = new URL(req.url ?? '/', 'http://localhost').searchParams.get('lang');
      const aLang = String(req.headers['accept-language'] ?? '');
      const wantL10n = Boolean(qLang) || fromAcceptLanguage(aLang) !== null;   // '*' (так шлёт fetch) языком не считается
      const lang = pickLang({ query: qLang, acceptLanguage: aLang });
      const sendL = (status: number, body: Json, extra: Record<string, string> = {}) => {
        const k = `error.${String(body.error)}`;
        return send(res, status, wantL10n && hasKey(k) ? { ...body, message_localized: t(lang, k), lang } : body, extra);
      };
      if (e instanceof HttpError) return sendL(e.status, { error: e.code, ...e.extra }, { ...(e.status === 413 ? close : {}), ...e.headers });
      if (e instanceof MessageRejected) return sendL(422, { error: 'message_rejected', reason: e.reason, message: e.message });
      if (e instanceof Denied) return sendL(403, { error: 'forbidden' });       // внутреннее имя права наружу не отдаём
      if (e instanceof RoomRefused) return sendL(409, { error: e.reason });
      if (e instanceof NotAvailable) return sendL(404, { error: 'not_available' });   // Ф17: один ответ, без message
      if (e instanceof ScheduleError) return sendL(409, { error: 'conflict', message: e.message });
      if (e instanceof AuthError) return sendL(401, { error: 'unauthorized' });
      console.error('internal error:', e instanceof Error ? e.name : typeof e);       // в лог — только тип, не стек и не данные
      return sendL(500, { error: 'internal_error' });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;
  return server;
}

/** Запуск: только 127.0.0.1. Порт — из конфигурации (PORT). */
export function listen(server: Server, port = 8787): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
}

export const DEFAULT_SHUTDOWN_MS = 10_000;
/**
 * Ф21: остановка с дожиданием. Новые соединения не принимаются сразу; запросы в полёте получают ответ;
 * простаивающие keep-alive соединения закрываются; если за timeoutMs не управились — оставшиеся рвутся.
 * Возвращает { forced }: true, если пришлось рвать. Закрытие базы — на вызывающем (после этого вызова).
 */
export function stopGracefully(server: Server, timeoutMs = DEFAULT_SHUTDOWN_MS): Promise<{ forced: boolean }> {
  return new Promise(resolve => {
    let forced = false;
    const timer = setTimeout(() => { forced = true; server.closeAllConnections(); }, timeoutMs);
    timer.unref();
    server.close(() => { clearTimeout(timer); resolve({ forced }); });   // вызывается, когда все соединения закрыты
    server.closeIdleConnections();
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { openDb } = await import('./db.ts');
  const { loadConfig, ConfigError } = await import('./config.ts');
  const { setSessionSecret } = await import('./auth.ts');
  let cfg;
  try { cfg = loadConfig(); }
  catch (e) { console.error(`config error: ${e instanceof ConfigError ? e.message : 'invalid configuration'}`); process.exit(1); }
  setSessionSecret(cfg.sessionSecret);
  const db = openDb(cfg.databasePath);
  let sched: import('./scheduler.ts').Scheduler | null = null;
  const server = createApp(db, { secureCookie: cfg.cookieSecure, trustedProxies: cfg.trustedProxies, schedulerHealth: () => sched?.health() ?? {} });
  const port = await listen(server, cfg.port);
  console.log(`listening on 127.0.0.1:${port} (mode ${cfg.mode})`);
  // Ф19c: планировщик только в реальном сервере (не в тестах/seed), выключается SCHEDULER=off.
  // Реальной отправки нет: вне prod уведомления идут в консольный сток; в prod без настоящего канала очередь не трогаем (останется ждать).
  const { startScheduler } = await import('./scheduler.ts');
  const { ConsoleSink } = await import('./notify.ts');
  sched = startScheduler(db, cfg, cfg.mode === 'prod' ? null : new ConsoleSink());
  // Ф21: остановка с дожиданием запросов в полёте (SHUTDOWN_TIMEOUT_MS, по умолчанию 10 с), затем закрытие базы
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    sched?.stop();
    const { forced } = await stopGracefully(server, cfg.shutdownTimeoutMs);
    if (forced) console.log('shutdown: timeout, remaining connections dropped');
    try { db.close(); } catch { /* уже закрыта */ }
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); }); process.on('SIGTERM', () => { void shutdown(); });
}
