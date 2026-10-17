// Ф5: окно отмены записи, замена преподавателя (доступ к одному уроку, без контактов), изоляция ролей.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.ts';
import { register, login } from '../src/auth.ts';
import {
  Denied, ScheduleError, actorOf, readAudit, getContacts, getProfile, listStudents, sendMessage,
  setCancelWindowHours, getCancelWindowHours, assignSubstitute, removeSubstitute, activeSubstituteLessons,
} from '../src/access.ts';
import { cancelMine, enrollMe, myLessons } from '../src/schedule.ts';

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const PW = 'test-password-123';
const denied = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof Denied);
const refused = (fn: () => unknown, re?: RegExp) => assert.throws(fn, (e: unknown) => e instanceof ScheduleError && (!re || re.test(e.message)));

function setup() {
  const s = seed();
  const { db, ids } = s;
  // заменяющий: преподаватель C без собственных уроков
  ids.teacherC = Number(db.prepare(`INSERT INTO users(role, display_name) VALUES ('teacher','TeacherC')`).run().lastInsertRowid);
  db.prepare('INSERT INTO teachers(user_id, bio) VALUES (?, ?)').run(ids.teacherC, 'bio');
  db.prepare('INSERT INTO contact_vault(user_id, email, phone) VALUES (?,?,?)').run(ids.teacherC, 'tc@example.invalid', '+000-tc');
  const tok: Record<string, string> = {};
  for (const k of ['owner', 'teacherA', 'teacherB', 'teacherC', 'kidA', 'kidB', 'adultC', 'parentA', 'parentB']) {
    register(db, ids[k], k, PW);
    tok[k] = login(db, k, PW, NOW, 100 * 24 * H);
  }
  return { db, ids, tok };
}
const setStart = (db: ReturnType<typeof seed>['db'], id: number, ms: number) =>
  db.prepare('UPDATE lessons SET starts_at = ? WHERE id = ?').run(iso(ms), id);
const enrolled = (db: ReturnType<typeof seed>['db'], lesson: number, st: number) =>
  (db.prepare('SELECT status s FROM lesson_enrollments WHERE lesson_id=? AND student_id=?').get(lesson, st) as { s: string }).s;
const auditOf = (db: ReturnType<typeof seed>['db'], ids: Record<string, number>) =>
  readAudit(db, actorOf(db, ids.owner)) as { actor_id: number; action: string; outcome: string; target_id: number | null }[];

// ---------- окно отмены ----------
test('окно отмены: по умолчанию 24 ч; родитель и ученик не отменяют позже; ровно за 24 ч — можно', () => {
  const { db, ids, tok } = setup();
  assert.equal(getCancelWindowHours(db), 24);
  setStart(db, ids.lessonA, NOW + 24 * H - 1);                       // на 1 мс позже границы
  refused(() => cancelMine(db, tok.parentA, NOW, ids.lessonA, ids.kidA), /window/);
  assert.equal(enrolled(db, ids.lessonA, ids.kidA), 'active');
  setStart(db, ids.lessonB, NOW + 2 * H);
  refused(() => cancelMine(db, tok.adultC, NOW, ids.lessonB, ids.adultC), /window/);   // взрослый ученик за себя
  assert.equal(enrolled(db, ids.lessonB, ids.adultC), 'active');
  // отказы — в журнале
  assert.ok(auditOf(db, ids).filter(r => r.action === 'cancel.too_late' && r.outcome === 'denied').length >= 2);
  // ровно 24 ч — граница разрешена
  setStart(db, ids.lessonA, NOW + 24 * H);
  cancelMine(db, tok.parentA, NOW, ids.lessonA, ids.kidA);
  assert.equal(enrolled(db, ids.lessonA, ids.kidA), 'cancelled');
});

