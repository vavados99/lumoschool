// Ф7: согласия и данные человека — отзыв, экспорт, удаление/обезличивание, срок хранения.
// Принципы: роль берётся из базы; право роли → принадлежность («это твой ребёнок / ты сам 16+») → журнал.
// Журнал (audit_log) хранит ТОЛЬКО факт (кто, что, над кем по id, итог) — ни имён, ни текстов сообщений, ни контактов.
// Преподаватель не имеет ни одного права из этого файла: любой вызов = отказ + запись в журнал.
import type { DatabaseSync } from 'node:sqlite';
import { audit, guard, inTx, isMinor, isParentOf, CONSENT_SCOPES, Denied, type Actor, type ConsentScope } from './access.ts';
import { isChild } from './messages.ts';

// ---------- сроки хранения (значения по умолчанию; всё меняется параметрами) ----------
/** Как долго хранится доказательство согласия и запись об уроках удалённого человека: 6 лет
 *  (общий срок давности по гражданским требованиям; ПРИМЕРНО — до решения юриста по Польше/ЕС). */
export const LEGAL_RETENTION_DAYS = 6 * 365;
/** Сообщения старше этого срока чистятся: 2 года — достаточно, чтобы разобрать жалобу, не копим переписку с детьми. */
export const MESSAGE_RETENTION_DAYS = 730;
/** Попытки входа (IP-адреса — персональные данные): 90 дней, нужны только для защиты от перебора. */
export const LOGIN_ATTEMPT_RETENTION_DAYS = 90;
/** Ф25: чат урока (room_messages) чистится через 90 дней. ПРЕДЛОЖЕНИЕ разработчика, НЕ согласовано с юристом. */
export const CHAT_RETENTION_DAYS = 90;
/** Ф25: журнал действий (audit_log) чистится через 365 дней. ПРЕДЛОЖЕНИЕ разработчика, НЕ согласовано с юристом.
 *  Нижняя граница 30 дней: журнал нужен для расследования инцидентов, стереть его «в ноль» параметром нельзя. */
export const AUDIT_RETENTION_DAYS = 365;
export const MIN_AUDIT_RETENTION_DAYS = 30;
/** Ф25: значение actor_id/target_id в журнале у обезличенного человека (настоящих id с 0 не бывает). */
export const ERASED_ID = 0;
/** Типы объектов журнала, у которых target_id — id человека (у 'lesson', 'thread', 'settings' и т.д. это не человек). */
const PERSON_TARGET_TYPES = ['student', 'person_data', 'user', 'consent', 'contact_vault'] as const;

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const sqlTime = (ms: number) => iso(ms).slice(0, 19).replace('T', ' ');   // формат datetime('now') в created_at

function hasPerm(db: DatabaseSync, role: string, perm: string): boolean {
  return !!db.prepare('SELECT 1 FROM role_permissions WHERE role = ? AND permission = ?').get(role, perm);
}

/** Чьи данные и в каком качестве актёр их просит. */
type Authority = 'self' | 'parent' | 'owner' | null;
function authority(db: DatabaseSync, a: Actor, subjectId: number, now: number): Authority {
  if (a.role === 'owner') return 'owner';
  const exists = db.prepare(`SELECT role FROM users WHERE id = ? AND anonymized_at IS NULL`).get(subjectId) as { role: string } | undefined;
  if (!exists) return null;
  if (a.id === subjectId) {
    if (a.role === 'parent') return 'self';
    if (a.role === 'student' && !isMinor(db, subjectId, new Date(now))) return 'self';   // ученик 16+
    return null;                                                                          // ребёнок до 16 — только через родителя
  }
  if (a.role === 'parent' && exists.role === 'student' && isParentOf(db, a.id, subjectId) && isChild(db, subjectId, new Date(now))) return 'parent';
  return null;
}

// ---------- отзыв согласия ----------
/** Отзыв согласия родителем (любым связанным с ребёнком). Снимает ВСЕ активные согласия этого типа у ребёнка.
 *  Для 'data_processing': все БУДУЩИЕ активные записи ребёнка отменяются (окно отмены не применяется), новые записи блокируются
 *  проверкой в enroll(). Каждое действие — в журнал. Прошедшие уроки не трогаем. */
