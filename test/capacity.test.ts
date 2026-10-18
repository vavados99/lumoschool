// Ф4: лимит группы, пересечение уроков у ученика, смена лимита владельцем.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.ts';
import { register, login } from '../src/auth.ts';
import { Denied, ScheduleError, readAudit, actorOf, DEFAULT_CAPACITY } from '../src/access.ts';
import { createSlot, enrollMe, cancelMine, changeCapacity } from '../src/schedule.ts';

const NOW = 1_800_000_000_000;
const H = 3_600_000, MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const PW = 'test-password-123';

function setup() {
  const s = seed();
  const { db, ids } = s;
  const tok: Record<string, string> = {};
  for (const k of ['owner', 'teacherA', 'teacherB', 'adultC', 'parentA', 'kidA']) {
    register(db, ids[k], k, PW);
    tok[k] = login(db, k, PW, NOW);
  }
  // взрослые ученики без входа — записываем их от имени владельца
  const crowd: number[] = [];
  for (let i = 0; i < 10; i++) {
    const id = Number(db.prepare(`INSERT INTO users(role, display_name, birth_date) VALUES ('student', ?, '2010-01-01')`).run(`Crowd${i}`).lastInsertRowid);
    db.prepare('INSERT INTO students(user_id, level) VALUES (?,?)').run(id, 'B1');
    crowd.push(id);
  }
  const grown: number[] = [];   // Ф17: взрослая группа — только взрослые ученики
  for (let i = 0; i < 10; i++) {
    const id = Number(db.prepare(`INSERT INTO users(role, display_name, birth_date) VALUES ('student', ?, '1990-01-01')`).run(`Grown${i}`).lastInsertRowid);
    db.prepare('INSERT INTO students(user_id, level) VALUES (?,?)').run(id, 'B1');
    grown.push(id);
  }
  return { db, ids, tok, crowd, grown };
}
const denied = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof Denied);
const refused = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof ScheduleError);
const auditOf = (db: ReturnType<typeof seed>['db'], ids: Record<string, number>) =>
  readAudit(db, actorOf(db, ids.owner)) as { action: string; outcome: string; actor_id: number; target_id: number }[];
const active = (db: ReturnType<typeof seed>['db'], lesson: number) =>
  (db.prepare(`SELECT COUNT(*) c FROM lesson_enrollments WHERE lesson_id=? AND status='active'`).get(lesson) as { c: number }).c;
const maxOf = (db: ReturnType<typeof seed>['db'], lesson: number) =>
  (db.prepare('SELECT max_students m FROM lessons WHERE id=?').get(lesson) as { m: number }).m;

test('лимит по умолчанию: 6 для детей/подростков, 8 для взрослых; константы совпадают со схемой', () => {
  const { db, ids, tok } = setup();
  assert.deepEqual({ ...DEFAULT_CAPACITY }, { minor: 6, adult: 8 });
  const kids = createSlot(db, tok.teacherA, NOW, iso(NOW + 24 * H));                 // по умолчанию — дети
  const kids2 = createSlot(db, tok.teacherA, NOW, iso(NOW + 48 * H), 50, 'minor');
  const adults = createSlot(db, tok.teacherA, NOW, iso(NOW + 72 * H), 50, 'adult');
  assert.equal(maxOf(db, kids), 6); assert.equal(maxOf(db, kids2), 6); assert.equal(maxOf(db, adults), 8);
  assert.equal(maxOf(db, ids.lessonA), 6);                                             // DEFAULT в схеме
  refused(() => createSlot(db, tok.teacherA, NOW, iso(NOW + 96 * H), 50, 'zzz' as never));
});

test('запись сверх лимита отклоняется и пишется в журнал; отмена освобождает место', () => {
  const { db, ids, tok, crowd, grown } = setup();
  const slot = createSlot(db, tok.teacherA, NOW, iso(NOW + 24 * H));                 // лимит 6
  for (let i = 0; i < 6; i++) enrollMe(db, tok.owner, NOW, slot, crowd[i]);
  refused(() => enrollMe(db, tok.owner, NOW, slot, crowd[6]));
  assert.equal(active(db, slot), 6);
  assert.ok(auditOf(db, ids).some(r => r.action === 'enroll.full' && r.outcome === 'denied' && r.target_id === slot));
  cancelMine(db, tok.owner, NOW, slot, crowd[0]);
  enrollMe(db, tok.owner, NOW, slot, crowd[6]);                                        // место освободилось
  assert.equal(active(db, slot), 6);
  refused(() => enrollMe(db, tok.owner, NOW, slot, crowd[7]));
  // взрослая группа: 8, девятый — отказ
  const ad = createSlot(db, tok.teacherB, NOW, iso(NOW + 30 * H), 50, 'adult');
  for (let i = 0; i < 8; i++) enrollMe(db, tok.owner, NOW, ad, grown[i]);
  refused(() => enrollMe(db, tok.owner, NOW, ad, grown[8]));
  assert.equal(active(db, ad), 8);
});

