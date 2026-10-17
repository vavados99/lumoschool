// Ф10: данные дашборда владельца и постраничное чтение журнала.
// Принципы:
//  * только агрегаты и числовые id (кандидаты на скрытие); контактных колонок (contact_vault) в запросах НЕТ вообще;
//    имена — только display_name (без фамилий), как в остальных ответах;
//  * читает ТОЛЬКО владелец: роль и право проверяются здесь (defense in depth) поверх списка ролей маршрута;
//  * РЕШЕНИЕ по росту журнала: чтение дашборда и журнала НЕ пишет в журнал (раньше guard() писал строку на каждое чтение —
//    журнал рос от самого чтения, а старый readAudit ещё и тянул всю таблицу). Отказы чужим ролям отсекаются на уровне
//    маршрута (403/401) и тоже строк не пишут, поэтому подбор адреса не раздувает журнал. Журнал пишется только на изменения;
//  * журнал отдаётся страницами: курсор before=id, limit по умолчанию 50, потолок 200.
import type { DatabaseSync } from 'node:sqlite';
import { Denied, isMinor, hasActiveConsent, toMs, type Actor } from './access.ts';

export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 200;
export const MAX_PERIOD_DAYS = 366;
const DAY = 86_400_000;

/** Право без записи в журнал: роль owner И строка в role_permissions. */
function requireOwner(db: DatabaseSync, a: Actor, perm: string) {
  const ok = a.role === 'owner' && !!db.prepare('SELECT 1 FROM role_permissions WHERE role = ? AND permission = ?').get(a.role, perm);
  if (!ok) throw new Denied(`${perm} denied`);
}

/** Период [from, to): from включительно, to не включительно. Дата или ISO-время; не пусто, не длиннее года. null — мусор. */
export function parsePeriod(from: unknown, to: unknown): { from: number; to: number } | null {
  const re = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
  if (typeof from !== 'string' || typeof to !== 'string' || !re.test(from) || !re.test(to)) return null;
  const f = toMs(from), t = toMs(to);
  if (!Number.isFinite(f) || !Number.isFinite(t) || t <= f || t - f > MAX_PERIOD_DAYS * DAY) return null;
  return { from: f, to: t };
}

const iso = (ms: number) => new Date(ms).toISOString();
const rate = (num: number, den: number) => den > 0 ? Math.round((num / den) * 1000) / 1000 : null;

