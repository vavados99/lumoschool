import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seed } from './seed.ts';
import {
  actorOf, getProfile, listStudents, getContacts, enroll, sendMessage, readAudit, grantConsent, Denied,
} from '../src/access.ts';

const denied = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof Denied);

test('(а) преподаватель: контакты — никогда; ученики — только своего урока', () => {
  const { db, ids } = seed();
  const t = actorOf(db, ids.teacherA);
  // контакты своего ученика, чужого, родителя, свои-через-сейф — запрещены ровно для чужих; свои разрешены не в сейфе учителя
  denied(() => getContacts(db, t, ids.kidA));
  denied(() => getContacts(db, t, ids.kidB));
  denied(() => getContacts(db, t, ids.parentA));
  // список: только KidA
  assert.deepEqual(listStudents(db, t).map(p => p.id), [ids.kidA]);
  // профиль чужого ученика — запрещён
  denied(() => getProfile(db, t, ids.kidB));
  denied(() => getProfile(db, t, ids.adultC));
  // профиль своего — разрешён и без контактных полей
  const p = getProfile(db, t, ids.kidA);
  assert.deepEqual(Object.keys(p).sort(), ['display_name', 'id', 'level']);
  assert.ok(!JSON.stringify(listStudents(db, t)).includes('example.invalid'));
});

test('(а2) запросы преподавательской части не обращаются к contact_vault', () => {
  const src = readFileSync(new URL('../src/access.ts', import.meta.url), 'utf8');
  const lines = src.split('\n').filter(l => l.includes('contact_vault'));
  // единственное разрешённое место чтения сейфа — getContacts
  assert.equal(lines.filter(l => l.includes('SELECT')).length, 1);
});

test('(б) ученик не видит чужих учеников и чужие контакты', () => {
  const { db, ids } = seed();
  const s = actorOf(db, ids.adultC);
  assert.deepEqual(listStudents(db, s).map(p => p.id), [ids.adultC]);
  denied(() => getProfile(db, s, ids.kidB));   // даже одноклассник
  denied(() => getProfile(db, s, ids.kidA));
  denied(() => getContacts(db, s, ids.kidB));
  denied(() => getContacts(db, s, ids.teacherB));
  assert.equal(getContacts(db, s, ids.adultC).email, 'c@example.invalid'); // свои — можно
  denied(() => readAudit(db, s));
});

test('(в) родитель видит только своего ребёнка', () => {
  const { db, ids } = seed();
  const p = actorOf(db, ids.parentA);
  assert.deepEqual(listStudents(db, p).map(x => x.id), [ids.kidA]);
  assert.equal(getProfile(db, p, ids.kidA).display_name, 'KidA');
  denied(() => getProfile(db, p, ids.kidB));
  denied(() => getProfile(db, p, ids.adultC));
  denied(() => getContacts(db, p, ids.kidA));      // контакты ребёнка родителю не отдаются через чужой путь
  denied(() => getContacts(db, p, ids.parentB));
  denied(() => grantConsent(db, p, ids.kidB));     // согласие за чужого ребёнка
});

test('негатив: преподаватель не пишет ребёнку напрямую; через родителя — можно', () => {
  const { db, ids } = seed();
  const t = actorOf(db, ids.teacherA);
  denied(() => sendMessage(db, t, ids.kidA, 'hi'));        // ребёнок своего урока
  denied(() => sendMessage(db, t, ids.parentB, 'hi'));     // чужой родитель
  denied(() => sendMessage(db, t, ids.owner, 'hi'));
  sendMessage(db, t, ids.parentA, 'отчёт об уроке');       // родитель своего ученика
  const tb = actorOf(db, ids.teacherB);
  sendMessage(db, tb, ids.adultC, 'hello');                // взрослому ученику — можно
  denied(() => sendMessage(db, tb, ids.kidB, 'hi'));
  denied(() => sendMessage(db, actorOf(db, ids.kidA), ids.parentA, 'x')); // ученик писать не умеет (нет права)
});

test('согласие: ребёнок до 16 без согласия не записывается; роль берётся из базы', () => {
  const { db, ids } = seed();
  db.prepare('UPDATE parental_consents SET revoked_at = datetime(\'now\') WHERE child_id = ?').run(ids.kidA);
  denied(() => enroll(db, actorOf(db, ids.owner), ids.lessonB, ids.kidA));
  denied(() => enroll(db, actorOf(db, ids.parentB), ids.lessonB, ids.kidA)); // не его ребёнок
  grantConsent(db, actorOf(db, ids.parentA), ids.kidA);
  const other = Number(db.prepare("INSERT INTO lessons(teacher_id, starts_at) VALUES (?, '2099-01-02T10:00:00.000Z')").run(ids.teacherB).lastInsertRowid); // другое время: lessonB пересёкся бы с lessonA ребёнка
  enroll(db, actorOf(db, ids.parentA), other, ids.kidA);
  denied(() => enroll(db, actorOf(db, ids.teacherA), ids.lessonA, ids.kidA)); // у учителя права нет
});

test('журнал: отказы и разрешения пишутся, читает только владелец, не стирается', () => {
  const { db, ids } = seed();
  const t = actorOf(db, ids.teacherA);
  denied(() => getContacts(db, t, ids.kidA));
  denied(() => readAudit(db, t));
  const log = readAudit(db, actorOf(db, ids.owner)) as { actor_id: number; outcome: string; action: string }[];
  assert.ok(log.some(r => r.actor_id === ids.teacherA && r.outcome === 'denied' && r.action === 'contacts.read_any'));
  assert.throws(() => db.prepare('DELETE FROM audit_log').run());
  assert.throws(() => db.prepare("UPDATE audit_log SET outcome='allowed'").run());
});

test('запрещено по умолчанию: неизвестное право не даётся', () => {
  const { db, ids } = seed();
  db.prepare('DELETE FROM role_permissions').run();
  denied(() => listStudents(db, actorOf(db, ids.owner)));
  denied(() => getContacts(db, actorOf(db, ids.owner), ids.owner));
});
