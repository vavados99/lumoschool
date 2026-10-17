// Слой доступа. Роль берётся ИЗ БАЗЫ по id, а не со слов вызывающего.
// Каждая операция: 1) проверка права по role_permissions (запрещено по умолчанию),
// 2) проверка принадлежности («это точно твоё?»), 3) запись в журнал.
import type { DatabaseSync } from 'node:sqlite';

export type Role = 'student' | 'parent' | 'teacher' | 'owner';
export type Actor = { id: number; role: Role };
export class Denied extends Error {
  constructor(msg: string) { super(msg); this.name = 'Denied'; }
}

export function actorOf(db: DatabaseSync, userId: number): Actor {
  const r = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId) as Actor | undefined;
  if (!r) throw new Denied('unknown user');
  return { id: r.id, role: r.role };
}

export function audit(db: DatabaseSync, a: Actor | null, action: string, tt: string | null, tid: number | null, outcome: 'allowed' | 'denied') {
  db.prepare('INSERT INTO audit_log(actor_id, action, target_type, target_id, outcome) VALUES (?,?,?,?,?)')
    .run(a?.id ?? null, action, tt, tid, outcome);
}

export function guard(db: DatabaseSync, a: Actor, perm: string, tt: string | null, tid: number | null, ownershipOk: () => boolean) {
  const has = db.prepare('SELECT 1 FROM role_permissions WHERE role = ? AND permission = ?').get(a.role, perm);
  if (!has || !ownershipOk()) {
    audit(db, a, perm, tt, tid, 'denied');
    throw new Denied(`${perm} denied`);
  }
  audit(db, a, perm, tt, tid, 'allowed');
}

const yes = () => true;

