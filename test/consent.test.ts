// Ф7: согласия, отзыв, экспорт, удаление, срок хранения. Данные выдуманные.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.ts';
import { actorOf, readAudit, enroll, grantConsent, hasActiveConsent, listStudents, getProfile, Denied } from '../src/access.ts';
import { revokeConsent, listConsents, exportData, eraseData, runRetention, LEGAL_RETENTION_DAYS } from '../src/consent.ts';
import { openThread, postMessage } from '../src/messages.ts';

type S = ReturnType<typeof seed>;
type DB = S['db'];
const DAY = 86_400_000;
const denied = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof Denied);
const log = (db: DB, ownerId: number) => readAudit(db, actorOf(db, ownerId)) as { actor_id: number | null; action: string; target_id: number | null; outcome: string }[];
const count = (db: DB, sql: string, ...p: (string | number)[]) => (db.prepare(sql).get(...p) as { c: number }).c;

/** Урок учителя A в будущем уже записан у KidA (seed). Добавляем ветку с тремя репликами, вход и сессию. */
function world() {
  const s = seed();
  const { db, ids } = s;
  const th = openThread(db, actorOf(db, ids.teacherA), ids.teacherA, ids.kidA);
  postMessage(db, actorOf(db, ids.teacherA), th, 'Teacher secret phrase alpha');
  postMessage(db, actorOf(db, ids.kidA), th, 'Kid secret phrase beta');
  postMessage(db, actorOf(db, ids.parentA), th, 'Parent secret phrase gamma');
  db.prepare(`INSERT INTO credentials(user_id, login, password_hash) VALUES (?,?,?)`).run(ids.kidA, 'kida-login', 'hash');
  db.prepare(`INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)`).run('h1', ids.kidA, 1, 9e15);
  db.prepare(`INSERT INTO login_attempts(login, ts, ok) VALUES (?,?,1)`).run('kida-login', Date.now());
  return { ...s, th };
}