test('лимит ограничивает и родителя, и самого ученика (не только владельца)', () => {
  const { db, ids, tok, crowd } = setup();
  const slot = createSlot(db, tok.teacherB, NOW, iso(NOW + 24 * H), 50, 'minor');
  db.prepare('UPDATE lessons SET max_students = 1 WHERE id = ?').run(slot);
  enrollMe(db, tok.owner, NOW, slot, crowd[0]);
  refused(() => enrollMe(db, tok.adultC, NOW, slot, ids.adultC));
  refused(() => enrollMe(db, tok.parentA, NOW, slot, ids.kidA));
  assert.equal(active(db, slot), 1);
});

test('смена лимита: только владелец; остальные — отказ и запись в журнал', () => {
  const { db, ids, tok, crowd } = setup();
  const slot = createSlot(db, tok.teacherA, NOW, iso(NOW + 24 * H));
  for (let i = 0; i < 6; i++) enrollMe(db, tok.owner, NOW, slot, crowd[i]);
  refused(() => enrollMe(db, tok.owner, NOW, slot, crowd[6]));
  for (const who of ['teacherA', 'teacherB', 'parentA', 'adultC']) {                  // даже преподаватель этого урока
    denied(() => changeCapacity(db, tok[who], NOW, slot, 20));
  }
  assert.equal(maxOf(db, slot), 6);
  const log = auditOf(db, ids);
  for (const who of ['teacherA', 'teacherB', 'parentA', 'adultC']) {
    assert.ok(log.some(r => r.action === 'lessons.set_capacity' && r.outcome === 'denied' && r.actor_id === ids[who]), who);
  }
  // защита в глубину: даже если право по ошибке выдали не-владельцу в таблице — роль владельца проверяется отдельно
  db.prepare(`INSERT INTO role_permissions(role, permission) VALUES ('teacher','lessons.set_capacity')`).run();
  denied(() => changeCapacity(db, tok.teacherA, NOW, slot, 20));
  assert.equal(maxOf(db, slot), 6);
  // владелец — можно; и новое место тут же доступно
  changeCapacity(db, tok.owner, NOW, slot, 7);
  assert.equal(maxOf(db, slot), 7);
  enrollMe(db, tok.owner, NOW, slot, crowd[6]);
  refused(() => enrollMe(db, tok.owner, NOW, slot, crowd[7]));
  assert.ok(auditOf(db, ids).some(r => r.action === 'capacity.changed' && r.outcome === 'allowed' && r.actor_id === ids.owner));
  // некорректное: ниже числа записанных, 0, дробь, нет урока
  refused(() => changeCapacity(db, tok.owner, NOW, slot, 6));
  refused(() => changeCapacity(db, tok.owner, NOW, slot, 0));
  refused(() => changeCapacity(db, tok.owner, NOW, slot, 2.5));
  refused(() => changeCapacity(db, tok.owner, NOW, slot, 51));
  refused(() => changeCapacity(db, tok.owner, NOW, 99999, 5));
  assert.equal(maxOf(db, slot), 7);
  // без сессии — отказ
  denied(() => changeCapacity(db, 'f'.repeat(64), NOW, slot, 9));
});

test('пересечение уроков у ученика: нельзя; впритык — можно; отмена освобождает', () => {
  const { db, ids, tok, crowd } = setup();
  const t0 = NOW + 24 * H;
  const x = createSlot(db, tok.teacherA, NOW, iso(t0), 60);
  const y = createSlot(db, tok.teacherB, NOW, iso(t0 + 30 * MIN), 60);          // накладка с x (другой преподаватель)
  const edge = createSlot(db, tok.teacherA, NOW, iso(t0 + 60 * MIN), 30);       // начинается ровно в конец x
  // впритык — можно (ученик Crowd0: x, затем edge)
  enrollMe(db, tok.owner, NOW, x, crowd[0]);
  enrollMe(db, tok.owner, NOW, edge, crowd[0]);
  // пересечение — отказ, и для самого ученика, и для владельца
  enrollMe(db, tok.owner, NOW, x, crowd[1]);
  refused(() => enrollMe(db, tok.owner, NOW, y, crowd[1]));
  refused(() => enrollMe(db, tok.owner, NOW, y, crowd[1]));
  assert.ok(auditOf(db, ids).some(r => r.action === 'enroll.student_overlap' && r.outcome === 'denied' && r.target_id === y));
  assert.equal(active(db, y), 0);
  // другой ученик на то же время — можно
  enrollMe(db, tok.owner, NOW, y, ids.kidB);
  // отмена x освобождает время
  cancelMine(db, tok.owner, NOW, x, crowd[1]);
  enrollMe(db, tok.owner, NOW, y, crowd[1]);
  assert.equal(active(db, y), 2);
  // урок со статусом «отменён» не блокирует время
  const u = createSlot(db, tok.teacherA, NOW, iso(t0 + 10 * H), 60);
  const v = createSlot(db, tok.teacherB, NOW, iso(t0 + 10 * H), 60);
  enrollMe(db, tok.owner, NOW, u, crowd[1]);
  refused(() => enrollMe(db, tok.owner, NOW, v, crowd[1]));
  db.prepare("UPDATE lessons SET status='cancelled' WHERE id=?").run(u);
  enrollMe(db, tok.owner, NOW, v, crowd[1]);
});