function teacherSharesLesson(db: DatabaseSync, teacherId: number, studentId: number): boolean {
  return !!db.prepare(
    `SELECT 1 FROM lessons l JOIN lesson_enrollments e ON e.lesson_id = l.id
     WHERE l.teacher_id = ? AND e.student_id = ? AND e.status = 'active'`).get(teacherId, studentId);
}
/** Ф5: уроки, на которых user — заменяющий СЕЙЧАС: замена назначена, урок не отменён/не проведён и ещё не закончился. */
export function activeSubstituteLessons(db: DatabaseSync, userId: number, now: number): number[] {
  const rows = db.prepare(`SELECT id, starts_at, duration_min FROM lessons WHERE substitute_id = ? AND status = 'planned'`).all(userId) as { id: number; starts_at: string; duration_min: number }[];
  return rows.filter(r => toMs(r.starts_at) + r.duration_min * 60_000 > now).map(r => r.id);
}
function substituteSeesStudent(db: DatabaseSync, userId: number, studentId: number, now: number): boolean {
  const ids = activeSubstituteLessons(db, userId, now);
  if (!ids.length) return false;
  return !!db.prepare(`SELECT 1 FROM lesson_enrollments WHERE student_id = ? AND status = 'active' AND lesson_id IN (${ids.map(() => '?').join(',')})`).get(studentId, ...ids);
}
export function isParentOf(db: DatabaseSync, parentId: number, childId: number): boolean {
  return !!db.prepare('SELECT 1 FROM parent_child WHERE parent_id = ? AND child_id = ?').get(parentId, childId);
}
export function isMinor(db: DatabaseSync, userId: number, today = new Date()): boolean {
  const r = db.prepare('SELECT birth_date FROM users WHERE id = ?').get(userId) as { birth_date: string | null } | undefined;
  if (!r?.birth_date) return true; // неизвестный возраст = как ребёнок (безопаснее)
  const b = new Date(r.birth_date);
  const age = today.getFullYear() - b.getFullYear() - (today < new Date(today.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0);
  return age < 16;
}

export type Profile = { id: number; display_name: string; level: string | null };

/** Профиль без контактов (в запросе контактных колонок нет). */
export function getProfile(db: DatabaseSync, a: Actor, targetId: number, now = Date.now()): Profile {
  const q = () => db.prepare(
    `SELECT u.id, u.display_name, s.level FROM users u JOIN students s ON s.user_id = u.id WHERE u.id = ?`).get(targetId) as Profile | undefined;
  let perm: string, ok: boolean;
  switch (a.role) {
    case 'student': perm = 'own_profile.read'; ok = a.id === targetId; break;
    case 'parent': perm = 'child_profile.read'; ok = isParentOf(db, a.id, targetId); break;
    case 'teacher': perm = 'lesson_students.read'; ok = teacherSharesLesson(db, a.id, targetId) || substituteSeesStudent(db, a.id, targetId, now); break;
    case 'owner': perm = 'students.read_all'; ok = true; break;
    default: perm = 'none'; ok = false;
  }
  guard(db, a, perm, 'student', targetId, () => ok);
  const p = q();
  if (!p) throw new Denied('not found');
  return p;
}

/** Список учеников: у каждой роли свой запрос; контактных колонок нет ни в одном. */
export function listStudents(db: DatabaseSync, a: Actor, now = Date.now()): Profile[] {
  guard(db, a, a.role === 'owner' ? 'students.read_all' : a.role === 'teacher' ? 'lesson_students.read'
    : a.role === 'parent' ? 'child_profile.read' : 'own_profile.read', 'student', null, yes);
  const base = `SELECT DISTINCT u.id, u.display_name, s.level FROM users u JOIN students s ON s.user_id = u.id`;
  switch (a.role) {
    case 'owner': return db.prepare(`${base} ORDER BY u.id`).all() as Profile[];
    case 'teacher': {
      const sub = activeSubstituteLessons(db, a.id, now);   // замена: только эти уроки
      return db.prepare(
        `${base} JOIN lesson_enrollments e ON e.student_id = u.id JOIN lessons l ON l.id = e.lesson_id
         WHERE (l.teacher_id = ? OR l.id IN (${sub.length ? sub.map(() => '?').join(',') : 'NULL'})) AND e.status = 'active' ORDER BY u.id`).all(a.id, ...sub) as Profile[];
    }
    case 'parent': return db.prepare(
      `${base} JOIN parent_child pc ON pc.child_id = u.id WHERE pc.parent_id = ? ORDER BY u.id`).all(a.id) as Profile[];
    case 'student': return db.prepare(`${base} WHERE u.id = ?`).all(a.id) as Profile[];
    default: return [];
  }
}

export type Contacts = { email: string | null; phone: string | null };
/** Сейф: свои — всегда; чужие — только владелец. Преподаватель — никогда. */
export function getContacts(db: DatabaseSync, a: Actor, targetId: number): Contacts {
  const own = a.id === targetId;
  const perm = own ? 'own_contacts.read' : 'contacts.read_any';
  guard(db, a, perm, 'contact_vault', targetId, yes);
  const r = db.prepare('SELECT email, phone FROM contact_vault WHERE user_id = ?').get(targetId) as Contacts | undefined;
  return r ?? { email: null, phone: null };
}

/** Типы согласий. Для записи на урок обязателен только 'data_processing'. */
export const CONSENT_SCOPES = ['data_processing', 'lesson_recording'] as const;
export type ConsentScope = typeof CONSENT_SCOPES[number];
/** Версия текста согласия, показанного сейчас (текст изменился — новая версия и новое согласие). */
export const CURRENT_CONSENT_VERSION = '2026-10-v1';

/** Родитель даёт согласие за СВОЕГО ребёнка. Повтор (родитель, ребёнок, тип) при активном согласии строк не плодит. */
export function grantConsent(db: DatabaseSync, a: Actor, childId: number, scope: ConsentScope = 'data_processing',
                             textVersion: string = CURRENT_CONSENT_VERSION, now = Date.now()) {
  inTx(db, () => {
    guard(db, a, 'consent.grant', 'student', childId, () => isParentOf(db, a.id, childId));
    if (!CONSENT_SCOPES.includes(scope) || typeof textVersion !== 'string' || !textVersion.trim()) {
      audit(db, a, 'consent.bad_input', 'student', childId, 'denied');
      throw new Denied('bad consent scope or text version');
    }
    if (db.prepare('SELECT 1 FROM parental_consents WHERE child_id=? AND parent_id=? AND scope=? AND revoked_at IS NULL').get(childId, a.id, scope)) return;
    db.prepare('INSERT INTO parental_consents(child_id, parent_id, scope, granted_at, text_version) VALUES (?,?,?,?,?)')
      .run(childId, a.id, scope, new Date(now).toISOString(), textVersion.trim());
    audit(db, a, `consent.granted.${scope}`, 'student', childId, 'allowed');
  });
}
export function hasActiveConsent(db: DatabaseSync, childId: number, scope: ConsentScope = 'data_processing'): boolean {
  return !!db.prepare('SELECT 1 FROM parental_consents WHERE child_id = ? AND scope = ? AND revoked_at IS NULL').get(childId, scope);
}

export class ScheduleError extends Error {
  constructor(msg: string) { super(msg); this.name = 'ScheduleError'; }
}
export const toMs = (iso: string) => Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : iso + 'Z');