test('окно отмены: владелец отменяет всегда, вплотную к началу, и это в журнале', () => {
  const { db, ids, tok } = setup();
  setStart(db, ids.lessonA, NOW + 60_000);
  cancelMine(db, tok.owner, NOW, ids.lessonA, ids.kidA);
  assert.equal(enrolled(db, ids.lessonA, ids.kidA), 'cancelled');
  const log = auditOf(db, ids);
  assert.ok(log.some(r => r.action === 'cancel.window_override' && r.actor_id === ids.owner));
  assert.ok(log.some(r => r.action === 'cancel.done' && r.actor_id === ids.owner));
  // уже начавшийся урок отменить нельзя и владельцу (поведение Ф3 не сломано)
  setStart(db, ids.lessonB, NOW - 1000);
  refused(() => cancelMine(db, tok.owner, NOW, ids.lessonB, ids.kidB));
});

test('окно отмены: N настраивает только владелец; новое N действует; мусор отклоняется; всё в журнале', () => {
  const { db, ids, tok } = setup();
  for (const who of ['teacherA', 'parentA', 'adultC']) denied(() => setCancelWindowHours(db, actorOf(db, ids[who]), 0));
  assert.equal(getCancelWindowHours(db), 24);                       // чужие не изменили
  for (const bad of [-1, 721, 1.5, NaN]) refused(() => setCancelWindowHours(db, actorOf(db, ids.owner), bad));
  setCancelWindowHours(db, actorOf(db, ids.owner), 2);
  assert.equal(getCancelWindowHours(db), 2);
  setStart(db, ids.lessonA, NOW + 3 * H);
  cancelMine(db, tok.parentA, NOW, ids.lessonA, ids.kidA);          // 3 ч > 2 ч — можно
  setStart(db, ids.lessonB, NOW + 1 * H);
  refused(() => cancelMine(db, tok.parentB, NOW, ids.lessonB, ids.kidB), /window/);   // 1 ч < 2 ч
  setCancelWindowHours(db, actorOf(db, ids.owner), 0);              // 0 = отмена до самого начала
  cancelMine(db, tok.parentB, NOW, ids.lessonB, ids.kidB);
  const log = auditOf(db, ids);
  assert.equal(log.filter(r => r.action === 'settings.cancel_window.changed').length, 2);
  assert.ok(log.some(r => r.action === 'settings.cancel_window' && r.outcome === 'denied' && r.actor_id === ids.teacherA));
});

test('окно отмены: чужого ребёнка и после старта по-прежнему нельзя; сломанная настройка → 24', () => {
  const { db, ids, tok } = setup();
  setStart(db, ids.lessonA, NOW + 100 * H);
  denied(() => cancelMine(db, tok.parentB, NOW, ids.lessonA, ids.kidA));
  denied(() => cancelMine(db, tok.teacherA, NOW, ids.lessonA, ids.kidA));
  db.prepare(`UPDATE settings SET value='abc' WHERE key='cancel_window_hours'`).run();
  assert.equal(getCancelWindowHours(db), 24);
});

