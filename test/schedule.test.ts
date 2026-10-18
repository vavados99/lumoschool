import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.ts';
import { register, login } from '../src/auth.ts';
import * as acc from '../src/access.ts';
import { Denied, ScheduleError, readAudit, actorOf } from '../src/access.ts';
import { createSlot, enrollMe, cancelMine, myLessons } from '../src/schedule.ts';

const NOW = 1_800_000_000_000;          // 2027-01-15; все слоты в тестах — относительно него
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const PW = 'test-password-123';

/** seed + вход для каждого + два подростка (15 и 16 лет на момент NOW). */
function setup() {
  const s = seed();
  const { db, ids } = s;
  const mk = (name: string, birth: string) => {
    const id = Number(db.prepare(`INSERT INTO users(role, display_name, birth_date) VALUES ('student', ?, ?)`).run(name, birth).lastInsertRowid);
    db.prepare('INSERT INTO contact_vault(user_id, email, phone) VALUES (?,?,?)').run(id, `${name}@example.invalid`, '+000-x');
    db.prepare('INSERT INTO students(user_id, level) VALUES (?,?)').run(id, 'B1');
    return id;
  };
  ids.teen15 = mk('Teen15', '2011-03-01');
  ids.teen16 = mk('Teen16', '2010-06-01');
  db.prepare('INSERT INTO parent_child(parent_id, child_id) VALUES (?,?)').run(ids.parentA, ids.teen15);
  const tok: Record<string, string> = {};
  for (const k of ['owner', 'teacherA', 'teacherB', 'kidA', 'kidB', 'adultC', 'parentA', 'parentB', 'teen15', 'teen16']) {
    register(db, ids[k], k, PW);
    tok[k] = login(db, k, PW, NOW);
  }
  return { db, ids, tok };
}
const denied = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof Denied);
const refused = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof ScheduleError);
const idsOf = (l: { id: number }[]) => l.map(x => x.id).sort((a, b) => a - b);

test('(а) преподаватель: только свои уроки, только ученики своих уроков, без контактов', () => {
  const { db, ids, tok } = setup();
  const mine = createSlot(db, tok.teacherA, NOW, iso(NOW + 24 * H));
  const a = myLessons(db, tok.teacherA, NOW);
  assert.deepEqual(idsOf(a), [ids.lessonA, mine].sort((x, y) => x - y));
  assert.ok(!a.some(l => l.id === ids.lessonB));
  assert.deepEqual(a.flatMap(l => l.students.map(s => s.id)), [ids.kidA]);
  const text = JSON.stringify(a);
  assert.ok(!text.includes('example.invalid') && !/email|phone/i.test(text));
  for (const l of a) for (const s of l.students) assert.deepEqual(Object.keys(s).sort(), ['display_name', 'id', 'level']);
  // учитель B видит свои, включая взрослого
  const b = myLessons(db, tok.teacherB, NOW);
  assert.deepEqual(idsOf(b), [ids.lessonB]);
  assert.deepEqual(b[0].students.map(s => s.id).sort(), [ids.kidB, ids.adultC].sort());
  // контактов нет ни при каких условиях: ни свой ученик, ни чужой, ни родитель
  for (const t of [ids.kidA, ids.kidB, ids.parentA, ids.adultC]) denied(() => acc.getContacts(db, actorOf(db, ids.teacherA), t));
  // преподаватель не записывает и не отменяет запись
  denied(() => enrollMe(db, tok.teacherA, NOW, mine, ids.adultC));
  denied(() => cancelMine(db, tok.teacherA, NOW, ids.lessonA, ids.kidA));
  // после отмены записи ученик пропадает из его видимости
  cancelMine(db, tok.parentA, NOW, ids.lessonA, ids.kidA);
  assert.deepEqual(myLessons(db, tok.teacherA, NOW).flatMap(l => l.students), []);
});