test('согласие хранит: кто дал, за кого, тип, версию текста, дату; повтор не плодит строк; всё в журнал', () => {
  const { db, ids } = seed();
  db.exec('DELETE FROM parental_consents');
  const p = actorOf(db, ids.parentA);
  grantConsent(db, p, ids.kidA, 'data_processing', '2026-10-v1', Date.parse('2026-10-17T10:00:00Z'));
  grantConsent(db, p, ids.kidA, 'data_processing', '2026-10-v1');   // повтор
  grantConsent(db, p, ids.kidA, 'lesson_recording', '2026-10-v1');
  const rows = db.prepare('SELECT parent_id, child_id, scope, text_version, granted_at, revoked_at FROM parental_consents ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.deepEqual({ ...rows[0] }, { parent_id: ids.parentA, child_id: ids.kidA, scope: 'data_processing', text_version: '2026-10-v1', granted_at: '2026-10-17T10:00:00.000Z', revoked_at: null });
  denied(() => grantConsent(db, p, ids.kidA, 'nonsense' as never));
  denied(() => grantConsent(db, p, ids.kidA, 'data_processing', '  '));
  assert.ok(log(db, ids.owner).some(r => r.action === 'consent.granted.data_processing' && r.actor_id === ids.parentA && r.target_id === ids.kidA));
});

test('ребёнок до 16: без согласия записи нет; согласие на запись уроков его не заменяет; 16+ — без согласия можно', () => {
  const { db, ids } = seed();
  db.exec('DELETE FROM parental_consents');
  const p = actorOf(db, ids.parentA);
  const lesson = ids.lessonA;
  db.prepare(`UPDATE lesson_enrollments SET status='cancelled' WHERE student_id = ?`).run(ids.kidA);
  denied(() => enroll(db, p, lesson, ids.kidA));
  grantConsent(db, p, ids.kidA, 'lesson_recording');
  denied(() => enroll(db, p, lesson, ids.kidA));                  // не тот тип
  grantConsent(db, p, ids.kidA, 'data_processing');
  enroll(db, p, lesson, ids.kidA);
  assert.ok(hasActiveConsent(db, ids.kidA));
  assert.ok(log(db, ids.owner).some(r => r.action === 'enroll.no_consent' && r.outcome === 'denied'));
  // взрослый без согласия записывается (проверка возраста не должна требовать родителя)
  db.prepare("UPDATE lesson_enrollments SET status='cancelled' WHERE student_id = ?").run(ids.adultC);
  enroll(db, actorOf(db, ids.adultC), ids.lessonB, ids.adultC);
});

test('отзыв: будущие записи ребёнка сняты, новые заблокированы, прошедшие не тронуты, всё в журнале', () => {
  const { db, ids } = seed();
  const past = Number(db.prepare(`INSERT INTO lessons(teacher_id, starts_at, status) VALUES (?, '2020-01-01T10:00:00.000Z', 'done')`).run(ids.teacherA).lastInsertRowid);
  db.prepare(`INSERT INTO lesson_enrollments(lesson_id, student_id) VALUES (?,?)`).run(past, ids.kidA);
  const p = actorOf(db, ids.parentA);
  const r = revokeConsent(db, p, ids.kidA);
  assert.equal(r.cancelled, 1);
  assert.equal(count(db, `SELECT COUNT(*) c FROM lesson_enrollments WHERE student_id = ? AND status='active'`, ids.kidA), 1);   // осталась только прошедшая
  assert.equal((db.prepare('SELECT status FROM lesson_enrollments WHERE lesson_id = ? AND student_id = ?').get(ids.lessonA, ids.kidA) as { status: string }).status, 'cancelled');
  assert.equal(hasActiveConsent(db, ids.kidA), false);
  denied(() => enroll(db, p, ids.lessonA, ids.kidA));              // новые заблокированы
  const c = db.prepare('SELECT revoked_at, revoked_by, retain_until FROM parental_consents WHERE child_id = ?').get(ids.kidA) as { revoked_at: string; revoked_by: number; retain_until: string };
  assert.equal(c.revoked_by, ids.parentA); assert.ok(c.revoked_at && c.retain_until > c.revoked_at);
  const l = log(db, ids.owner);
  assert.ok(l.some(x => x.action === 'consent.revoked.data_processing' && x.actor_id === ids.parentA));
  assert.ok(l.some(x => x.action === 'consent.enrollment_cancelled' && x.target_id === ids.lessonA));
  // повторный отзыв ничего не ломает и фиксируется как «нечего отзывать»
  assert.equal(revokeConsent(db, p, ids.kidA).cancelled, 0);
  assert.ok(log(db, ids.owner).some(x => x.action === 'consent.revoke.nothing_active'));
});

test('отзыв снимает согласия ВСЕХ родителей ребёнка (иначе второй активный продолжал бы пускать запись)', () => {
  const { db, ids } = seed();
  db.prepare('INSERT INTO parent_child(parent_id, child_id) VALUES (?,?)').run(ids.parentB, ids.kidA);
  grantConsent(db, actorOf(db, ids.parentB), ids.kidA);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM parental_consents WHERE child_id = ? AND revoked_at IS NULL', ids.kidA), 2);
  revokeConsent(db, actorOf(db, ids.parentB), ids.kidA);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM parental_consents WHERE child_id = ? AND revoked_at IS NULL', ids.kidA), 0);
  assert.equal(hasActiveConsent(db, ids.kidA), false);
});

test('изоляция: отзывать/читать/выгружать/удалять чужого ребёнка нельзя; отказы в журнале', () => {
  const { db, ids } = world();
  const pB = actorOf(db, ids.parentB);
  denied(() => revokeConsent(db, pB, ids.kidA));
  denied(() => listConsents(db, pB, ids.kidA));
  denied(() => exportData(db, pB, ids.kidA));
  denied(() => eraseData(db, pB, ids.kidA));
  denied(() => revokeConsent(db, actorOf(db, ids.kidA), ids.kidA));   // ребёнок сам не отзывает
  assert.ok(hasActiveConsent(db, ids.kidA));
  assert.equal(count(db, 'SELECT COUNT(*) c FROM msg_posts'), 3);
  const l = log(db, ids.owner);
  for (const act of ['consent.revoke', 'consent.read_child', 'data.export', 'data.erase']) assert.ok(l.some(x => x.action === act && x.actor_id === ids.parentB && x.outcome === 'denied'), act);
});

test('(а) преподаватель: ни экспорта, ни согласий, ни удаления, ни чистки — даже по своему ученику; в журнале отказы', () => {
  const { db, ids } = world();
  const t = actorOf(db, ids.teacherA);                              // KidA — на его уроке
  denied(() => exportData(db, t, ids.kidA));
  denied(() => listConsents(db, t, ids.kidA));
  denied(() => revokeConsent(db, t, ids.kidA));
  denied(() => eraseData(db, t, ids.kidA));
  denied(() => runRetention(db, t));
  denied(() => exportData(db, t, ids.kidB));                        // и вне своего урока
  denied(() => exportData(db, t, ids.teacherA));                    // и себя здесь не выгрузить
  assert.ok(log(db, ids.owner).filter(x => x.actor_id === ids.teacherA && x.outcome === 'denied').length >= 7);
  assert.deepEqual(listStudents(db, t).map(x => x.id), [ids.kidA]); // список учеников — по-прежнему только свой урок
});

test('(б) ученик: ребёнок до 16 сам ничего не выгружает/не стирает; 16+ — только свои; чужих не видит', () => {
  const { db, ids } = world();
  const kid = actorOf(db, ids.kidA), adult = actorOf(db, ids.adultC);
  denied(() => exportData(db, kid, ids.kidA));
  denied(() => eraseData(db, kid, ids.kidA));
  denied(() => listConsents(db, kid, ids.kidA));
  denied(() => exportData(db, adult, ids.kidB));
  denied(() => exportData(db, adult, ids.kidA));
  denied(() => listConsents(db, adult, ids.kidB));
  denied(() => eraseData(db, adult, ids.kidB));
  const mine = exportData(db, adult, ids.adultC);
  assert.equal(mine.profile.display_name, 'AdultC');
  assert.equal(mine.contacts?.email, 'c@example.invalid');          // свои контакты — можно
  assert.deepEqual(mine.lessons.map(x => x.lesson_id), [ids.lessonB]);
  assert.deepEqual(listConsents(db, adult, ids.adultC), []);
});

test('(в) родитель: выгрузка ребёнка содержит его данные, а чужих имён, контактов, учеников урока и чужих реплик нет', () => {
  const { db, ids } = world();
  const ex = exportData(db, actorOf(db, ids.parentA), ids.kidA);
  assert.equal(ex.profile.display_name, 'KidA');
  assert.equal(ex.contacts, null);                                  // контакты ребёнка родителю не отдаются (как getContacts)
  assert.equal(ex.lessons.length, 1);
  assert.equal(ex.consents[0].scope, 'data_processing');
  assert.equal(ex.consents[0].text_version.length > 0, true);
  const bodies = ex.messages!.flatMap(m => m.posts.map(p => p.body));
  assert.deepEqual(bodies, ['Teacher secret phrase alpha', 'Kid secret phrase beta', 'Parent secret phrase gamma']);
  const text = JSON.stringify(ex);
  for (const foreign of ['KidB', 'AdultC', 'ParentB', 'TeacherB', 'example.invalid', '+000', 'pa@', 'kida@', 'ta@']) assert.ok(!text.includes(foreign), `в экспорте лишнее: ${foreign}`);
  denied(() => exportData(db, actorOf(db, ids.parentA), ids.kidB));
  denied(() => exportData(db, actorOf(db, ids.parentA), ids.adultC));
  // журнал фиксирует экспорт
  assert.ok(log(db, ids.owner).some(x => x.action === 'data.exported' && x.actor_id === ids.parentA && x.target_id === ids.kidA && x.outcome === 'allowed'));
  // выгрузка родителя о себе: только его реплики, свои контакты
  const own = exportData(db, actorOf(db, ids.parentA), ids.parentA);
  assert.equal(own.contacts?.email, 'pa@example.invalid');
  assert.deepEqual(own.messages!.flatMap(m => m.posts.map(p => p.body)), ['Parent secret phrase gamma']);
});

test('владелец: без выданного права чужие данные не выгружает; с правом — без контактов и без тел сообщений, пока нет message.read_any', () => {
  const { db, ids } = world();
  const o = actorOf(db, ids.owner);
  denied(() => exportData(db, o, ids.kidA));
  assert.ok(log(db, ids.owner).some(x => x.action === 'data.export_any' && x.outcome === 'denied'));
  db.prepare(`INSERT INTO role_permissions(role, permission) VALUES ('owner','data.export_any')`).run();
  const ex = exportData(db, o, ids.kidA);
  assert.equal(ex.messages, null);
  assert.equal(ex.contacts, null);
  assert.ok(!JSON.stringify(ex).includes('secret phrase'));
  db.prepare(`INSERT INTO role_permissions(role, permission) VALUES ('owner','message.read_any')`).run();
  assert.equal(exportData(db, o, ids.kidA).messages!.length, 1);
});

test('удаление по просьбе родителя: тела сообщений (и реплики других в ветке), контакты, вход стёрты; в журнале факт без персональных данных', () => {
  const { db, ids, th } = world();
  const now = Date.parse('2026-10-17T12:00:00Z');
  eraseData(db, actorOf(db, ids.parentA), ids.kidA, now);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM msg_posts WHERE thread_id = ?', th), 0);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM msg_threads'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM contact_vault WHERE user_id = ?', ids.kidA), 0);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM credentials WHERE user_id = ?', ids.kidA), 0);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM sessions WHERE user_id = ?', ids.kidA), 0);
  assert.equal(count(db, `SELECT COUNT(*) c FROM login_attempts WHERE login = 'kida-login'`), 0);
  const u = db.prepare('SELECT display_name, birth_date, anonymized_at FROM users WHERE id = ?').get(ids.kidA) as { display_name: string; birth_date: string | null; anonymized_at: string };
  assert.equal(u.display_name, 'Deleted user'); assert.equal(u.birth_date, null); assert.ok(u.anonymized_at);
  // учёт сохранён, но без имени: запись об уроке и согласие с отметкой срока хранения
  const en = db.prepare('SELECT status, retain_until FROM lesson_enrollments WHERE student_id = ?').get(ids.kidA) as { status: string; retain_until: string };
  assert.equal(en.status, 'cancelled');
  assert.equal(en.retain_until, new Date(now + LEGAL_RETENTION_DAYS * DAY).toISOString());
  const c = db.prepare('SELECT revoked_at, retain_until FROM parental_consents WHERE child_id = ?').get(ids.kidA) as { revoked_at: string; retain_until: string };
  assert.ok(c.revoked_at && c.retain_until === en.retain_until);
  // журнал: факт есть, текстов и имён нет
  const l = log(db, ids.owner);
  assert.ok(l.some(x => x.action === 'data.erased' && x.actor_id === ids.parentA && x.target_id === ids.kidA));
  const dump = JSON.stringify(l);
  for (const leak of ['secret phrase', 'KidA', 'kida@', 'kida-login']) assert.ok(!dump.includes(leak), leak);
  // повторно и после удаления — отказ; доступа к удалённому нет ни у кого из прежде связанных
  denied(() => eraseData(db, actorOf(db, ids.owner), ids.kidA));
  denied(() => exportData(db, actorOf(db, ids.parentA), ids.kidA));
  denied(() => getProfile(db, actorOf(db, ids.parentA), ids.kidA));
  assert.deepEqual(listStudents(db, actorOf(db, ids.teacherA)), []);
  assert.deepEqual(listStudents(db, actorOf(db, ids.teacherB)).map(x => x.id), [ids.kidB, ids.adultC]);   // чужая группа не задета
});