export function revokeConsent(db: DatabaseSync, a: Actor, childId: number, scope: ConsentScope = 'data_processing', now = Date.now()): { cancelled: number } {
  return inTx(db, () => {
    guard(db, a, 'consent.revoke', 'student', childId, () => a.role === 'parent' && isParentOf(db, a.id, childId));
    if (!CONSENT_SCOPES.includes(scope)) { audit(db, a, 'consent.bad_input', 'student', childId, 'denied'); throw new Denied('bad consent scope'); }
    const r = db.prepare(`UPDATE parental_consents SET revoked_at = ?, revoked_by = ?, retain_until = ?
      WHERE child_id = ? AND scope = ? AND revoked_at IS NULL`).run(iso(now), a.id, iso(now + LEGAL_RETENTION_DAYS * DAY), childId, scope);
    if (Number(r.changes) === 0) { audit(db, a, 'consent.revoke.nothing_active', 'student', childId, 'denied'); return { cancelled: 0 }; }
    audit(db, a, `consent.revoked.${scope}`, 'student', childId, 'allowed');
    let cancelled = 0;
    if (scope === 'data_processing') cancelled = cancelFutureEnrollments(db, a, childId, now);
    return { cancelled };
  });
}

function cancelFutureEnrollments(db: DatabaseSync, a: Actor, studentId: number, now: number): number {
  const rows = db.prepare(`SELECT e.lesson_id, l.starts_at FROM lesson_enrollments e JOIN lessons l ON l.id = e.lesson_id
    WHERE e.student_id = ? AND e.status = 'active'`).all(studentId) as { lesson_id: number; starts_at: string }[];
  let n = 0;
  for (const r of rows) {
    const t = Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(r.starts_at) ? r.starts_at : r.starts_at + 'Z');
    if (t <= now) continue;
    db.prepare(`UPDATE lesson_enrollments SET status='cancelled', cancelled_at=? WHERE lesson_id=? AND student_id=?`).run(iso(now), r.lesson_id, studentId);
    audit(db, a, 'consent.enrollment_cancelled', 'lesson', r.lesson_id, 'allowed');
    n++;
  }
  return n;
}

export type ConsentView = { scope: string; text_version: string; granted_at: string; revoked_at: string | null; given_by: 'parent'; active: boolean };
/** Список согласий человека: родитель — своего ребёнка; ученик 16+ — свои; владелец — любые (по праву consent.read_any). Контактов нет. */
export function listConsents(db: DatabaseSync, a: Actor, subjectId: number, now = Date.now()): ConsentView[] {
  const auth = authority(db, a, subjectId, now);
  const perm = a.role === 'owner' ? 'consent.read_any' : a.role === 'parent' ? 'consent.read_child' : 'consent.read_own';
  guard(db, a, perm, 'consent', subjectId, () => auth !== null);
  return (db.prepare('SELECT scope, text_version, granted_at, revoked_at FROM parental_consents WHERE child_id = ? ORDER BY id').all(subjectId) as Omit<ConsentView, 'given_by' | 'active'>[])
    .map(r => ({ ...r, given_by: 'parent' as const, active: r.revoked_at === null }));
}

// ---------- экспорт ----------
export type DataExport = {
  subject_id: number;
  exported_at: string;
  profile: { display_name: string; birth_date: string | null; level: string | null };
  contacts: { email: string | null; phone: string | null } | null;   // только при самовыгрузке; контакты ребёнка родителю не отдаются (как в getContacts)
  lessons: { lesson_id: number; starts_at: string; status: string; enrollment: string; teacher_name: string }[];   // без других учеников и контактов
  consents: ConsentView[];
  messages: { thread_id: number; posts: { from: 'me' | 'teacher' | 'student' | 'parent'; body: string; created_at: string }[] }[] | null;
  actions: { ts: string; action: string; outcome: string }[];        // действия самого человека в журнале (без чужих)
};