test('(б) ученик не видит чужие записи и других учеников', () => {
  const { db, ids, tok } = setup();
  // adultC и kidB — на одном уроке B; adultC видит урок, но только себя
  const c = myLessons(db, tok.adultC, NOW);
  assert.deepEqual(idsOf(c), [ids.lessonB]);
  assert.deepEqual(c[0].students.map(s => s.id), [ids.adultC]);
  assert.ok(!JSON.stringify(c).includes('KidB'));
  assert.deepEqual(myLessons(db, tok.teen16, NOW), []);       // нет записей — пусто, не «всё»
  // чужого записывать/отменять нельзя
  denied(() => enrollMe(db, tok.adultC, NOW, ids.lessonA, ids.kidA));
  denied(() => cancelMine(db, tok.adultC, NOW, ids.lessonB, ids.kidB));
  assert.equal(myLessons(db, tok.parentB, NOW)[0].students[0].id, ids.kidB); // запись kidB цела
  // слот создавать ученик не может
  denied(() => createSlot(db, tok.adultC, NOW, iso(NOW + 5 * H)));
  denied(() => createSlot(db, tok.parentA, NOW, iso(NOW + 5 * H)));
});

test('(в) родитель: записывает/отменяет/видит только своего ребёнка', () => {
  const { db, ids, tok } = setup();
  const slot = createSlot(db, tok.teacherB, NOW, iso(NOW + 48 * H));
  denied(() => enrollMe(db, tok.parentA, NOW, slot, ids.kidB));     // чужой ребёнок
  denied(() => enrollMe(db, tok.parentA, NOW, slot, ids.adultC));   // взрослый ученик — не его
  denied(() => enrollMe(db, tok.parentB, NOW, slot, ids.kidA));
  enrollMe(db, tok.parentA, NOW, slot, ids.kidA);                   // свой
  assert.deepEqual(idsOf(myLessons(db, tok.parentA, NOW)), [ids.lessonA, slot].sort((x, y) => x - y));
  const pa = myLessons(db, tok.parentA, NOW);
  assert.ok(pa.every(l => l.students.every(s => s.id === ids.kidA)));
  assert.deepEqual(idsOf(myLessons(db, tok.parentB, NOW)), [ids.lessonB]);
  assert.ok(myLessons(db, tok.parentB, NOW)[0].students.every(s => s.id === ids.kidB)); // adultC не виден
  denied(() => cancelMine(db, tok.parentB, NOW, slot, ids.kidA));   // чужую запись не отменить
  assert.equal(myLessons(db, tok.parentA, NOW).length, 2);
  cancelMine(db, tok.parentA, NOW, slot, ids.kidA);                 // свою — можно
  assert.equal(myLessons(db, tok.parentA, NOW).length, 1);
  // кто записал — зафиксировано
  const by = db.prepare('SELECT booked_by FROM lesson_enrollments WHERE lesson_id=? AND student_id=?').get(slot, ids.kidA) as { booked_by: number };
  assert.equal(by.booked_by, ids.parentA);
});

test('(г) владелец видит всё и может записать/отменить', () => {
  const { db, ids, tok } = setup();
  const all = myLessons(db, tok.owner, NOW);
  assert.deepEqual(idsOf(all), [ids.lessonA, ids.lessonB].sort((x, y) => x - y));
  assert.deepEqual(all.flatMap(l => l.students.map(s => s.id)).sort(), [ids.kidA, ids.kidB, ids.adultC].sort());
  assert.ok(!JSON.stringify(all).includes('example.invalid'));
  enrollMe(db, tok.owner, NOW, ids.lessonA, ids.teen16);
  assert.equal(myLessons(db, tok.owner, NOW).find(l => l.id === ids.lessonA)!.students.length, 2);
  cancelMine(db, tok.owner, NOW, ids.lessonA, ids.teen16);
  // журнал читает только владелец и в нём есть действия расписания
  const log = readAudit(db, actorOf(db, ids.owner)) as { action: string; actor_id: number; outcome: string }[];
  assert.ok(log.some(r => r.action === 'enroll.done' && r.actor_id === ids.owner));
  assert.ok(log.some(r => r.action === 'cancel.done'));
});