test('удаление: ученик 16+ стирает себя; чужие данные не задеты; владелец по праву data.erase_any; владельца и преподавателя не стереть', () => {
  const { db, ids } = world();
  eraseData(db, actorOf(db, ids.adultC), ids.adultC);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM contact_vault WHERE user_id = ?', ids.adultC), 0);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM contact_vault WHERE user_id = ?', ids.kidB), 1);
  assert.equal((db.prepare('SELECT display_name FROM users WHERE id = ?').get(ids.kidB) as { display_name: string }).display_name, 'KidB');
  eraseData(db, actorOf(db, ids.owner), ids.kidB);
  assert.ok(log(db, ids.owner).some(x => x.action === 'data.erased' && x.actor_id === ids.owner && x.target_id === ids.kidB));
  denied(() => eraseData(db, actorOf(db, ids.owner), ids.teacherA));
  denied(() => eraseData(db, actorOf(db, ids.owner), ids.owner));
});

test('удаление родителя: его реплики стираются, согласия отозваны, будущие записи детей без другого согласия сняты', () => {
  const { db, ids } = world();
  eraseData(db, actorOf(db, ids.parentA), ids.parentA);
  assert.equal(count(db, `SELECT COUNT(*) c FROM msg_posts WHERE body LIKE 'Parent secret%'`), 0);
  assert.equal(count(db, `SELECT COUNT(*) c FROM msg_posts WHERE body LIKE 'Kid secret%'`), 1);
  assert.equal(hasActiveConsent(db, ids.kidA), false);
  assert.equal(count(db, `SELECT COUNT(*) c FROM lesson_enrollments WHERE student_id = ? AND status = 'active'`, ids.kidA), 0);
  denied(() => enroll(db, actorOf(db, ids.owner), ids.lessonA, ids.kidA));
});