/** Экспорт ВСЕХ данных человека по его просьбе. Родитель — данные ребёнка (до 18); ученик 16+ и родитель — свои.
 *  Владелец — только если ему выдано право data.export_any (по умолчанию его нет); тела сообщений — ещё и message.read_any.
 *  В экспорт не попадают: контакты и имена других людей, другие ученики урока, чужие записи журнала. Экспорт пишется в журнал. */
export function exportData(db: DatabaseSync, a: Actor, subjectId: number, now = Date.now()): DataExport {
  return inTx(db, () => {
    const auth = authority(db, a, subjectId, now);
    guard(db, a, a.role === 'owner' ? 'data.export_any' : 'data.export', 'person_data', subjectId, () => auth !== null);
    const u = db.prepare(`SELECT u.role, u.display_name, u.birth_date, s.level FROM users u LEFT JOIN students s ON s.user_id = u.id WHERE u.id = ?`)
      .get(subjectId) as { role: string; display_name: string; birth_date: string | null; level: string | null } | undefined;
    if (!u) { audit(db, a, 'data.export.no_subject', 'person_data', subjectId, 'denied'); throw new Denied('not found'); }

    const contacts = auth === 'self'
      ? (db.prepare('SELECT email, phone FROM contact_vault WHERE user_id = ?').get(subjectId) as { email: string | null; phone: string | null } | undefined) ?? { email: null, phone: null }
      : null;

    const lessons = db.prepare(`SELECT l.id AS lesson_id, l.starts_at, l.status, e.status AS enrollment, t.display_name AS teacher_name
      FROM lesson_enrollments e JOIN lessons l ON l.id = e.lesson_id JOIN users t ON t.id = l.teacher_id
      WHERE e.student_id = ? ORDER BY l.starts_at, l.id`).all(subjectId) as DataExport['lessons'];

    const consents = u.role === 'student'
      ? (db.prepare('SELECT scope, text_version, granted_at, revoked_at FROM parental_consents WHERE child_id = ? ORDER BY id').all(subjectId) as Omit<ConsentView, 'given_by' | 'active'>[])
          .map(r => ({ ...r, given_by: 'parent' as const, active: r.revoked_at === null }))
      : [];

    // сообщения: ветки, где человек — ученик (ребёнок: плюс его родитель-участник), или родитель такого ребёнка пишет в ветке.
    // Вместо имён и id собеседников — только роль.
    const mayReadBodies = auth !== 'owner' || hasPerm(db, 'owner', 'message.read_any');
    let messages: DataExport['messages'] = null;
    if (mayReadBodies) {
      const threads = u.role === 'student'
        ? (db.prepare('SELECT id FROM msg_threads WHERE student_id = ? ORDER BY id').all(subjectId) as { id: number }[])
        : (db.prepare('SELECT DISTINCT thread_id AS id FROM msg_posts WHERE from_id = ? ORDER BY thread_id').all(subjectId) as { id: number }[]);
      messages = threads.map(t => ({
        thread_id: t.id,
        posts: (db.prepare(`SELECT p.from_id, u.role, p.body, p.created_at FROM msg_posts p JOIN users u ON u.id = p.from_id WHERE p.thread_id = ? ORDER BY p.id`)
          .all(t.id) as { from_id: number; role: string; body: string; created_at: string }[])
          .filter(p => u.role === 'student' || p.from_id === subjectId)       // у родителя — только его собственные реплики
          .map(p => ({ from: (p.from_id === subjectId ? 'me' : p.role) as 'me' | 'teacher' | 'student' | 'parent', body: p.body, created_at: p.created_at })),
      }));
    }

    const actions = db.prepare('SELECT ts, action, outcome FROM audit_log WHERE actor_id = ? ORDER BY id').all(subjectId) as DataExport['actions'];
    audit(db, a, 'data.exported', 'person_data', subjectId, 'allowed');
    return { subject_id: subjectId, exported_at: iso(now), profile: { display_name: u.display_name, birth_date: u.birth_date, level: u.level }, contacts, lessons, consents, messages, actions };
  });
}