test('(д) без сессии / просроченная / поддельная / выход — отказ, пишется в журнал', () => {
  const { db, ids, tok } = setup();
  const before = (db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='session.required'").get() as { c: number }).c;
  const late = NOW + 13 * H; // TTL сессии 12 ч
  denied(() => myLessons(db, tok.owner, late));
  denied(() => createSlot(db, tok.teacherA, late, iso(late + H)));
  denied(() => enrollMe(db, tok.parentA, late, ids.lessonB, ids.kidA));
  denied(() => cancelMine(db, tok.parentA, late, ids.lessonA, ids.kidA));
  denied(() => myLessons(db, '', NOW));
  denied(() => myLessons(db, 'f'.repeat(64), NOW));
  denied(() => myLessons(db, String(ids.owner), NOW));        // id вместо токена — не принимается
  denied(() => myLessons(db, undefined as unknown as string, NOW));
  const after = (db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='session.required'").get() as { c: number }).c;
  assert.equal(after - before, 8);
  // ничего не создалось
  assert.equal((db.prepare('SELECT COUNT(*) c FROM lessons').get() as { c: number }).c, 2);
});

test('(е1) двойная запись — отказ; после отмены можно снова', () => {
  const { db, ids, tok } = setup();
  const slot = createSlot(db, tok.teacherA, NOW, iso(NOW + 24 * H), 50, 'adult');
  enrollMe(db, tok.adultC, NOW, slot, ids.adultC);
  refused(() => enrollMe(db, tok.adultC, NOW, slot, ids.adultC));
  refused(() => enrollMe(db, tok.owner, NOW, slot, ids.adultC));
  assert.equal((db.prepare('SELECT COUNT(*) c FROM lesson_enrollments WHERE lesson_id=?').get(slot) as { c: number }).c, 1);
  cancelMine(db, tok.adultC, NOW, slot, ids.adultC);
  refused(() => cancelMine(db, tok.adultC, NOW, slot, ids.adultC));  // повторная отмена
  enrollMe(db, tok.adultC, NOW, slot, ids.adultC);
  assert.equal(myLessons(db, tok.adultC, NOW).filter(l => l.id === slot).length, 1);
});

test('(е2) пересечение слотов у одного преподавателя — отказ; у другого и впритык — можно', () => {
  const { db, tok } = setup();
  const t0 = NOW + 24 * H;
  createSlot(db, tok.teacherA, NOW, iso(t0), 60);
  refused(() => createSlot(db, tok.teacherA, NOW, iso(t0), 60));                 // то же время
  refused(() => createSlot(db, tok.teacherA, NOW, iso(t0 + 30 * 60_000), 60));  // накладка в конце
  refused(() => createSlot(db, tok.teacherA, NOW, iso(t0 - 30 * 60_000), 60));  // накладка в начале
  refused(() => createSlot(db, tok.teacherA, NOW, iso(t0 + 10 * 60_000), 15));  // внутри
  createSlot(db, tok.teacherA, NOW, iso(t0 + 60 * 60_000), 60);                  // впритык — ок
  createSlot(db, tok.teacherB, NOW, iso(t0), 60);                                // другой преподаватель — ок
  refused(() => createSlot(db, tok.teacherA, NOW, 'не-дата'));
  refused(() => createSlot(db, tok.teacherA, NOW, iso(t0 + 10 * H), 5));         // длительность
  refused(() => createSlot(db, tok.teacherA, NOW, iso(t0 + 10 * H), 500));
});

test('(е3) прошлое: слот и запись в прошедшее время — отказ', () => {
  const { db, ids, tok } = setup();
  refused(() => createSlot(db, tok.teacherA, NOW, iso(NOW - H)));
  refused(() => createSlot(db, tok.teacherA, NOW, iso(NOW)));
  // урок, который уже начался (время ушло вперёд)
  const later = NOW + 24 * H;
  const t1 = login(db, 'adultC', PW, later);
  const slot = createSlot(db, login(db, 'teacherA', PW, NOW), NOW, iso(NOW + 2 * H), 50, 'adult');
  refused(() => enrollMe(db, t1, later, slot, ids.adultC));
  // отменять прошедший урок тоже нельзя
  const slot2 = createSlot(db, tok.teacherB, NOW, iso(NOW + 3 * H), 50, 'adult');
  enrollMe(db, tok.adultC, NOW, slot2, ids.adultC);
  const t2 = login(db, 'adultC', PW, NOW + 4 * H);
  refused(() => cancelMine(db, t2, NOW + 4 * H, slot2, ids.adultC));
  // отменённый (статус) урок — не записаться
  db.prepare("UPDATE lessons SET status='cancelled' WHERE id=?").run(slot2);
  refused(() => enrollMe(db, tok.owner, NOW, slot2, ids.teen16));
});

test('(е4) согласие и возраст 16: ребёнок без согласия — отказ; ученик 16+ — себя; до 16 — только через родителя', () => {
  const { db, ids, tok } = setup();
  const slot = createSlot(db, tok.teacherA, NOW, iso(NOW + 24 * H));
  // teen15: согласия нет → родитель записать не может
  denied(() => enrollMe(db, tok.parentA, NOW, slot, ids.teen15));
  acc.grantConsent(db, actorOf(db, ids.parentA), ids.teen15);
  enrollMe(db, tok.parentA, NOW, slot, ids.teen15);
  // отзыв согласия → новая запись (на другой слот) невозможна
  db.prepare("UPDATE parental_consents SET revoked_at = datetime('now') WHERE child_id = ?").run(ids.teen15);
  const slot2 = createSlot(db, tok.teacherA, NOW, iso(NOW + 30 * H));
  denied(() => enrollMe(db, tok.parentA, NOW, slot2, ids.teen15));
  // ребёнок до 16 сам себя записать не может — даже с согласием
  denied(() => enrollMe(db, tok.kidA, NOW, slot2, ids.kidA));
  denied(() => enrollMe(db, tok.teen15, NOW, slot2, ids.teen15));
  // 16+ записывает себя; чужого — нет
  enrollMe(db, tok.teen16, NOW, slot2, ids.teen16);
  denied(() => enrollMe(db, tok.teen16, NOW, slot2, ids.adultC));
  // та же дата, но позже 1 марта 2027 teen15 стал 16 — своя запись уже разрешена (без согласия — всё равно нет: 16+ согласие не требуется)
  const later = Date.parse('2027-03-02T10:00:00Z');
  const lt = login(db, 'teen15', PW, later);
  const farSlot = createSlot(db, login(db, 'teacherB', PW, later), later, iso(later + 24 * H));
  enrollMe(db, lt, later, farSlot, ids.teen15);
  // отказы по согласию попали в журнал
  const log = readAudit(db, actorOf(db, ids.owner)) as { action: string; outcome: string }[];
  assert.ok(log.some(r => r.action === 'enroll.no_consent' && r.outcome === 'denied'));
});

test('журнал: каждое действие расписания (успех и отказ) пишется', () => {
  const { db, ids, tok } = setup();
  const slot = createSlot(db, tok.teacherA, NOW, iso(NOW + 24 * H), 50, 'adult');
  try { createSlot(db, tok.teacherA, NOW, iso(NOW + 24 * H)); } catch { /* ожидаемо */ }
  enrollMe(db, tok.adultC, NOW, slot, ids.adultC);
  try { enrollMe(db, tok.adultC, NOW, slot, ids.adultC); } catch { /* ожидаемо */ }
  try { enrollMe(db, tok.parentA, NOW, slot, ids.kidB); } catch { /* ожидаемо */ }
  cancelMine(db, tok.adultC, NOW, slot, ids.adultC);
  const log = readAudit(db, actorOf(db, ids.owner)) as { action: string; outcome: string }[];
  const has = (action: string, outcome: string) => log.some(r => r.action === action && r.outcome === outcome);
  assert.ok(has('slot.created', 'allowed'));
  assert.ok(has('slot.overlap', 'denied'));
  assert.ok(has('enroll.done', 'allowed'));
  assert.ok(has('enroll.duplicate', 'denied'));
  assert.ok(has('child_lessons.enroll', 'denied'));
  assert.ok(has('cancel.done', 'allowed'));
});