/** Лимит группы по умолчанию (Ф4). Те же числа — DEFAULT в db/schema.sql ('minor' = 6). */
export const DEFAULT_CAPACITY = { minor: 6, adult: 8 } as const;
export type Audience = keyof typeof DEFAULT_CAPACITY;

/** Проверка и запись — в одной транзакции BEGIN IMMEDIATE (write-lock берётся ДО проверок:
 *  два параллельных вызова идут по очереди). Ожидаемые отказы (Denied/ScheduleError) коммитятся —
 *  в базе к этому моменту только записи журнала, и отказ обязан остаться в журнале. Прочее — ROLLBACK. */
export function inTx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec(e instanceof Denied || e instanceof ScheduleError ? 'COMMIT' : 'ROLLBACK');
    throw e;
  }
}

/** Владелец меняет лимит группы. Не-владелец — отказ + журнал. Ниже числа уже записанных — отказ. */
export function setLessonCapacity(db: DatabaseSync, a: Actor, lessonId: number, max: number) {
  inTx(db, () => {
    guard(db, a, 'lessons.set_capacity', 'lesson', lessonId, () => a.role === 'owner');
    const refuse = (action: string, msg: string): never => { audit(db, a, action, 'lesson', lessonId, 'denied'); throw new ScheduleError(msg); };
    if (!Number.isInteger(max) || max < 1 || max > 50) refuse('capacity.bad_value', 'capacity must be an integer 1..50');
    if (!db.prepare('SELECT 1 FROM lessons WHERE id = ?').get(lessonId)) refuse('capacity.no_lesson', 'lesson not found');
    const n = (db.prepare(`SELECT COUNT(*) c FROM lesson_enrollments WHERE lesson_id = ? AND status = 'active'`).get(lessonId) as { c: number }).c;
    if (max < n) refuse('capacity.below_enrolled', 'capacity is below the number of enrolled students');
    db.prepare('UPDATE lessons SET max_students = ? WHERE id = ?').run(max, lessonId);
    audit(db, a, 'capacity.changed', 'lesson', lessonId, 'allowed');
  });
}

/** Запись на урок. Правила: право роли; «своё» (родитель — только свой ребёнок; ученик — только себя и только 16+);
 *  согласие родителя до 16; урок существует, не отменён, не в прошлом; двойная запись — отказ. */
