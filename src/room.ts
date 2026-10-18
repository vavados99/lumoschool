// Ф9: комната урока (серверная часть, видео — заглушка).
// Принципы: доступ вычисляется из базы КАЖДЫЙ раз; чужому и несуществующему уроку отвечаем одинаково (Denied → 403);
// контактов в ответах нет (в запросах нет контактных колонок); тексты чата в журнал не попадают.
// Допущены: активно записанный ученик (участник), родитель РЕБЁНКА (<18), записанного на урок (только наблюдатель, не пишет),
// назначенный ИЛИ замещающий преподаватель этого урока (оба сохраняют доступ), владелец.
import type { DatabaseSync } from 'node:sqlite';
import { audit, guard, inTx, hasActiveConsent, toMs, ScheduleError, type Actor } from './access.ts';
import { MessageRejected, MAX_BODY, findContactLeak, isChild, notifyParents } from './messages.ts';

export const ENTER_EARLY_MS = 10 * 60_000;   // пропуск не раньше чем за 10 минут до начала

export class RoomRefused extends ScheduleError {
  reason: string;
  constructor(reason: string) { super(reason); this.name = 'RoomRefused'; this.reason = reason; }
}

export type Mode = 'participant' | 'observer' | 'teacher' | 'owner';
type L = { id: number; teacher_id: number; substitute_id: number | null; starts_at: string; duration_min: number; status: string; recording: number };

const loadLesson = (db: DatabaseSync, id: number) =>
  db.prepare('SELECT id, teacher_id, substitute_id, starts_at, duration_min, status, recording FROM lessons WHERE id = ?').get(id) as L | undefined;

/** Кто актёр относительно ЭТОГО урока; null — никто (тогда отказ без раскрытия, существует ли урок). */
function modeOf(db: DatabaseSync, a: Actor, l: L | undefined): Mode | null {
  if (!l) return null;
  switch (a.role) {
    case 'owner': return 'owner';
    case 'teacher': return a.id === l.teacher_id || a.id === l.substitute_id ? 'teacher' : null;
    case 'student':
      return db.prepare(`SELECT 1 FROM lesson_enrollments WHERE lesson_id = ? AND student_id = ? AND status = 'active'`).get(l.id, a.id) ? 'participant' : null;
    case 'parent': return childrenInLesson(db, l.id, a.id).length ? 'observer' : null;
    default: return null;
  }
}
/** Дети (<18) этого родителя, активно записанные на урок. Родитель взрослого ученика — не наблюдатель. */
function childrenInLesson(db: DatabaseSync, lessonId: number, parentId: number): number[] {
  const rows = db.prepare(
    `SELECT pc.child_id FROM parent_child pc JOIN lesson_enrollments e ON e.student_id = pc.child_id AND e.status = 'active'
     WHERE pc.parent_id = ? AND e.lesson_id = ?`).all(parentId, lessonId) as { child_id: number }[];
  return rows.map(r => r.child_id).filter(c => isChild(db, c));
}

const endMs = (l: L) => toMs(l.starts_at) + l.duration_min * 60_000;
export const roomOpen = (l: L, now: number) => l.status === 'planned' && now >= toMs(l.starts_at) - ENTER_EARLY_MS && now < endMs(l);

/** Единая проходная: право → принадлежность (иначе Denied, одинаково для «нет урока» и «не твой») → окно времени → журнал. */
function admit(db: DatabaseSync, a: Actor, lessonId: number, perm: string, now: number): { l: L; mode: Mode } {
  const l = loadLesson(db, lessonId);
  const mode = modeOf(db, a, l);
  if (!mode) guard(db, a, perm, 'lesson', lessonId, () => false);   // всегда бросает Denied
  if (!roomOpen(l!, now)) {
    audit(db, a, `${perm}.closed`, 'lesson', lessonId, 'denied');
    throw new RoomRefused('room_closed');
  }
  guard(db, a, perm, 'lesson', lessonId, () => true);
  return { l: l!, mode: mode! };
}

