// Ф6: сообщения только внутри платформы, взрослый–ребёнок — только в ветке с родителем.
// Ветка = (преподаватель, ученик). Участников не храним: доступ вычисляется из базы КАЖДЫЙ раз
// (сняли связь/запись — доступ пропал сразу). Тела сообщений в журнал не попадают.
import type { DatabaseSync } from 'node:sqlite';
import { audit, guard, inTx, Denied, isUnderAdultAge, ADULT_AGE, teacherSharesLesson, type Actor } from './access.ts';

export { ADULT_AGE };   // моложе 18 = ребёнок (строже, чем 16 в isMinor из access.ts); единое определение — в access.ts
export const MAX_BODY = 2000;

export class MessageRejected extends Denied {
  reason: string;
  constructor(reason: string, msg: string) { super(msg); this.name = 'MessageRejected'; this.reason = reason; }
}

/** Ребёнок = младше 18. Нет даты рождения — как ребёнок (безопаснее). */
export function isChild(db: DatabaseSync, userId: number, today = new Date()): boolean {
  return isUnderAdultAge(db, userId, today);
}

// ---------- фильтр личных каналов ----------
// Юникод-границы слова: \b в JS работает только для латиницы, кириллицу не видит.
const word = (p: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${p})(?![\\p{L}\\p{N}_])`, 'u');
const DIGIT_WORDS = 'zero|one|two|three|four|five|six|seven|eight|nine|ноль|нуль|один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|jeden|dwa|trzy|cztery|pięć|sześć|siedem|osiem|dziewięć|нiль|чотири|п.ять|шість|сім|вісім|дев.ять';
const SPELLED_PHONE = new RegExp(`(?:(?<![\\p{L}])(?:${DIGIT_WORDS})(?![\\p{L}])[\\s,.\\-]*){7,}`, 'u');
const MESSENGER = word('telegram|телеграмм?|whats\\s*app|ватсап|вотсап|вацап|viber|вайбер|вибер|skype|скайп|discord|дискорд|instagram|инстаграм|snapchat|facebook|messenger|tiktok|тг|tg');
const DOG_WORD = word('собак[аиуе]|собачк[аиуе]|psiak|małpa|malpa|песик');
const TLD = 'com|net|org|ru|ua|pl|io|eu|ly|gl|link|info|biz|app|dev|xyz|tv|cc|co';
const DOT = '(?:\\.|\\(\\s*dot\\s*\\)|\\[\\s*dot\\s*\\]|\\{\\s*dot\\s*\\}|\\s+dot\\s+|\\s+точка\\s+)';
const DATE_RE = /(?<![\d.\-/+])(?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-](?:\d{4}|\d{2})(?![\d]|[./-]\d)/g;
const ISO_RE = /(?<![\d.\-/+])\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?![\d]|-\d)/g;
const TIME_RE = /(?<![\d.:\-/+])(?:[01]?\d|2[0-3]):[0-5]\d(?!\d|[:.\-]\d)/g;

/** Приводим к виду, в котором обходы видны: NFKC (полноширинные @ и цифры), без невидимых символов. */
export function normalizeForScan(s: string): string {
  return s.normalize('NFKC').replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '').toLowerCase();
}

/** Возвращает причину отказа или null. Ложные срабатывания допустимы (безопаснее отказать), но даты и время не считаем телефоном. */
export function findContactLeak(raw: string): { reason: string; message: string } | null {
  const t = normalizeForScan(raw);
  // e-mail и ники (раньше ссылок: «kida собака example точка com» — это почта)
  if (/@/.test(t) || /[\[({<]\s*(?:at|dog)\s*[\])}>]/.test(t) || DOG_WORD.test(t)
      || /(?<![\p{L}\p{N}])[\w.-]+\s+at\s+[\w-]+\s*(?:\.|\s+dot\s+|\s+точка\s+)\s*[\w-]+/u.test(t))
    return { reason: 'email_or_handle', message: 'E-mail addresses and @handles are not allowed in messages.' };
  // ссылки и мессенджеры
  if (/(?:https?|ftp):\/\/|\bwww\s*\./.test(t) || /(?<![\p{L}\p{N}])(?:t|wa)\s*(?:\.|\(\s*dot\s*\)|\s+dot\s+)\s*me(?![\p{L}\p{N}])/u.test(t))
    return { reason: 'link', message: 'Links are not allowed in messages: communication stays inside the platform.' };
  if (new RegExp(`[\\w-]+\\s*${DOT}\\s*(?:${TLD})(?![\\p{L}\\p{N}])`, 'u').test(t))
    return { reason: 'link', message: 'Web addresses are not allowed in messages: communication stays inside the platform.' };
  if (MESSENGER.test(t))
    return { reason: 'messenger', message: 'Naming outside messengers is not allowed: communication stays inside the platform.' };
  // телефоны: сначала убираем настоящие даты и время
  const d = t.replace(DATE_RE, ' ').replace(ISO_RE, ' ').replace(TIME_RE, ' ');
  for (const m of d.match(/\+?\d[\d\s().\-–—_/]{4,}\d/g) ?? []) {
    if (m.replace(/\D/g, '').length >= 7) return { reason: 'phone', message: 'Phone numbers are not allowed in messages.' };
  }
  if (SPELLED_PHONE.test(d)) return { reason: 'phone', message: 'Phone numbers (even spelled out) are not allowed in messages.' };
  if ((d.match(/\d/g) ?? []).length >= 10) return { reason: 'phone', message: 'Too many digits: phone numbers are not allowed in messages.' };
  return null;
}

// ---------- доступ ----------
function parentsOf(db: DatabaseSync, childId: number): number[] {
  return (db.prepare('SELECT parent_id FROM parent_child WHERE child_id = ?').all(childId) as { parent_id: number }[]).map(r => r.parent_id);
}
/** У преподавателя есть реальная запись: активная запись ученика на неотменённый урок ЭТОГО преподавателя. */
function teacherHasLesson(db: DatabaseSync, teacherId: number, studentId: number): boolean {
  return !!db.prepare(
    `SELECT 1 FROM lessons l JOIN lesson_enrollments e ON e.lesson_id = l.id
     WHERE l.teacher_id = ? AND e.student_id = ? AND e.status = 'active' AND l.status != 'cancelled'`).get(teacherId, studentId);
}
type Thread = { id: number; teacher_id: number; student_id: number };

/** Ф18: родитель получает уведомление о КАЖДОЙ реплике преподавателя его ребёнку (в ветке и в чате комнаты). Текста в уведомлении нет. */
export function notifyParents(db: DatabaseSync, childId: number, kind: 'thread_message' | 'room_message', refId: number) {
  if (!isChild(db, childId)) return;
  const ins = db.prepare('INSERT INTO parent_notifications(parent_id, child_id, kind, ref_id) VALUES (?,?,?,?)');
  for (const p of parentsOf(db, childId)) ins.run(p, childId, kind, refId);
}

/** Ф18: уведомления родителя о репликах преподавателя его ребёнку (только свои; без текста). Каждое чтение в журнале — через guard. */
export function listNotifications(db: DatabaseSync, a: Actor): { id: number; child_id: number; kind: string; ref_id: number; created_at: string }[] {
  guard(db, a, 'notifications.read', 'parent_notifications', null, () => a.role === 'parent');
  return db.prepare('SELECT id, child_id, kind, ref_id, created_at FROM parent_notifications WHERE parent_id = ? ORDER BY id DESC LIMIT 200').all(a.id) as never;
}

/** Может ли актёр участвовать в ветке (читать и писать). Ребёнок без родителя — ветка закрыта для всех.
 *  Ф18: преподаватель — только пока урок не отменён и не вышло окно доступа после его конца (TEACHER_ACCESS_GRACE_MS). */
function isParticipant(db: DatabaseSync, a: Actor, th: Thread, now: number = Date.now()): boolean {
  const child = isChild(db, th.student_id);
  if (child && parentsOf(db, th.student_id).length === 0) return false;
  if (!teacherHasLesson(db, th.teacher_id, th.student_id)) return false;   // нет урока — ветка мертва для всех
  switch (a.role) {
    case 'teacher': return a.id === th.teacher_id && teacherSharesLesson(db, th.teacher_id, th.student_id, now);
    case 'student': return a.id === th.student_id;
    case 'parent': return child && parentsOf(db, th.student_id).includes(a.id);   // родитель взрослого ученика не видит
    default: return false;
  }
}

/** Открыть (или найти) ветку преподаватель–ученик. Открывает: сам преподаватель, сам ученик, родитель ребёнка. */
export function openThread(db: DatabaseSync, a: Actor, teacherId: number, studentId: number, now: number = Date.now()): number {
  return inTx(db, () => {
    const probe: Thread = { id: 0, teacher_id: teacherId, student_id: studentId };
    const isStudent = db.prepare(`SELECT 1 FROM users WHERE id = ? AND role = 'student'`).get(studentId);
    const isTeacher = db.prepare(`SELECT 1 FROM users WHERE id = ? AND role = 'teacher'`).get(teacherId);
    guard(db, a, 'message.thread.send', 'thread', null, () => !!isStudent && !!isTeacher && isParticipant(db, a, probe, now));
    const ex = db.prepare('SELECT id FROM msg_threads WHERE teacher_id = ? AND student_id = ?').get(teacherId, studentId) as { id: number } | undefined;
    if (ex) return ex.id;
    const id = Number(db.prepare('INSERT INTO msg_threads(teacher_id, student_id, created_by) VALUES (?,?,?)').run(teacherId, studentId, a.id).lastInsertRowid);
    audit(db, a, 'message.thread.opened', 'thread', id, 'allowed');
    return id;
  });
}

function loadThread(db: DatabaseSync, id: number): Thread | undefined {
  return db.prepare('SELECT id, teacher_id, student_id FROM msg_threads WHERE id = ?').get(id) as Thread | undefined;
}

/** Отправка. Права → принадлежность → фильтр каналов → запись. Отказ пишется в журнал БЕЗ текста. */
export function postMessage(db: DatabaseSync, a: Actor, threadId: number, body: string, now: number = Date.now()): number {
  return inTx(db, () => {
    const th = loadThread(db, threadId);
    guard(db, a, 'message.thread.send', 'thread', threadId, () => !!th && isParticipant(db, a, th, now));
    const refuse = (reason: string, msg: string): never => {
      audit(db, a, `message.rejected.${reason}`, 'thread', threadId, 'denied');
      throw new MessageRejected(reason, msg);
    };
    if (typeof body !== 'string' || !body.trim()) refuse('empty', 'Message is empty.');
    if (body.length > MAX_BODY) refuse('too_long', `Message is longer than ${MAX_BODY} characters.`);
    const leak = findContactLeak(body);
    if (leak) refuse(leak.reason, leak.message);
    const id = Number(db.prepare('INSERT INTO msg_posts(thread_id, from_id, body) VALUES (?,?,?)').run(threadId, a.id, body).lastInsertRowid);
    audit(db, a, 'message.sent', 'thread', threadId, 'allowed');
    if (a.role === 'teacher') notifyParents(db, th!.student_id, 'thread_message', threadId);   // Ф18: родитель узнаёт о реплике преподавателя
    return id;
  });
}

/** «Напрямую» человеку: ребёнку — всегда отказ (только ветка с родителем); взрослому ученику/преподавателю — через их ветку. */
export function sendDirect(db: DatabaseSync, a: Actor, toId: number, body: string): number {
  const to = db.prepare('SELECT id, role FROM users WHERE id = ?').get(toId) as { id: number; role: string } | undefined;
  if (to?.role === 'student' && isChild(db, to.id) && a.role !== 'parent') {
    return inTx(db, () => {
      audit(db, a, 'message.direct_to_child', 'user', toId, 'denied');
      throw new Denied('direct messages to a child are not allowed: use the thread with the parent');
    });
  }
  const pair = a.role === 'teacher' && to?.role === 'student' ? { t: a.id, s: to.id }
    : a.role === 'student' && to?.role === 'teacher' ? { t: to.id, s: a.id } : null;
  if (!pair) return inTx(db, () => { audit(db, a, 'message.direct_bad_target', 'user', toId, 'denied'); throw new Denied('direct message denied'); });
  return postMessage(db, a, openThread(db, a, pair.t, pair.s), body);
}

export type Post = { id: number; from_id: number; from_name: string; body: string; created_at: string };

/** Чтение ветки: участник — да; владелец — только при выданном праве message.read_any. Каждое чтение в журнале. */
export function readThread(db: DatabaseSync, a: Actor, threadId: number, now: number = Date.now()): Post[] {
  return inTx(db, () => {
    const th = loadThread(db, threadId);
    if (a.role === 'owner') guard(db, a, 'message.read_any', 'thread', threadId, () => !!th);
    else guard(db, a, 'message.thread.read', 'thread', threadId, () => !!th && isParticipant(db, a, th, now));
    return db.prepare(`SELECT p.id, p.from_id, u.display_name AS from_name, p.body, p.created_at
      FROM msg_posts p JOIN users u ON u.id = p.from_id WHERE p.thread_id = ? ORDER BY p.id`).all(threadId) as Post[];
  });
}

/** Мои ветки (id). Только те, где я участник сейчас. Владелец — пусто без права message.read_any. */
export function listThreads(db: DatabaseSync, a: Actor, now: number = Date.now()): number[] {
  const rows = db.prepare('SELECT id, teacher_id, student_id FROM msg_threads ORDER BY id').all() as Thread[];
  if (a.role === 'owner') {
    const has = db.prepare(`SELECT 1 FROM role_permissions WHERE role = 'owner' AND permission = 'message.read_any'`).get();
    return has ? rows.map(r => r.id) : [];
  }
  return rows.filter(r => isParticipant(db, a, r, now)).map(r => r.id);
}