export function ownerDashboard(db: DatabaseSync, a: Actor, p: { from: number; to: number }, now = Date.now()) {
  requireOwner(db, a, 'lessons.read_all');
  const f = iso(p.from), t = iso(p.to);
  const prevF = iso(p.from - (p.to - p.from));

  // нагрузка преподавателей: отменённые уроки в часы не входят; преподаватели без уроков показываются с нулями
  const teachers = db.prepare(`
    SELECT u.id AS teacher_id, u.display_name AS name,
      COALESCE(SUM(CASE WHEN l.status != 'cancelled' THEN 1 END), 0) AS lessons,
      COALESCE(SUM(CASE WHEN l.status = 'done' THEN 1 END), 0) AS done,
      COALESCE(SUM(CASE WHEN l.status = 'cancelled' THEN 1 END), 0) AS cancelled,
      COALESCE(SUM(CASE WHEN l.status != 'cancelled' THEN l.duration_min END), 0) AS minutes
    FROM teachers te JOIN users u ON u.id = te.user_id
    LEFT JOIN lessons l ON l.teacher_id = te.user_id AND l.starts_at >= ? AND l.starts_at < ?
    GROUP BY u.id ORDER BY u.id`).all(f, t) as { teacher_id: number; name: string; lessons: number; done: number; cancelled: number; minutes: number }[];

  // заполняемость: активные записи / лимит по каждой неотменённой группе
  const groups = (db.prepare(`
    SELECT l.id AS lesson_id, l.teacher_id, l.audience, l.max_students AS capacity,
      (SELECT COUNT(*) FROM lesson_enrollments e WHERE e.lesson_id = l.id AND e.status = 'active') AS enrolled
    FROM lessons l WHERE l.status != 'cancelled' AND l.starts_at >= ? AND l.starts_at < ? ORDER BY l.id`).all(f, t) as
    { lesson_id: number; teacher_id: number; audience: string; capacity: number; enrolled: number }[])
    .map(g => ({ ...g, fill_rate: rate(g.enrolled, g.capacity) }));
  const seats = groups.reduce((s, g) => s + g.capacity, 0), taken = groups.reduce((s, g) => s + g.enrolled, 0);

  // посещаемость: только уже начавшиеся неотменённые уроки; «пришёл» = есть строка room_presence
  const att = db.prepare(`
    SELECT COUNT(*) AS booked,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM room_presence r WHERE r.lesson_id = e.lesson_id AND r.user_id = e.student_id) THEN 1 ELSE 0 END) AS attended
    FROM lesson_enrollments e JOIN lessons l ON l.id = e.lesson_id
    WHERE e.status = 'active' AND l.status != 'cancelled' AND l.starts_at >= ? AND l.starts_at < ? AND l.starts_at <= ?`).get(f, t, iso(now)) as { booked: number; attended: number | null };
  const attended = att.attended ?? 0;

  // удержание: ученики с активной записью на неотменённый урок в предыдущем периоде той же длины, снова записанные в текущем
  const studentsIn = (a0: string, b0: string) => (db.prepare(`
    SELECT DISTINCT e.student_id AS id FROM lesson_enrollments e JOIN lessons l ON l.id = e.lesson_id
    WHERE e.status = 'active' AND l.status != 'cancelled' AND l.starts_at >= ? AND l.starts_at < ?`).all(a0, b0) as { id: number }[]).map(r => r.id);
  const prev = studentsIn(prevF, f), cur = new Set(studentsIn(f, t));
  const retained = prev.filter(id => cur.has(id)).length;

  // отмены в периоде: уроки и записи (по дате урока)
  const cl = db.prepare(`SELECT COUNT(*) c FROM lessons WHERE status = 'cancelled' AND starts_at >= ? AND starts_at < ?`).get(f, t) as { c: number };
  const ce = db.prepare(`SELECT COUNT(*) c FROM lesson_enrollments e JOIN lessons l ON l.id = e.lesson_id
    WHERE e.status = 'cancelled' AND l.starts_at >= ? AND l.starts_at < ?`).get(f, t) as { c: number };

  // аварийные вызовы владельца из комнаты (журнал: room.call_owner/allowed); по времени записи, sqlite-формат 'YYYY-MM-DD HH:MM:SS'
  const calls = db.prepare(`SELECT target_id AS lesson_id, COUNT(*) AS n FROM audit_log
    WHERE action = 'room.call_owner' AND outcome = 'allowed' AND datetime(ts) >= datetime(?) AND datetime(ts) < datetime(?)
    GROUP BY target_id ORDER BY target_id`).all(f, t) as { lesson_id: number; n: number }[];

  // согласия: дети (<16, не стёртые) без действующего согласия data_processing — кандидаты на скрытие/разбор. Только id.
  const kids = (db.prepare(`SELECT s.user_id AS id FROM students s JOIN users u ON u.id = s.user_id WHERE u.anonymized_at IS NULL ORDER BY s.user_id`).all() as { id: number }[])
    .map(r => r.id).filter(id => isMinor(db, id, new Date(now)));
  const noConsent = kids.filter(id => !hasActiveConsent(db, id));

  return {
    period: { from: f, to: t },
    teachers: teachers.map(x => ({ teacher_id: x.teacher_id, name: x.name, lessons: x.lessons, done: x.done, cancelled: x.cancelled, hours: Math.round(x.minutes / 60 * 100) / 100 })),
    groups: { items: groups, seats, enrolled: taken, fill_rate: rate(taken, seats) },
    attendance: { booked: att.booked, attended, rate: rate(attended, att.booked) },
    retention: { previous_students: prev.length, retained, rate: rate(retained, prev.length) },
    cancellations: { lessons: cl.c, enrollments: ce.c },
    emergency_calls: { total: calls.reduce((s, c) => s + c.n, 0), by_lesson: calls },
    consents: { children_total: kids.length, children_without_consent: noConsent.length, candidate_ids: noConsent },
  };
}

export type AuditRow = { id: number; ts: string; actor_id: number | null; action: string; target_type: string | null; target_id: number | null; outcome: string };

/** Страница журнала, новые сверху. before — вернуть записи с id < before. next_before — курсор следующей страницы (null — конец). */
export function readAuditPage(db: DatabaseSync, a: Actor, limit: number = AUDIT_DEFAULT_LIMIT, before?: number) {
  requireOwner(db, a, 'audit.read');
  const lim = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, AUDIT_MAX_LIMIT) : AUDIT_DEFAULT_LIMIT;
  const rows = (before === undefined
    ? db.prepare('SELECT id, ts, actor_id, action, target_type, target_id, outcome FROM audit_log ORDER BY id DESC LIMIT ?').all(lim + 1)
    : db.prepare('SELECT id, ts, actor_id, action, target_type, target_id, outcome FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, lim + 1)) as AuditRow[];
  const more = rows.length > lim;
  const entries = more ? rows.slice(0, lim) : rows;
  return { entries, limit: lim, next_before: more ? entries[entries.length - 1].id : null };
}