export function enroll(db: DatabaseSync, a: Actor, lessonId: number, studentId: number, now = Date.now()) {
  inTx(db, () => enrollTx(db, a, lessonId, studentId, now));
}
function enrollTx(db: DatabaseSync, a: Actor, lessonId: number, studentId: number, now: number) {
  const perm = a.role === 'parent' ? 'child_lessons.enroll' : 'lessons.enroll';
  const own = () => a.role === 'parent' ? isParentOf(db, a.id, studentId)
    : a.role === 'student' ? a.id === studentId && !isMinor(db, studentId, new Date(now)) : true;
  guard(db, a, perm, 'lesson', lessonId, own);
  const refuse = (action: string, msg: string): never => {
    audit(db, a, action, 'lesson', lessonId, 'denied');
    throw new ScheduleError(msg);
  };
  const st = db.prepare('SELECT 1 FROM students WHERE user_id = ?').get(studentId);
  if (!st) refuse('enroll.not_student', 'target is not a student');
  if (isMinor(db, studentId, new Date(now)) && !hasActiveConsent(db, studentId)) {
    audit(db, a, 'enroll.no_consent', 'student', studentId, 'denied');
    throw new Denied('no parental consent');
  }
  const l = db.prepare('SELECT starts_at, status, duration_min, max_students FROM lessons WHERE id = ?').get(lessonId) as { starts_at: string; status: string; duration_min: number; max_students: number } | undefined;
  if (!l || l.status !== 'planned') refuse('enroll.no_lesson', 'lesson not available');
  if (toMs(l!.starts_at) <= now) refuse('enroll.past', 'lesson is in the past');
  const ex = db.prepare('SELECT status FROM lesson_enrollments WHERE lesson_id = ? AND student_id = ?').get(lessonId, studentId) as { status: string } | undefined;
  if (ex?.status === 'active') refuse('enroll.duplicate', 'already enrolled');
  const taken = (db.prepare(`SELECT COUNT(*) c FROM lesson_enrollments WHERE lesson_id = ? AND status = 'active'`).get(lessonId) as { c: number }).c;
  if (taken >= l!.max_students) refuse('enroll.full', 'group is full');
  const s0 = toMs(l!.starts_at), e0 = s0 + l!.duration_min * 60_000;
  const mine = db.prepare(`SELECT l.starts_at, l.duration_min FROM lesson_enrollments e JOIN lessons l ON l.id = e.lesson_id
    WHERE e.student_id = ? AND e.status = 'active' AND l.status != 'cancelled' AND l.id != ?`).all(studentId, lessonId) as { starts_at: string; duration_min: number }[];
  if (mine.some(m => toMs(m.starts_at) < e0 && toMs(m.starts_at) + m.duration_min * 60_000 > s0)) refuse('enroll.student_overlap', 'student already has a lesson at this time');
  if (ex) db.prepare(`UPDATE lesson_enrollments SET status='active', booked_by=?, cancelled_at=NULL WHERE lesson_id=? AND student_id=?`).run(a.id, lessonId, studentId);
  else db.prepare('INSERT INTO lesson_enrollments(lesson_id, student_id, booked_by) VALUES (?,?,?)').run(lessonId, studentId, a.id);
  audit(db, a, 'enroll.done', 'lesson', lessonId, 'allowed');
}

/** Отмена записи: родитель — своего ребёнка, ученик — свою, владелец — любую; преподаватель — нет. */
export function cancelEnrollment(db: DatabaseSync, a: Actor, lessonId: number, studentId: number, now = Date.now()) {
  inTx(db, () => cancelTx(db, a, lessonId, studentId, now));
}
function cancelTx(db: DatabaseSync, a: Actor, lessonId: number, studentId: number, now: number) {
  const perm = a.role === 'parent' ? 'child_lessons.cancel' : 'lessons.cancel';
  const own = () => a.role === 'parent' ? isParentOf(db, a.id, studentId) : a.role === 'student' ? a.id === studentId : true;
  guard(db, a, perm, 'lesson', lessonId, own);
  const r = db.prepare(`SELECT e.status, l.starts_at FROM lesson_enrollments e JOIN lessons l ON l.id = e.lesson_id
    WHERE e.lesson_id = ? AND e.student_id = ?`).get(lessonId, studentId) as { status: string; starts_at: string } | undefined;
  if (!r || r.status !== 'active' || toMs(r.starts_at) <= now) {
    audit(db, a, 'cancel.refused', 'lesson', lessonId, 'denied');
    throw new ScheduleError('no active future enrollment');
  }
  // Ф5: окно отмены. Ученик/родитель — не позже чем за N часов до начала; владелец — всегда.
  if (a.role !== 'owner' && toMs(r.starts_at) - now < getCancelWindowHours(db) * 3_600_000) {
    audit(db, a, 'cancel.too_late', 'lesson', lessonId, 'denied');
    throw new ScheduleError('cancellation window closed');
  }
  db.prepare(`UPDATE lesson_enrollments SET status='cancelled', cancelled_at=datetime('now') WHERE lesson_id=? AND student_id=?`).run(lessonId, studentId);
  if (a.role === 'owner' && toMs(r.starts_at) - now < getCancelWindowHours(db) * 3_600_000) audit(db, a, 'cancel.window_override', 'lesson', lessonId, 'allowed');
  audit(db, a, 'cancel.done', 'lesson', lessonId, 'allowed');
}