test('срок хранения: старые сообщения и попытки входа чистятся по параметру, свежие остаются; журнал цел', () => {
  const { db, ids, th } = world();
  const now = Date.now();
  const old = new Date(now - 800 * DAY).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(`UPDATE msg_posts SET created_at = ? WHERE body LIKE 'Teacher%'`).run(old);
  db.prepare(`INSERT INTO login_attempts(login, ts, ok) VALUES ('x', ?, 0)`).run(now - 100 * DAY);
  const auditBefore = count(db, 'SELECT COUNT(*) c FROM audit_log');
  const r = runRetention(db, actorOf(db, ids.owner), { now });
  assert.equal(r.messages, 1); assert.equal(r.login_attempts, 1);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM msg_posts WHERE thread_id = ?', th), 2);
  // параметр срока: 0 дней — уходит всё, ветка без реплик — тоже
  assert.equal(runRetention(db, actorOf(db, ids.owner), { now: now + DAY, messageDays: 0 }).messages, 2);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM msg_threads'), 0);
  assert.ok(count(db, 'SELECT COUNT(*) c FROM audit_log') > auditBefore);   // журнал не чистился, только дописывался
  denied(() => runRetention(db, actorOf(db, ids.parentA)));
  denied(() => runRetention(db, actorOf(db, ids.owner), { messageDays: -1 }));
});

test('срок хранения: после retain_until удаляются согласие, запись об уроке и сам обезличенный пользователь; до срока — остаются', () => {
  const { db, ids } = world();
  const t0 = Date.parse('2026-10-17T12:00:00Z');
  eraseData(db, actorOf(db, ids.parentA), ids.kidA, t0);
  const o = actorOf(db, ids.owner);
  const early = runRetention(db, o, { now: t0 + 365 * DAY });
  assert.deepEqual([early.consents, early.enrollments, early.users], [0, 0, 0]);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM users WHERE id = ?', ids.kidA), 1);
  const late = runRetention(db, o, { now: t0 + (LEGAL_RETENTION_DAYS + 1) * DAY });
  assert.deepEqual([late.consents, late.enrollments, late.users], [1, 1, 1]);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM users WHERE id = ?', ids.kidA), 0);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM users WHERE id = ?', ids.kidB), 1);   // чужие нетронуты
  assert.equal(count(db, 'SELECT COUNT(*) c FROM parental_consents WHERE child_id = ?', ids.kidB), 1);
});