// ---------- присутствие и правило «ребёнок не один» ----------
type Present = { user_id: number; role: string; display_name: string };
function present(db: DatabaseSync, lessonId: number): Present[] {
  return db.prepare(`SELECT p.user_id, u.role, u.display_name FROM room_presence p JOIN users u ON u.id = p.user_id
    WHERE p.lesson_id = ? AND p.left_at IS NULL ORDER BY p.user_id`).all(lessonId) as Present[];
}
const isSupervisor = (p: Present) => p.role === 'teacher' || p.role === 'owner' || p.role === 'parent';   // взрослые, отвечающие за детей
/** Ф18: «второй взрослый» помимо преподавателя — родитель или владелец. */
const isSecondAdult = (p: Present) => p.role === 'owner' || p.role === 'parent';
/** Ф18: урок 1:1 — ровно одна активная запись, и это ребёнок (<18). */
export function isSoleChildLesson(db: DatabaseSync, lessonId: number): boolean {
  const rows = db.prepare(`SELECT student_id FROM lesson_enrollments WHERE lesson_id = ? AND status = 'active'`).all(lessonId) as { student_id: number }[];
  return rows.length === 1 && isChild(db, rows[0].student_id);
}
/** Флаги безопасности. Выбрано так: «второй взрослый» = ещё один надзирающий (преподаватель/владелец/родитель).
 *  child_alone — ребёнок в комнате без единого надзирающего (жёстко не допускается: см. enterRoom/leaveRoom);
 *  child_without_second_adult — ребёнок есть, взрослых меньше двух (обычный урок «1 преподаватель + дети» поднимает этот флаг:
 *  он для наблюдения владельцем, не запрет). */
function flagsOf(db: DatabaseSync, lessonId: number) {
  const ps = present(db, lessonId);
  const childPresent = ps.some(p => p.role === 'student' && isChild(db, p.user_id));
  const adults = ps.filter(isSupervisor).length;
  return { child_present: childPresent, supervising_adults: adults, child_alone: childPresent && adults === 0, child_without_second_adult: childPresent && adults < 2 };
}

/** Вход. Ребёнок не входит в комнату, где нет ни одного надзирающего взрослого. */
export function enterRoom(db: DatabaseSync, a: Actor, lessonId: number, now = Date.now()) {
  return inTx(db, () => {
    const { l, mode } = admit(db, a, lessonId, 'room.enter', now);
    // Ф18: правило двух взрослых. Урок 1:1 «ребёнок + преподаватель»: преподаватель и ребёнок входят, только когда в комнате уже есть родитель или владелец.
    if ((mode === 'teacher' || (mode === 'participant' && isChild(db, a.id))) && isSoleChildLesson(db, lessonId) && !present(db, lessonId).some(isSecondAdult)) {
      audit(db, a, 'room.enter.second_adult_required', 'lesson', lessonId, 'denied');
      throw new RoomRefused('second_adult_required');
    }
    if (mode === 'participant' && isChild(db, a.id) && !present(db, lessonId).some(isSupervisor)) {
      audit(db, a, 'room.enter.no_adult', 'lesson', lessonId, 'denied');
      throw new RoomRefused('wait_for_adult');
    }
    db.prepare(`INSERT INTO room_presence(lesson_id, user_id, entered_at, left_at) VALUES (?,?,?,NULL)
      ON CONFLICT(lesson_id, user_id) DO UPDATE SET left_at = NULL, entered_at = excluded.entered_at`).run(l.id, a.id, new Date(now).toISOString());
    return roomState(db, a, lessonId, now);
  });
}

/** Выход. Единственный надзирающий взрослый не может уйти, пока в комнате ребёнок (оставить ребёнка наедине нельзя). */
export function leaveRoom(db: DatabaseSync, a: Actor, lessonId: number, now = Date.now()) {
  inTx(db, () => {
    const l = loadLesson(db, lessonId);
    const mode = modeOf(db, a, l);
    if (!mode) guard(db, a, 'room.enter', 'lesson', lessonId, () => false);
    const ps = present(db, lessonId);
    const me = ps.find(p => p.user_id === a.id);
    if (me && isSupervisor(me) && ps.some(p => p.role === 'student' && isChild(db, p.user_id)) && ps.filter(isSupervisor).length === 1 && roomOpen(l!, now)) {
      audit(db, a, 'room.leave.would_leave_child_alone', 'lesson', lessonId, 'denied');
      throw new RoomRefused('child_would_be_alone');
    }
    if (me && isSecondAdult(me) && isSoleChildLesson(db, lessonId) && roomOpen(l!, now) && ps.some(p => p.role === 'teacher') && ps.some(p => p.role === 'student')
        && ps.filter(isSecondAdult).length === 1) {
      audit(db, a, 'room.leave.would_leave_one_on_one', 'lesson', lessonId, 'denied');   // Ф18: не оставить ребёнка наедине с преподавателем
      throw new RoomRefused('second_adult_would_leave');
    }
    db.prepare('UPDATE room_presence SET left_at = ? WHERE lesson_id = ? AND user_id = ? AND left_at IS NULL').run(new Date(now).toISOString(), lessonId, a.id);
    audit(db, a, 'room.left', 'lesson', lessonId, 'allowed');
  });
}

