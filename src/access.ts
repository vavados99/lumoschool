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

function audit(db: DatabaseSync, a: Actor | null, action: string, tt: string | null, tid: number | null, outcome: 'allowed' | 'denied') {
  db.prepare('INSERT INTO audit_log(actor_id, action, target_type, target_id, outcome) VALUES (?,?,?,?,?)')
    .run(a?.id ?? null, action, tt, tid, outcome);
}

function guard(db: DatabaseSync, a: Actor, perm: string, tt: string | null, tid: number | null, ownershipOk: () => boolean) {
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
     WHERE l.teacher_id = ? AND e.student_id = ?`).get(teacherId, studentId);
}
function isParentOf(db: DatabaseSync, parentId: number, childId: number): boolean {
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
export function getProfile(db: DatabaseSync, a: Actor, targetId: number): Profile {
  const q = () => db.prepare(
    `SELECT u.id, u.display_name, s.level FROM users u JOIN students s ON s.user_id = u.id WHERE u.id = ?`).get(targetId) as Profile | undefined;
  let perm: string, ok: boolean;
  switch (a.role) {
    case 'student': perm = 'own_profile.read'; ok = a.id === targetId; break;
    case 'parent': perm = 'child_profile.read'; ok = isParentOf(db, a.id, targetId); break;
    case 'teacher': perm = 'lesson_students.read'; ok = teacherSharesLesson(db, a.id, targetId); break;
    case 'owner': perm = 'students.read_all'; ok = true; break;
    default: perm = 'none'; ok = false;
  }
  guard(db, a, perm, 'student', targetId, () => ok);
  const p = q();
  if (!p) throw new Denied('not found');
  return p;
}

/** Список учеников: у каждой роли свой запрос; контактных колонок нет ни в одном. */
export function listStudents(db: DatabaseSync, a: Actor): Profile[] {
  guard(db, a, a.role === 'owner' ? 'students.read_all' : a.role === 'teacher' ? 'lesson_students.read'
    : a.role === 'parent' ? 'child_profile.read' : 'own_profile.read', 'student', null, yes);
  const base = `SELECT DISTINCT u.id, u.display_name, s.level FROM users u JOIN students s ON s.user_id = u.id`;
  switch (a.role) {
    case 'owner': return db.prepare(`${base} ORDER BY u.id`).all() as Profile[];
    case 'teacher': return db.prepare(
      `${base} JOIN lesson_enrollments e ON e.student_id = u.id JOIN lessons l ON l.id = e.lesson_id
       WHERE l.teacher_id = ? ORDER BY u.id`).all(a.id) as Profile[];
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

export function grantConsent(db: DatabaseSync, a: Actor, childId: number) {
  guard(db, a, 'consent.grant', 'student', childId, () => isParentOf(db, a.id, childId));
  db.prepare(`INSERT INTO parental_consents(child_id, parent_id, granted_at) VALUES (?,?,datetime('now'))`).run(childId, a.id);
}
export function hasActiveConsent(db: DatabaseSync, childId: number): boolean {
  return !!db.prepare('SELECT 1 FROM parental_consents WHERE child_id = ? AND revoked_at IS NULL').get(childId);
}

/** Запись на урок. Ребёнок до 16 без активного согласия родителя — нельзя. */
export function enroll(db: DatabaseSync, a: Actor, lessonId: number, studentId: number) {
  const perm = a.role === 'parent' ? 'child_lessons.enroll' : 'lessons.enroll';
  guard(db, a, perm, 'lesson', lessonId, () => a.role !== 'parent' || isParentOf(db, a.id, studentId));
  if (isMinor(db, studentId) && !hasActiveConsent(db, studentId)) {
    audit(db, a, 'enroll.no_consent', 'student', studentId, 'denied');
    throw new Denied('no parental consent');
  }
  db.prepare('INSERT OR IGNORE INTO lesson_enrollments(lesson_id, student_id) VALUES (?,?)').run(lessonId, studentId);
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
         JOIN lessons l ON l.id = e.lesson_id WHERE pc.parent_id = ? AND l.teacher_id = ?`).get(toId, a.id);
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