// ---------- удаление / обезличивание ----------
/** Удаление по просьбе (родитель — ребёнка до 18; ученик 16+ и родитель — себя; владелец — по праву data.erase_any, когда просьба пришла ему).
 *  Стирается: сообщения (тела), контакты, вход и сессии, попытки входа, связи родитель–ребёнок, имя, дата рождения, уровень. Будущие записи отменяются.
 *  Сохраняется (учёт/доказательство, retain_until = сейчас + legalDays): строки согласий (отзываются) и записи об уроках — уже без имени человека.
 *  После срока их удалит runRetention. В журнал — только факт и id. Необратимо. */
export function eraseData(db: DatabaseSync, a: Actor, subjectId: number, now = Date.now(), legalDays = LEGAL_RETENTION_DAYS): void {
  inTx(db, () => {
    const auth = authority(db, a, subjectId, now);
    guard(db, a, a.role === 'owner' ? 'data.erase_any' : 'data.erase', 'person_data', subjectId, () => auth !== null);
    const u = db.prepare('SELECT role FROM users WHERE id = ? AND anonymized_at IS NULL').get(subjectId) as { role: string } | undefined;
    if (!u || u.role === 'owner' || u.role === 'teacher') {   // владельца и преподавателей эта функция не стирает (отдельный процесс, не Ф7)
      audit(db, a, 'data.erase.refused', 'person_data', subjectId, 'denied');
      throw new Denied('this person cannot be erased here');
    }
    applyErasure(db, a, subjectId, u.role, now, legalDays);
    // Ф26: «надгробие» — только id и время, без персональных данных. Нужно, чтобы восстановление из старой копии
    // (где человек ещё не стёрт) повторно обезличило его (restore.ts → reapplyErasures).
    db.prepare('INSERT OR REPLACE INTO erased_subjects(user_id, erased_at) VALUES (?, ?)').run(subjectId, iso(now));
    audit(db, a, 'data.erased', 'person_data', subjectId, 'allowed');
  });
}