// ---------- состояние комнаты (белый список полей, свой срез на роль) ----------
export type RoomMessage = { id: number; from_id: number; from_role: string; from_name?: string; body: string; created_at: string };
export type RoomState = {
  lesson: { id: number; starts_at: string; duration_min: number };
  me: { id: number; mode: Mode };
  recording: boolean;
  participants: { id?: number; display_name?: string; role: string }[];
  flags: ReturnType<typeof flagsOf>;
  messages: RoomMessage[];
};

function visibleParticipants(db: DatabaseSync, a: Actor, mode: Mode, lessonId: number): RoomState['participants'] {
  const ps = present(db, lessonId);
  const kids = a.role === 'parent' ? new Set(childrenInLesson(db, lessonId, a.id)) : new Set<number>();
  const out: RoomState['participants'] = [];
  for (const p of ps) {
    if (mode === 'owner') out.push({ id: p.user_id, display_name: p.display_name, role: p.role });
    else if (mode === 'teacher') out.push(p.role === 'parent' ? { role: 'parent' } : { id: p.user_id, display_name: p.display_name, role: p.role });   // Ф18: родитель — без имени и БЕЗ id
    else if (p.user_id === a.id) out.push({ id: p.user_id, display_name: p.display_name, role: p.role });
    else if (p.role === 'teacher' || p.role === 'owner') out.push({ id: p.user_id, display_name: p.display_name, role: p.role });
    else if (mode === 'observer' && kids.has(p.user_id)) out.push({ id: p.user_id, display_name: p.display_name, role: p.role });
    // ученик не видит ни чужих учеников, ни родителей; родитель — только своего ребёнка
  }
  return out;
}

/** Сообщения: преподаватель/владелец видят все; ученик — свои и реплики преподавателя/владельца; родитель — реплики своего ребёнка и преподавателя/владельца.
 *  Так дети друг друга и чужие реплики не видят. */
function visibleMessages(db: DatabaseSync, a: Actor, mode: Mode, lessonId: number): RoomMessage[] {
  const rows = db.prepare(`SELECT m.id, m.from_id, u.role AS from_role, u.display_name AS from_name, m.body, m.created_at
    FROM room_messages m JOIN users u ON u.id = m.from_id WHERE m.lesson_id = ? ORDER BY m.id`).all(lessonId) as (RoomMessage & { from_name: string })[];
  const kids = a.role === 'parent' ? new Set(childrenInLesson(db, lessonId, a.id)) : new Set<number>();
  return rows.filter(m => {
    if (mode === 'owner' || mode === 'teacher') return true;
    if (m.from_role === 'teacher' || m.from_role === 'owner') return true;
    if (mode === 'participant') return m.from_id === a.id;
    return kids.has(m.from_id);
  }).map(m => ({ id: m.id, from_id: m.from_id, from_role: m.from_role, from_name: m.from_name, body: m.body, created_at: m.created_at }));
}

export function roomState(db: DatabaseSync, a: Actor, lessonId: number, now = Date.now()): RoomState {
  return inTx(db, () => {
    const { l, mode } = admit(db, a, lessonId, 'room.chat.read', now);
    return {
      lesson: { id: l.id, starts_at: l.starts_at, duration_min: l.duration_min },
      me: { id: a.id, mode },
      recording: l.recording === 1,   // «идёт запись» видят все допущенные
      participants: visibleParticipants(db, a, mode, lessonId),
      flags: flagsOf(db, lessonId),
      messages: visibleMessages(db, a, mode, lessonId),
    };
  });
}

