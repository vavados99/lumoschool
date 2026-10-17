// Расписание (Ф3). Вход — токен сессии: роль берётся из БАЗЫ по сессии, не из запроса.
// Нет сессии / просрочена → отказ + запись в журнал. Контактных колонок нет ни в одном запросе.
import type { DatabaseSync } from 'node:sqlite';
import { currentUser } from './auth.ts';
import { type Actor, type Audience, DEFAULT_CAPACITY, setLessonCapacity, Denied, ScheduleError, audit, guard, enroll, cancelEnrollment, toMs } from './access.ts';

export type Student = { id: number; display_name: string; level: string | null };
export type LessonView = {
  id: number; teacher_id: number; teacher_name: string; starts_at: string; duration_min: number; status: string;
  students: Student[];
};

export function requireActor(db: DatabaseSync, token: string, now: number): Actor {
  const a = currentUser(db, token, now);
  if (!a) {
    audit(db, null, 'session.required', 'session', null, 'denied');
    throw new Denied('no valid session');
  }
  return a;
}

/** Преподаватель создаёт слот. Время — ISO; пересечение со своими неотменёнными слотами и прошлое — отказ. */
export function createSlot(db: DatabaseSync, token: string, now: number, startsAt: string, durationMin = 50, audience: Audience = 'minor'): number {
  const a = requireActor(db, token, now);
  guard(db, a, 'slots.create', 'lesson', null, () => true);
  const refuse = (action: string, msg: string): never => { audit(db, a, action, 'lesson', null, 'denied'); throw new ScheduleError(msg); };
  const start = typeof startsAt === 'string' ? toMs(startsAt) : NaN;
  if (!Number.isFinite(start)) refuse('slot.bad_time', 'invalid start time');
  if (!Number.isInteger(durationMin) || durationMin < 15 || durationMin > 180) refuse('slot.bad_duration', 'duration must be 15..180 minutes');
  if (!(audience in DEFAULT_CAPACITY)) refuse('slot.bad_audience', 'audience must be minor or adult');
  if (start <= now) refuse('slot.past', 'slot is in the past');
  const end = start + durationMin * 60_000;
  const mine = db.prepare(`SELECT starts_at, duration_min FROM lessons WHERE teacher_id = ? AND status != 'cancelled'`).all(a.id) as { starts_at: string; duration_min: number }[];
  if (mine.some(m => toMs(m.starts_at) < end && toMs(m.starts_at) + m.duration_min * 60_000 > start)) refuse('slot.overlap', 'slot overlaps another slot of this teacher');
  const id = Number(db.prepare('INSERT INTO lessons(teacher_id, starts_at, duration_min, audience, max_students) VALUES (?,?,?,?,?)').run(a.id, new Date(start).toISOString(), durationMin, audience, DEFAULT_CAPACITY[audience]).lastInsertRowid);
  audit(db, a, 'slot.created', 'lesson', id, 'allowed');
  return id;
}

/** Родитель — за своего ребёнка; ученик 16+ — за себя; владелец — за любого. */
export function enrollMe(db: DatabaseSync, token: string, now: number, lessonId: number, studentId: number) {
  enroll(db, requireActor(db, token, now), lessonId, studentId, now);
}
export function cancelMine(db: DatabaseSync, token: string, now: number, lessonId: number, studentId: number) {
  cancelEnrollment(db, requireActor(db, token, now), lessonId, studentId, now);
}

/** Владелец меняет лимит группы урока. */
export function changeCapacity(db: DatabaseSync, token: string, now: number, lessonId: number, max: number) {
  setLessonCapacity(db, requireActor(db, token, now), lessonId, max);
}

/** Уроки «для меня» по роли. У каждой роли свой запрос. */
export function myLessons(db: DatabaseSync, token: string, now: number): LessonView[] {
  const a = requireActor(db, token, now);
  const perm = a.role === 'owner' ? 'lessons.read_all' : a.role === 'parent' ? 'child_lessons.read' : 'own_lessons.read';
  guard(db, a, perm, 'lesson', null, () => true);
  const cols = `SELECT DISTINCT l.id, l.teacher_id, t.display_name AS teacher_name, l.starts_at, l.duration_min, l.status
    FROM lessons l JOIN users t ON t.id = l.teacher_id`;
  let rows: Omit<LessonView, 'students'>[];
  let studentsOf: (lessonId: number) => Student[];
  const sel = `SELECT u.id, u.display_name, s.level FROM lesson_enrollments e JOIN users u ON u.id = e.student_id
    JOIN students s ON s.user_id = u.id WHERE e.lesson_id = ? AND e.status = 'active'`;
  switch (a.role) {
    case 'teacher':
      rows = db.prepare(`${cols} WHERE l.teacher_id = ? ORDER BY l.starts_at, l.id`).all(a.id) as typeof rows;
      studentsOf = id => db.prepare(`${sel} ORDER BY u.id`).all(id) as Student[];
      break;
    case 'student':
      rows = db.prepare(`${cols} JOIN lesson_enrollments e ON e.lesson_id = l.id
        WHERE e.student_id = ? AND e.status = 'active' ORDER BY l.starts_at, l.id`).all(a.id) as typeof rows;
      studentsOf = id => db.prepare(`${sel} AND u.id = ?`).all(id, a.id) as Student[];
      break;
    case 'parent':
      rows = db.prepare(`${cols} JOIN lesson_enrollments e ON e.lesson_id = l.id
        JOIN parent_child pc ON pc.child_id = e.student_id
        WHERE pc.parent_id = ? AND e.status = 'active' ORDER BY l.starts_at, l.id`).all(a.id) as typeof rows;
      studentsOf = id => db.prepare(`${sel} AND u.id IN (SELECT child_id FROM parent_child WHERE parent_id = ?) ORDER BY u.id`).all(id, a.id) as Student[];
      break;
    case 'owner':
      rows = db.prepare(`${cols} ORDER BY l.starts_at, l.id`).all() as typeof rows;
      studentsOf = id => db.prepare(`${sel} ORDER BY u.id`).all(id) as Student[];
      break;
    default: rows = []; studentsOf = () => [];
  }
  return rows.map(r => ({ ...r, students: studentsOf(r.id) }));
}