/** Ф26: сам механизм стирания без проверки прав (права — в eraseData). Актор null — стирание при восстановлении копии. */
function applyErasure(db: DatabaseSync, a: Actor | null, subjectId: number, role: string, now: number, legalDays: number): void {
  const u = { role };
  {
    const keepUntil = iso(now + legalDays * DAY);
    cancelFutureEnrollments(db, a, subjectId, now);
    // сообщения: у ученика — все тела в его ветках (включая реплики преподавателя и родителей — ветка умирает), у родителя — его реплики
    if (u.role === 'student') {
      db.prepare('DELETE FROM msg_posts WHERE thread_id IN (SELECT id FROM msg_threads WHERE student_id = ?)').run(subjectId);
      db.prepare('DELETE FROM msg_threads WHERE student_id = ?').run(subjectId);
    }
    db.prepare('DELETE FROM msg_posts WHERE from_id = ?').run(subjectId);
    db.prepare('DELETE FROM parent_notifications WHERE parent_id = ? OR child_id = ?').run(subjectId, subjectId);   // Ф18: уведомления родителю
    db.prepare('DELETE FROM messages WHERE from_id = ? OR to_id = ?').run(subjectId, subjectId);
    db.prepare('DELETE FROM room_messages WHERE from_id = ?').run(subjectId);   // Ф25: реплики человека в чате уроков (раньше оставались)
    // входы
    const login = db.prepare('SELECT login FROM credentials WHERE user_id = ?').get(subjectId) as { login: string } | undefined;
    if (login) db.prepare('DELETE FROM login_attempts WHERE login = ?').run(login.login);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(subjectId);
    db.prepare('DELETE FROM credentials WHERE user_id = ?').run(subjectId);
    db.prepare('DELETE FROM contact_vault WHERE user_id = ?').run(subjectId);
    // согласия: отзываем и храним как доказательство (срок), где человек — ребёнок или давший родитель
    db.prepare(`UPDATE parental_consents SET revoked_at = COALESCE(revoked_at, ?), revoked_by = COALESCE(revoked_by, ?), retain_until = COALESCE(retain_until, ?)
      WHERE child_id = ? OR parent_id = ?`).run(iso(now), a?.id ?? null, keepUntil, subjectId, subjectId);
    if (u.role === 'parent') {   // у детей этого родителя пропало согласие — их будущие записи снимаются тоже
      for (const c of db.prepare('SELECT child_id FROM parent_child WHERE parent_id = ?').all(subjectId) as { child_id: number }[])
        if (!hasActiveConsentAny(db, c.child_id)) cancelFutureEnrollments(db, a, c.child_id, now);
    }
    db.prepare('DELETE FROM parent_child WHERE parent_id = ? OR child_id = ?').run(subjectId, subjectId);
    // записи об уроках: остаются (учёт), срок хранения — в поле
    db.prepare('UPDATE lesson_enrollments SET retain_until = ? WHERE student_id = ?').run(keepUntil, subjectId);
    db.prepare('UPDATE students SET level = NULL WHERE user_id = ?').run(subjectId);
    db.prepare(`UPDATE users SET display_name = 'Deleted user', birth_date = NULL, anonymized_at = ? WHERE id = ?`).run(iso(now), subjectId);
    // Ф25: ссылки на человека в журнале → 0. Сами строки остаются: журнал нужен для безопасности (кто что делал, сколько отказов),
    // но связать их с обезличенным человеком уже нельзя. Единственное исключение — итоговая строка 'data.erased' ниже:
    // она пишется ПОСЛЕ и хранит id удалённого как доказательство, что удаление выполнено (id без данных не идентифицирует).
    db.prepare('UPDATE audit_log SET actor_id = ? WHERE actor_id = ?').run(ERASED_ID, subjectId);
    db.prepare(`UPDATE audit_log SET target_id = ? WHERE target_id = ? AND target_type IN (${PERSON_TARGET_TYPES.map(() => '?').join(',')})`)
      .run(ERASED_ID, subjectId, ...PERSON_TARGET_TYPES);
  }
}

/** Ф26: повторное стирание при восстановлении из копии. Вызывается restore.ts на уже подготовленном файле (до подмены рабочей базы).
 *  Для каждого «надгробия» (erased_subjects): если в копии такой человек есть и не обезличен — стираем тем же механизмом, что и eraseData.
 *  Человек, созданный ПОСЛЕ времени стирания (повторное использование id), не трогается. Возвращает id повторно стёртых. */
export function reapplyErasures(db: DatabaseSync, now = Date.now(), legalDays = LEGAL_RETENTION_DAYS): number[] {
  return inTx(db, () => {
    const done: number[] = [];
    const rows = db.prepare(`SELECT e.user_id AS id, u.role AS role FROM erased_subjects e JOIN users u ON u.id = e.user_id
      WHERE u.anonymized_at IS NULL AND u.created_at <= datetime(e.erased_at) ORDER BY e.user_id`).all() as { id: number; role: string }[];
    for (const r of rows) {
      if (r.role !== 'student' && r.role !== 'parent') { audit(db, null, 'data.reerase.refused', 'person_data', r.id, 'denied'); continue; }
      applyErasure(db, null, r.id, r.role, now, legalDays);
      audit(db, null, 'data.reerased_after_restore', 'person_data', r.id, 'allowed');
      done.push(r.id);
    }
    return done;
  });
}

function hasActiveConsentAny(db: DatabaseSync, childId: number): boolean {
  return !!db.prepare(`SELECT 1 FROM parental_consents WHERE child_id = ? AND scope = 'data_processing' AND revoked_at IS NULL`).get(childId);
}

// ---------- срок хранения ----------
export type RetentionOptions = { now?: number; messageDays?: number; loginAttemptDays?: number; chatDays?: number; auditDays?: number };
export type RetentionResult = { messages: number; threads: number; login_attempts: number; consents: number; enrollments: number; users: number; room_messages: number; audit_log: number };