/** Чат комнаты. Пишут: ученик (только здесь), преподаватель, владелец. Родитель — наблюдатель, не пишет. Фильтр контактов тот же, что в Ф6. */
export function postRoomMessage(db: DatabaseSync, a: Actor, lessonId: number, body: string, now = Date.now()): number {
  return inTx(db, () => {
    const { mode } = admit(db, a, lessonId, 'room.chat.send', now);
    if (mode === 'observer') { audit(db, a, 'room.chat.observer_write', 'lesson', lessonId, 'denied'); throw new RoomRefused('observer_read_only'); }
    const refuse = (reason: string, msg: string): never => {
      audit(db, a, `room.chat.rejected.${reason}`, 'lesson', lessonId, 'denied');   // без текста
      throw new MessageRejected(reason, msg);
    };
    if (typeof body !== 'string' || !body.trim()) refuse('empty', 'Message is empty.');
    if (body.length > MAX_BODY) refuse('too_long', `Message is longer than ${MAX_BODY} characters.`);
    const leak = findContactLeak(body);
    if (leak) refuse(leak.reason, leak.message);
    const rid = Number(db.prepare('INSERT INTO room_messages(lesson_id, from_id, body) VALUES (?,?,?)').run(lessonId, a.id, body).lastInsertRowid);
    if (a.role === 'teacher') {   // Ф18: родитель каждого ребёнка на уроке уведомляется о реплике преподавателя
      for (const r of db.prepare(`SELECT student_id FROM lesson_enrollments WHERE lesson_id = ? AND status = 'active'`).all(lessonId) as { student_id: number }[]) notifyParents(db, r.student_id, 'room_message', lessonId);
    }
    return rid;
  });
}

// ---------- аварийный выключатель ----------
/** «Позвать владельца»: любой допущенный в окне урока. В журнал — кто, какой урок, когда; текста чата в записи нет. */
export function callOwner(db: DatabaseSync, a: Actor, lessonId: number, now = Date.now()) {
  inTx(db, () => { admit(db, a, lessonId, 'room.call_owner', now); });   // запись allowed 'room.call_owner' в журнале = вызов
}
export type OwnerCall = { id: number; ts: string; lesson_id: number; caller_id: number; caller_role: string; caller_name: string };
/** Вызовы для владельца (только allowed: отказы — не вызовы). */
export function listOwnerCalls(db: DatabaseSync, a: Actor): OwnerCall[] {
  guard(db, a, 'room.calls.read', 'audit_log', null, () => true);
  return db.prepare(`SELECT g.id, g.ts, g.target_id AS lesson_id, g.actor_id AS caller_id, u.role AS caller_role, u.display_name AS caller_name
    FROM audit_log g JOIN users u ON u.id = g.actor_id WHERE g.action = 'room.call_owner' AND g.outcome = 'allowed' ORDER BY g.id DESC LIMIT 200`).all() as OwnerCall[];
}

// ---------- запись урока ----------
/** Включает/выключает ТОЛЬКО владелец. Для каждого записанного ребёнка нужно действующее согласие родителя 'lesson_recording'.
 *  В журнал: кто и когда (audit ts) + поля lessons.recording_set_by/at. */
export function setRecording(db: DatabaseSync, a: Actor, lessonId: number, on: boolean, now = Date.now()) {
  inTx(db, () => {
    const l = loadLesson(db, lessonId);
    guard(db, a, 'room.recording.set', 'lesson', lessonId, () => a.role === 'owner' && !!l);
    if (on) {
      const kids = (db.prepare(`SELECT student_id FROM lesson_enrollments WHERE lesson_id = ? AND status = 'active'`).all(lessonId) as { student_id: number }[])
        .map(r => r.student_id).filter(s => isChild(db, s));
      if (kids.some(k => !hasActiveConsent(db, k, 'lesson_recording'))) {
        audit(db, a, 'room.recording.no_consent', 'lesson', lessonId, 'denied');
        throw new RoomRefused('recording_consent_missing');
      }
    }
    db.prepare('UPDATE lessons SET recording = ?, recording_set_by = ?, recording_set_at = ? WHERE id = ?').run(on ? 1 : 0, a.id, new Date(now).toISOString(), lessonId);
    audit(db, a, on ? 'room.recording.on' : 'room.recording.off', 'lesson', lessonId, 'allowed');
  });
}

// ---------- видео: только заглушка ----------
/** Ни ключей LiveKit, ни токенов: подключение видео — отдельный этап. */
export function videoStub(db: DatabaseSync, a: Actor, lessonId: number, now = Date.now()) {
  admit(db, a, lessonId, 'room.enter', now);
  return { provider: 'stub', status: 'not_connected', note: 'Video is not connected yet.' };
}
