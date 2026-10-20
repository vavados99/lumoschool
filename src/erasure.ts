// Ф28: канал приёма просьб об удалении данных. Заглушка: реальной почты нет — уведомление родителю уходит в очередь outbox (стоки).
// Правила:
//  * ученик младше 16 сам просить не может (NotAvailable: просит родитель);
//  * ученик 16–17 → заявка ждёт подтверждения РОДИТЕЛЯ (pending_parent), затем владельца; ученик 18+ → сразу владельцу;
//  * родитель за ребёнка до 18 → владельцу; преподаватель и владелец подать не могут;
//  * владелец исполняет только с identity_checked = 1 (личность проверена вручную вне системы); исполняет существующий eraseData;
//  * в таблице — только id, статус, время; note — код из закрытого списка.
import type { DatabaseSync } from 'node:sqlite';
import { audit, guard, inTx, isMinor, isParentOfChild, isUnderAdultAge, NotAvailable, ScheduleError, type Actor } from './access.ts';
import { eraseData } from './consent.ts';

export type ErasureStatus = 'pending_parent' | 'pending_owner' | 'done' | 'rejected';
export type ErasureRequest = {
  id: number; subject_id: number; requested_by: number; via: 'self' | 'parent' | 'owner'; status: ErasureStatus;
  created_at: string; decided_at: string | null; decided_by: number | null; identity_checked: number; note: string | null;
};
export const NOTE_CODES = ['identity_failed', 'duplicate', 'not_entitled', 'other'] as const;
export type NoteCode = (typeof NOTE_CODES)[number];

/** Отказ с кодом (сервер переводит в HTTP-статус и error.<код>). Наследует ScheduleError: транзакция коммитится, запись в журнале остаётся. */
export class ErasureError extends ScheduleError {
  code: 'request_exists' | 'parent_confirmation_required' | 'identity_not_checked' | 'request_not_pending';
  constructor(code: ErasureError['code']) { super(code); this.name = 'ErasureError'; this.code = code; }
}

const COLS = 'id, subject_id, requested_by, via, status, created_at, decided_at, decided_by, identity_checked, note';
const live = (db: DatabaseSync, id: number) => !!db.prepare('SELECT 1 FROM users WHERE id = ? AND anonymized_at IS NULL').get(id);
const parentIds = (db: DatabaseSync, childId: number) =>
  (db.prepare('SELECT parent_id FROM parent_child WHERE child_id = ?').all(childId) as { parent_id: number }[]).map(r => r.parent_id);
const refuse = (db: DatabaseSync, a: Actor, id: number | null): never => { audit(db, a, 'erasure.request.refused', 'erasure_request', id, 'denied'); throw new NotAvailable(); };

/** Подать просьбу. Ученик — о себе (subjectId игнорируется); родитель — о своём ребёнке до 18. */
export function submitRequest(db: DatabaseSync, a: Actor, subjectId: number | null, now = Date.now()): ErasureRequest {
  return inTx(db, () => {
    guard(db, a, 'erasure.request', 'erasure_request', null, () => a.role === 'student' || a.role === 'parent');
    let subject: number, via: 'self' | 'parent', status: ErasureStatus;
    if (a.role === 'student') {
      subject = a.id; via = 'self';
      if (isMinor(db, a.id, new Date(now))) return refuse(db, a, null);                  // младше 16 (или возраст неизвестен) — только через родителя
      if (isUnderAdultAge(db, a.id, new Date(now))) {                                   // 16–17: родитель обязан подтвердить
        if (parentIds(db, a.id).length === 0) return refuse(db, a, null);               // подтверждать некому — на платформе не принимаем
        status = 'pending_parent';
      } else status = 'pending_owner';                                                  // 18+ → владельцу
    } else {
      if (subjectId === null || !isParentOfChild(db, a.id, subjectId, now)) return refuse(db, a, null);   // чужой/взрослый/несуществующий — один отказ
      subject = subjectId; via = 'parent'; status = 'pending_owner';
    }
    if (!live(db, subject)) return refuse(db, a, null);
    if (db.prepare(`SELECT 1 FROM erasure_requests WHERE subject_id = ? AND status IN ('pending_parent','pending_owner')`).get(subject)) {
      audit(db, a, 'erasure.request.duplicate', 'erasure_request', null, 'denied');
      throw new ErasureError('request_exists');
    }
    const id = Number(db.prepare('INSERT INTO erasure_requests(subject_id, requested_by, via, status) VALUES (?,?,?,?)').run(subject, a.id, via, status).lastInsertRowid);
    audit(db, a, 'erasure.requested', 'erasure_request', id, 'allowed');
    if (status === 'pending_parent') notifyParents(db, subject, id);
    return get(db, id)!;
  });
}