// ---------- замена преподавателя ----------
test('замена: заменяющий видит ТОЛЬКО этот урок и его учеников, без контактов', () => {
  const { db, ids, tok } = setup();
  setStart(db, ids.lessonA, NOW + 2 * H);
  setStart(db, ids.lessonB, NOW + 3 * H);
  // у учителя A есть ещё один урок с другим учеником — заменяющий его видеть не должен
  const other = Number(db.prepare(`INSERT INTO lessons(teacher_id, starts_at) VALUES (?, ?)`).run(ids.teacherA, iso(NOW + 30 * H)).lastInsertRowid);
  db.prepare('INSERT INTO lesson_enrollments(lesson_id, student_id) VALUES (?,?)').run(other, ids.adultC);
  // до назначения — ничего
  const c = actorOf(db, ids.teacherC);
  assert.deepEqual(myLessons(db, tok.teacherC, NOW), []);
  assert.deepEqual(listStudents(db, c, NOW), []);
  denied(() => getProfile(db, c, ids.kidA, NOW));

  assignSubstitute(db, actorOf(db, ids.owner), ids.lessonA, ids.teacherC, NOW);

  const mine = myLessons(db, tok.teacherC, NOW);
  assert.deepEqual(mine.map(l => l.id), [ids.lessonA]);                       // только один урок
  assert.deepEqual(mine[0].students.map(s => s.id), [ids.kidA]);
  assert.deepEqual(listStudents(db, c, NOW).map(p => p.id), [ids.kidA]);       // список учеников — только этот урок
  assert.equal(getProfile(db, c, ids.kidA, NOW).display_name, 'KidA');
  for (const t of [ids.kidB, ids.adultC]) denied(() => getProfile(db, c, t, NOW));   // ученики других уроков, в т.ч. другого урока учителя A
  // ни контактов, ни ключей контактов
  for (const t of [ids.kidA, ids.parentA, ids.kidB, ids.teacherA, ids.owner]) denied(() => getContacts(db, c, t));
  const text = JSON.stringify([mine, listStudents(db, c, NOW), getProfile(db, c, ids.kidA, NOW)]);
  assert.ok(!text.includes('example.invalid') && !/email|phone/i.test(text));
  assert.deepEqual(Object.keys(getProfile(db, c, ids.kidA, NOW)).sort(), ['display_name', 'id', 'level']);
  // писать родителю/ученику заменяющий не может; записывать и отменять — тоже
  denied(() => sendMessage(db, c, ids.parentA, 'hi'));
  denied(() => sendMessage(db, c, ids.kidA, 'hi'));
  denied(() => enrollMe(db, tok.teacherC, NOW, ids.lessonA, ids.adultC));
  denied(() => cancelMine(db, tok.teacherC, NOW, ids.lessonA, ids.kidA));
  // назначение — в журнале
  assert.ok(auditOf(db, ids).some(r => r.action === 'substitute.assigned' && r.target_id === ids.lessonA && r.actor_id === ids.owner));
});

test('замена: доступ снимается после конца урока, при снятии замены, при отмене/проведении урока', () => {
  const { db, ids, tok } = setup();
  const c = actorOf(db, ids.teacherC);
  const owner = actorOf(db, ids.owner);
  const start = NOW + 2 * H, end = start + 50 * 60_000;
  setStart(db, ids.lessonA, start);
  assignSubstitute(db, owner, ids.lessonA, ids.teacherC, NOW);
  assert.deepEqual(listStudents(db, c, end - 1).map(p => p.id), [ids.kidA]);    // идёт урок — доступ есть
  assert.deepEqual(listStudents(db, c, end), []);                              // урок закончился — доступа нет
  denied(() => getProfile(db, c, ids.kidA, end + 1));
  assert.deepEqual(activeSubstituteLessons(db, ids.teacherC, end + 1), []);
  // снятие замены: сразу
  assert.deepEqual(listStudents(db, c, NOW).map(p => p.id), [ids.kidA]);
  removeSubstitute(db, owner, ids.lessonA);
  assert.deepEqual(listStudents(db, c, NOW), []);
  assert.deepEqual(myLessons(db, tok.teacherC, NOW), []);
  denied(() => getProfile(db, c, ids.kidA, NOW));
  assert.ok(auditOf(db, ids).some(r => r.action === 'substitute.removed' && r.outcome === 'allowed'));
  // урок отменён / проведён
  for (const st of ['cancelled', 'done']) {
    assignSubstitute(db, owner, ids.lessonA, ids.teacherC, NOW);
    db.prepare('UPDATE lessons SET status=? WHERE id=?').run(st, ids.lessonA);
    assert.deepEqual(myLessons(db, tok.teacherC, NOW), []);
    denied(() => getProfile(db, c, ids.kidA, NOW));
    db.prepare(`UPDATE lessons SET status='planned', substitute_id=NULL WHERE id=?`).run(ids.lessonA);
  }
});