export const DEFAULT_CANCEL_WINDOW_HOURS = 24;
/** Окно отмены (часы до начала урока). Нет записи/мусор в настройке → 24 (безопасный дефолт). */
export function getCancelWindowHours(db: DatabaseSync): number {
  const r = db.prepare(`SELECT value FROM settings WHERE key = 'cancel_window_hours'`).get() as { value: string } | undefined;
  const n = r ? Number(r.value) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 720 ? n : DEFAULT_CANCEL_WINDOW_HOURS;
}
/** Только владелец. 0..720 часов, целое. Всё в журнал. */
export function setCancelWindowHours(db: DatabaseSync, a: Actor, hours: number) {
  inTx(db, () => {
    guard(db, a, 'settings.cancel_window', 'settings', null, () => a.role === 'owner');
    if (!Number.isInteger(hours) || hours < 0 || hours > 720) {
      audit(db, a, 'settings.bad_value', 'settings', null, 'denied');
      throw new ScheduleError('cancel window must be an integer 0..720 hours');
    }
    db.prepare(`INSERT INTO settings(key, value) VALUES ('cancel_window_hours', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(hours));
    audit(db, a, 'settings.cancel_window.changed', 'settings', null, 'allowed');
  });
}

/** Ф5: владелец назначает заменяющего на ОДИН урок. Заменяющий — преподаватель, не сам учитель урока; урок планируется и не закончился. */
export function assignSubstitute(db: DatabaseSync, a: Actor, lessonId: number, substituteId: number, now = Date.now()) {
  inTx(db, () => {
    guard(db, a, 'lessons.set_substitute', 'lesson', lessonId, () => a.role === 'owner');
    const refuse = (action: string, msg: string): never => { audit(db, a, action, 'lesson', lessonId, 'denied'); throw new ScheduleError(msg); };
    const l = db.prepare('SELECT teacher_id, starts_at, duration_min, status FROM lessons WHERE id = ?').get(lessonId) as { teacher_id: number; starts_at: string; duration_min: number; status: string } | undefined;
    if (!l || l.status !== 'planned' || toMs(l.starts_at) + l.duration_min * 60_000 <= now) refuse('substitute.no_lesson', 'lesson not available');
    if (!db.prepare('SELECT 1 FROM teachers t JOIN users u ON u.id = t.user_id WHERE t.user_id = ? AND u.role = \'teacher\'').get(substituteId)) refuse('substitute.not_teacher', 'substitute must be a teacher');
    if (l!.teacher_id === substituteId) refuse('substitute.same_teacher', 'substitute is the lesson teacher');
    db.prepare('UPDATE lessons SET substitute_id = ? WHERE id = ?').run(substituteId, lessonId);
    audit(db, a, 'substitute.assigned', 'lesson', lessonId, 'allowed');
  });
}
/** Снять замену — доступ заменяющего пропадает сразу. */
export function removeSubstitute(db: DatabaseSync, a: Actor, lessonId: number) {
  inTx(db, () => {
    guard(db, a, 'lessons.set_substitute', 'lesson', lessonId, () => a.role === 'owner');
    const r = db.prepare('UPDATE lessons SET substitute_id = NULL WHERE id = ? AND substitute_id IS NOT NULL').run(lessonId);
    audit(db, a, 'substitute.removed', 'lesson', lessonId, Number(r.changes) > 0 ? 'allowed' : 'denied');
  });
}

/** Сообщения. Преподаватель → несовершеннолетнему напрямую нельзя: только через родителя. */
export function sendMessage(db: DatabaseSync, a: Actor, toId: number, body: string) {
  const to = db.prepare('SELECT role FROM users WHERE id = ?').get(toId) as { role: Role } | undefined;
  const ok = () => {
    if (!to) return false;
    if (a.role === 'owner') return true;
    if (a.role !== 'teacher') return false;
    if (to.role === 'parent') {
      return !!db.prepare(
        `SELECT 1 FROM parent_child pc JOIN lesson_enrollments e ON e.student_id = pc.child_id
         JOIN lessons l ON l.id = e.lesson_id WHERE pc.parent_id = ? AND l.teacher_id = ? AND e.status = 'active'`).get(toId, a.id);
    }
    if (to.role === 'student') return !isMinor(db, toId) && teacherSharesLesson(db, a.id, toId);
    return false;
  };
  guard(db, a, 'message.send', 'user', toId, ok);
  db.prepare('INSERT INTO messages(from_id, to_id, body) VALUES (?,?,?)').run(a.id, toId, body);
}

export function readAudit(db: DatabaseSync, a: Actor) {
  guard(db, a, 'audit.read', 'audit_log', null, yes);
  return db.prepare('SELECT * FROM audit_log ORDER BY id').all();
}