/** Чистка просроченного. Только владелец (право retention.run). Параметры — в днях; по умолчанию см. константы выше:
 *  сообщения старше 730 дн.; чат урока старше 90 дн.; журнал старше 365 дн. (не меньше 30); попытки входа старше 90 дн.; строки согласий/записей с истёкшим retain_until (удалённые люди и отозванные согласия);
 *  обезличенные пользователи, на которых больше ничего не ссылается. Пустые ветки старше срока — тоже. Журнал: только строки старше срока.
 *  Итог (числа) — в ответ; в журнале — факт запуска. Запускать по расписанию должен внешний планировщик (в ядре расписания нет). */
export function runRetention(db: DatabaseSync, a: Actor, opts: RetentionOptions = {}): RetentionResult {
  const now = opts.now ?? Date.now();
  const messageDays = opts.messageDays ?? MESSAGE_RETENTION_DAYS;
  const loginDays = opts.loginAttemptDays ?? LOGIN_ATTEMPT_RETENTION_DAYS;
  const chatDays = opts.chatDays ?? CHAT_RETENTION_DAYS;
  const auditDays = opts.auditDays ?? AUDIT_RETENTION_DAYS;
  if (![messageDays, loginDays, chatDays].every(d => Number.isFinite(d) && d >= 0)) throw new Denied('bad retention parameters');
  if (!Number.isFinite(auditDays) || auditDays < MIN_AUDIT_RETENTION_DAYS) throw new Denied('bad retention parameters');   // журнал «в ноль» не стирается
  return inTx(db, () => {
    guard(db, a, 'retention.run', 'retention', null, () => a.role === 'owner');
    const ch = (sql: string, ...p: (string | number)[]) => Number(db.prepare(sql).run(...p).changes);
    const msgCut = sqlTime(now - messageDays * DAY);
    const res: RetentionResult = { messages: 0, threads: 0, login_attempts: 0, consents: 0, enrollments: 0, users: 0, room_messages: 0, audit_log: 0 };
    res.messages = ch('DELETE FROM msg_posts WHERE created_at < ?', msgCut);
    res.threads = ch(`DELETE FROM msg_threads WHERE created_at < ? AND id NOT IN (SELECT thread_id FROM msg_posts)`, msgCut);
    ch('DELETE FROM parent_notifications WHERE created_at < ?', msgCut);   // Ф18: уведомления живут столько же, сколько сообщения
    res.room_messages = ch('DELETE FROM room_messages WHERE created_at < ?', sqlTime(now - chatDays * DAY));   // Ф25: чат урока
    res.login_attempts = ch('DELETE FROM login_attempts WHERE ts < ?', now - loginDays * DAY);
    res.consents = ch('DELETE FROM parental_consents WHERE retain_until IS NOT NULL AND retain_until < ? AND revoked_at IS NOT NULL', iso(now));
    res.enrollments = ch('DELETE FROM lesson_enrollments WHERE retain_until IS NOT NULL AND retain_until < ?', iso(now));
    // Ф25: журнал старше срока. «Ворота» открыты только на время этого DELETE и закрываются сразу (и откатываются вместе с транзакцией).
    db.exec('UPDATE audit_purge_gate SET open = 1 WHERE id = 1');
    try { res.audit_log = ch('DELETE FROM audit_log WHERE ts < ?', sqlTime(now - auditDays * DAY)); }
    finally { db.exec('UPDATE audit_purge_gate SET open = 0 WHERE id = 1'); }
    for (const u of db.prepare('SELECT id FROM users WHERE anonymized_at IS NOT NULL').all() as { id: number }[]) {
      // Ф25: присутствие в комнате обезличенного — учёт посещаемости; уходит, когда у человека не осталось записей об уроках
      ch('DELETE FROM room_presence WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM lesson_enrollments e WHERE e.student_id = ?)', u.id, u.id);
      try { res.users += ch('DELETE FROM users WHERE id = ?', u.id); } catch { /* ещё есть ссылки (FK) — оставляем до следующего прогона */ }
    }
    audit(db, a, 'retention.run', 'retention', null, 'allowed');
    return res;
  });
}