test('замена: назначает только владелец; заменяющий — преподаватель, не учитель урока; урок не в прошлом', () => {
  const { db, ids } = setup();
  setStart(db, ids.lessonA, NOW + 2 * H);
  for (const who of ['teacherA', 'teacherB', 'teacherC', 'parentA', 'kidA']) {
    denied(() => assignSubstitute(db, actorOf(db, ids[who]), ids.lessonA, ids.teacherC, NOW));
    denied(() => removeSubstitute(db, actorOf(db, ids[who]), ids.lessonA));
  }
  assert.equal((db.prepare('SELECT substitute_id s FROM lessons WHERE id=?').get(ids.lessonA) as { s: number | null }).s, null);
  const owner = actorOf(db, ids.owner);
  for (const bad of [ids.parentA, ids.kidB, ids.owner, 99999]) refused(() => assignSubstitute(db, owner, ids.lessonA, bad, NOW));
  refused(() => assignSubstitute(db, owner, ids.lessonA, ids.teacherA, NOW), /lesson teacher/);
  refused(() => assignSubstitute(db, owner, 99999, ids.teacherC, NOW));
  refused(() => assignSubstitute(db, owner, ids.lessonA, ids.teacherC, NOW + 3 * H));        // урок уже закончился
  assert.ok(auditOf(db, ids).some(r => r.action === 'lessons.set_substitute' && r.outcome === 'denied' && r.actor_id === ids.teacherA));
});

// ---------- изоляция: замена ничего не ломает ----------
test('изоляция при активной замене: преподаватели, ученики и родители видят прежнее', () => {
  const { db, ids, tok } = setup();
  setStart(db, ids.lessonA, NOW + 2 * H);
  setStart(db, ids.lessonB, NOW + 3 * H);
  assignSubstitute(db, actorOf(db, ids.owner), ids.lessonA, ids.teacherB, NOW);   // teacherB подменяет teacherA
  const a = actorOf(db, ids.teacherA), b = actorOf(db, ids.teacherB);
  // учитель A: по-прежнему только свой урок/ученик, контактов нет
  assert.deepEqual(listStudents(db, a, NOW).map(p => p.id), [ids.kidA]);
  for (const t of [ids.kidA, ids.kidB, ids.parentA]) denied(() => getContacts(db, a, t));
  denied(() => getProfile(db, a, ids.kidB, NOW));
  // заменяющий B: свой урок + урок A, ничего сверх; контактов нет
  assert.deepEqual(myLessons(db, tok.teacherB, NOW).map(l => l.id).sort(), [ids.lessonA, ids.lessonB].sort());
  assert.deepEqual(listStudents(db, b, NOW).map(p => p.id).sort(), [ids.kidA, ids.kidB, ids.adultC].sort());
  for (const t of [ids.kidA, ids.kidB, ids.adultC, ids.parentA, ids.parentB]) denied(() => getContacts(db, b, t));
  // третий преподаватель C ничего не видит
  assert.deepEqual(myLessons(db, tok.teacherC, NOW), []);
  assert.deepEqual(listStudents(db, actorOf(db, ids.teacherC), NOW), []);
  // ученик: только себя; чужих не видит
  assert.deepEqual(listStudents(db, actorOf(db, ids.adultC), NOW).map(p => p.id), [ids.adultC]);
  denied(() => getProfile(db, actorOf(db, ids.adultC), ids.kidA, NOW));
  denied(() => getContacts(db, actorOf(db, ids.adultC), ids.kidA));
  assert.deepEqual(myLessons(db, tok.kidA, NOW).map(l => l.id), [ids.lessonA]);
  assert.deepEqual(myLessons(db, tok.kidA, NOW)[0].students.map(s => s.id), [ids.kidA]);
  // родитель: только свой ребёнок
  const pa = actorOf(db, ids.parentA);
  assert.deepEqual(listStudents(db, pa, NOW).map(p => p.id), [ids.kidA]);
  denied(() => getProfile(db, pa, ids.kidB, NOW));
  denied(() => getContacts(db, pa, ids.kidA));
  assert.deepEqual(myLessons(db, tok.parentA, NOW).flatMap(l => l.students.map(s => s.id)), [ids.kidA]);
  assert.ok(!JSON.stringify(myLessons(db, tok.parentA, NOW)).includes('KidB'));
});