/** Родителю — уведомление через очередь outbox (текста и данных ребёнка нет; реальной отправки нет — только сток). */
function notifyParents(db: DatabaseSync, childId: number, requestId: number): void {
  const ins = db.prepare(`INSERT INTO parent_notifications(parent_id, child_id, kind, ref_id) VALUES (?,?,'erasure_request',?)`);
  const out = db.prepare('INSERT INTO notification_outbox(notification_id) VALUES (?)');
  for (const p of parentIds(db, childId)) out.run(Number(ins.run(p, childId, requestId).lastInsertRowid));
}

const get = (db: DatabaseSync, id: number) => db.prepare(`SELECT ${COLS} FROM erasure_requests WHERE id = ?`).get(id) as ErasureRequest | undefined;

/** Мои заявки: ученик — о себе; родитель — поданные им и заявки своего ребёнка до 18. Чужих нет. */
export function listMine(db: DatabaseSync, a: Actor, now = Date.now()): ErasureRequest[] {
  guard(db, a, 'erasure.read_own', 'erasure_request', null, () => a.role === 'student' || a.role === 'parent');
  const rows = db.prepare(`SELECT ${COLS} FROM erasure_requests ORDER BY id DESC`).all() as ErasureRequest[];
  return rows.filter(r => a.role === 'student'
    ? r.subject_id === a.id
    : r.requested_by === a.id || isParentOfChild(db, a.id, r.subject_id, now));
}

/** Родитель подтверждает заявку своего ребёнка (pending_parent → pending_owner). Чужая/несуществующая — NotAvailable. */
export function parentConfirm(db: DatabaseSync, a: Actor, requestId: number, now = Date.now()): ErasureRequest {
  return inTx(db, () => {
    guard(db, a, 'erasure.confirm', 'erasure_request', requestId, () => a.role === 'parent');
    const r = get(db, requestId);
    if (!r || !isParentOfChild(db, a.id, r.subject_id, now)) return refuse(db, a, requestId);
    if (r.status !== 'pending_parent') throw new ErasureError('request_not_pending');
    db.prepare(`UPDATE erasure_requests SET status = 'pending_owner' WHERE id = ?`).run(requestId);
    audit(db, a, 'erasure.parent_confirmed', 'erasure_request', requestId, 'allowed');
    return get(db, requestId)!;
  });
}

/** Владелец: все заявки (опционально по статусу). */
export function listAll(db: DatabaseSync, a: Actor, status?: ErasureStatus): ErasureRequest[] {
  guard(db, a, 'erasure.read_all', 'erasure_request', null, () => a.role === 'owner');
  return (status
    ? db.prepare(`SELECT ${COLS} FROM erasure_requests WHERE status = ? ORDER BY id DESC`).all(status)
    : db.prepare(`SELECT ${COLS} FROM erasure_requests ORDER BY id DESC`).all()) as ErasureRequest[];
}

/** Владелец решает. approve: нужен identity_checked = true и (для 16–17) подтверждение родителя; исполняет eraseData и пишет заявку «done».
 *  reject: закрывает с кодом note. Всё в одной транзакции — если стирание не удалось, заявка остаётся открытой. */
export function decide(db: DatabaseSync, a: Actor, requestId: number, decision: 'approve' | 'reject', identityChecked: boolean, note: NoteCode | null,
  now = Date.now(), eraser: typeof eraseData = eraseData): ErasureRequest {
  return inTx(db, () => {
    guard(db, a, 'erasure.decide', 'erasure_request', requestId, () => a.role === 'owner');
    const r = get(db, requestId);
    if (!r) return refuse(db, a, requestId);
    if (r.status === 'done' || r.status === 'rejected') throw new ErasureError('request_not_pending');
    if (decision === 'reject') {
      db.prepare(`UPDATE erasure_requests SET status = 'rejected', decided_at = datetime('now'), decided_by = ?, identity_checked = ?, note = ? WHERE id = ?`)
        .run(a.id, identityChecked ? 1 : 0, note, requestId);
      audit(db, a, 'erasure.rejected', 'erasure_request', requestId, 'allowed');
      return get(db, requestId)!;
    }
    if (r.status === 'pending_parent') { audit(db, a, 'erasure.execute.refused', 'erasure_request', requestId, 'denied'); throw new ErasureError('parent_confirmation_required'); }
    if (!identityChecked) { audit(db, a, 'erasure.execute.refused', 'erasure_request', requestId, 'denied'); throw new ErasureError('identity_not_checked'); }
    eraser(db, a, r.subject_id, now);
    db.prepare(`UPDATE erasure_requests SET status = 'done', decided_at = datetime('now'), decided_by = ?, identity_checked = 1, note = ? WHERE id = ?`)
      .run(a.id, note, requestId);
    audit(db, a, 'erasure.executed', 'erasure_request', requestId, 'allowed');
    return get(db, requestId)!;
  });
}
