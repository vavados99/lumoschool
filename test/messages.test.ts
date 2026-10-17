// Ф6: сообщения только внутри платформы; взрослый–ребёнок только через родителя. Данные выдуманные.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.ts';
import { actorOf, readAudit, Denied } from '../src/access.ts';
import { openThread, postMessage, sendDirect, readThread, listThreads, findContactLeak, isChild, MessageRejected } from '../src/messages.ts';

const denied = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof Denied);
const rejected = (fn: () => unknown, reason?: string) =>
  assert.throws(fn, (e: unknown) => e instanceof MessageRejected && (!reason || e.reason === reason));
type Log = { actor_id: number | null; action: string; outcome: string }[];
const auditOf = (db: ReturnType<typeof seed>['db'], ownerId: number) => readAudit(db, actorOf(db, ownerId)) as Log;

/** Ветка учителя A с KidA (родитель — ParentA). */
function threadA() {
  const s = seed();
  const t = actorOf(s.db, s.ids.teacherA);
  const th = openThread(s.db, t, s.ids.teacherA, s.ids.kidA);
  return { ...s, t, th };
}

test('преподаватель → ребёнку напрямую: отказ, ничего не записано, отказ в журнале', () => {
  const { db, ids } = seed();
  const t = actorOf(db, ids.teacherA);
  denied(() => sendDirect(db, t, ids.kidA, 'hello'));            // ребёнок СВОЕГО урока
  assert.equal((db.prepare('SELECT COUNT(*) c FROM msg_posts').get() as { c: number }).c, 0);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM msg_threads').get() as { c: number }).c, 0);
  assert.ok(auditOf(db, ids.owner).some(r => r.action === 'message.direct_to_child' && r.actor_id === ids.teacherA && r.outcome === 'denied'));
});

test('через ветку с родителем разрешено: родитель и ребёнок видят всю ветку', () => {
  const { db, ids, t, th } = threadA();
  postMessage(db, t, th, 'Great lesson, KidA! Homework: page 12.');
  const kid = actorOf(db, ids.kidA), par = actorOf(db, ids.parentA);
  postMessage(db, kid, th, 'Thank you!');
  postMessage(db, par, th, 'Thanks, we will do it.');
  for (const who of [t, kid, par]) assert.deepEqual(readThread(db, who, th).map(p => p.from_id), [ids.teacherA, ids.kidA, ids.parentA]);
  assert.deepEqual(listThreads(db, par), [th]);
});

test('чужой родитель не видит, не читает и не пишет в ветку', () => {
  const { db, ids, t, th } = threadA();
  postMessage(db, t, th, 'private note for the family');
  const other = actorOf(db, ids.parentB);
  denied(() => readThread(db, other, th));
  denied(() => postMessage(db, other, th, 'hello'));
  denied(() => openThread(db, other, ids.teacherA, ids.kidA));
  assert.deepEqual(listThreads(db, other), []);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM msg_posts').get() as { c: number }).c, 1);
});

test('ученик не видит чужие ветки (ни ребёнок, ни взрослый)', () => {
  const { db, ids, th } = threadA();
  const tb = actorOf(db, ids.teacherB);
  const thB = openThread(db, tb, ids.teacherB, ids.adultC);
  postMessage(db, tb, thB, 'Hi AdultC');
  denied(() => readThread(db, actorOf(db, ids.kidB), th));
  denied(() => readThread(db, actorOf(db, ids.kidB), thB));
  denied(() => readThread(db, actorOf(db, ids.adultC), th));
  denied(() => readThread(db, actorOf(db, ids.kidA), thB));
  denied(() => postMessage(db, actorOf(db, ids.kidB), th, 'hi'));
  assert.deepEqual(listThreads(db, actorOf(db, ids.kidB)), []);
  assert.deepEqual(listThreads(db, actorOf(db, ids.adultC)), [thB]);
});

test('преподаватель без урока с этим учеником не пишет и не читает; снятие записи закрывает ветку', () => {
  const { db, ids, t, th } = threadA();
  denied(() => openThread(db, t, ids.teacherA, ids.kidB));          // нет урока с KidB
  denied(() => openThread(db, t, ids.teacherA, ids.adultC));
  denied(() => sendDirect(db, t, ids.adultC, 'hello'));             // взрослый, но не мой ученик
  const tb = actorOf(db, ids.teacherB);
  denied(() => readThread(db, tb, th));                              // чужая ветка
  denied(() => postMessage(db, tb, th, 'hello'));
  denied(() => openThread(db, tb, ids.teacherA, ids.kidA));          // нельзя выдать себя за другого преподавателя
  postMessage(db, t, th, 'ok');
  db.prepare("UPDATE lesson_enrollments SET status='cancelled' WHERE student_id = ?").run(ids.kidA);
  denied(() => postMessage(db, t, th, 'still there?'));
  denied(() => readThread(db, t, th));
});

test('телефоны отклоняются, в том числе с пробелами, словами и полноширинными цифрами', () => {
  const { db, t, th } = threadA();
  const bad = [
    'call me +48 123 456 789', '+48123456789', '48-123-456-789', '(022) 123 45 67', '1 2 3 4 5 6 7 8',
    'zero seven nine one two three four', 'пять пять пять один два три четыре', '８００ １２３ ４５６７',
    '555.123.4567', '+4 8 1 2 3 4 5 6 7 8 9', 'мой номер 12.34.56.78', 'номер 5 5 5 - 1 2 - 3 4',
    '123 hi 456 hi 789 hi 012',
  ];
  for (const b of bad) rejected(() => postMessage(db, t, th, b), 'phone');
  assert.equal((db.prepare('SELECT COUNT(*) c FROM msg_posts').get() as { c: number }).c, 0);
});

test('e-mail и @ник отклоняются, включая «at», «собака», [at], полноширинную @', () => {
  const { db, t, th } = threadA();
  const bad = [
    'kid.a@example.invalid', 'kid @ example . invalid', 'write to kida [at] example.invalid', 'kida (at) example (dot) invalid',
    'kida собака example точка com', 'kida Собака gmail', 'kida at example dot com', 'kida at example . com', 'ping me @kida_cool',
    'kida＠example.invalid', 'k\u200bida@exa\u200bmple.invalid',
  ];
  for (const b of bad) rejected(() => postMessage(db, t, th, b), 'email_or_handle');
});

test('ссылки и мессенджеры отклоняются: t.me, wa.me, http, www, «точка», Telegram', () => {
  const { db, t, th } = threadA();
  const links: string[] = ['t.me/kida', 'join t . me / kida', 't (dot) me/kida', 'wa.me/48123', 'https://example.invalid/x', 'HTTP://EXAMPLE.INVALID',
    'www . example . invalid', 'go to example.com', 'example dot com', 'example точка ru', 'example(dot)org'];
  for (const b of links) rejected(() => postMessage(db, t, th, b), 'link');
  for (const b of ['add me on Telegram', 'пиши в телеграм', 'мой ватсап', 'WhatsApp?', 'find me on Discord', 'пиши в тг'])
    rejected(() => postMessage(db, t, th, b), 'messenger');
  assert.equal((db.prepare('SELECT COUNT(*) c FROM msg_posts').get() as { c: number }).c, 0);
});

test('обычный учебный текст проходит: даты, время, номера страниц, слово «at»', () => {
  const { db, t, th } = threadA();
  for (const ok of ['Lesson moved to 21.10.2026 at 10:30, look at page 12 exercise 3.', 'Please read unit 5, pages 40-45.',
    'Привет! Домашнее: упражнение 3 на странице 12, повторить 20 слов.', 'See you on 2026-10-21 at 18:00!'])
    postMessage(db, t, th, ok);
  assert.equal(readThread(db, t, th).length, 4);
});

test('взрослый ученик (18+) без родителя переписывается с преподавателем по своему уроку', () => {
  const { db, ids } = seed();
  const tb = actorOf(db, ids.teacherB), ad = actorOf(db, ids.adultC);
  assert.equal(isChild(db, ids.adultC), false);
  sendDirect(db, tb, ids.adultC, 'Hello AdultC, see you Monday');
  sendDirect(db, ad, ids.teacherB, 'Thanks!');
  const th = listThreads(db, ad)[0];
  assert.deepEqual(readThread(db, tb, th).map(p => p.from_id), [ids.teacherB, ids.adultC]);
  // родитель взрослого ученика его переписку не видит
  db.prepare('INSERT INTO parent_child(parent_id, child_id) VALUES (?,?)').run(ids.parentA, ids.adultC);
  denied(() => readThread(db, actorOf(db, ids.parentA), th));
  assert.deepEqual(listThreads(db, actorOf(db, ids.parentA)).includes(th), false);
  // и фильтр контактов действует на взрослых так же
  rejected(() => postMessage(db, ad, th, 'my phone +48 123 456 789'), 'phone');
});

test('граница 18: 17-летний — ребёнок; ребёнок без родителя — ветки нет вообще', () => {
  const { db, ids } = seed();
  const now = new Date();
  const bd = (years: number, dayShift: number) => new Date(now.getFullYear() - years, now.getMonth(), now.getDate() + dayShift).toISOString().slice(0, 10);
  db.prepare('UPDATE users SET birth_date = ? WHERE id = ?').run(bd(18, 1), ids.adultC);   // 18 исполнится завтра
  assert.equal(isChild(db, ids.adultC), true);
  denied(() => sendDirect(db, actorOf(db, ids.teacherB), ids.adultC, 'hello'));
  db.prepare('UPDATE users SET birth_date = ? WHERE id = ?').run(bd(18, 0), ids.adultC);   // исполнилось сегодня
  assert.equal(isChild(db, ids.adultC), false);
  sendDirect(db, actorOf(db, ids.teacherB), ids.adultC, 'hello');
  // ребёнок без родителя
  db.prepare('DELETE FROM parent_child WHERE child_id = ?').run(ids.kidB);
  denied(() => openThread(db, actorOf(db, ids.teacherB), ids.teacherB, ids.kidB));
  denied(() => openThread(db, actorOf(db, ids.kidB), ids.teacherB, ids.kidB));
  // нет даты рождения = ребёнок
  db.prepare('UPDATE users SET birth_date = NULL WHERE id = ?').run(ids.adultC);
  assert.equal(isChild(db, ids.adultC), true);
});

test('ребёнок пишет только преподавателю своего урока и только в ветке с родителем', () => {
  const { db, ids, th } = threadA();
  const kid = actorOf(db, ids.kidA);
  denied(() => openThread(db, kid, ids.teacherB, ids.kidA));    // у KidA нет урока с учителем B
  denied(() => sendDirect(db, kid, ids.teacherB, 'hi'));
  denied(() => sendDirect(db, kid, ids.parentA, 'hi'));          // и не «просто кому угодно»
  denied(() => sendDirect(db, kid, ids.adultC, 'hi'));
  postMessage(db, kid, th, 'Hello teacher');                     // в ветке с родителем — можно
  assert.equal(readThread(db, actorOf(db, ids.parentA), th).length, 1);
});

test('журнал: отправка, отказ и отклонение контакта записаны, текста в журнале нет', () => {
  const { db, ids, t, th } = threadA();
  const SECRET = 'zebra-secret-phrase';
  postMessage(db, t, th, `${SECRET} homework`);
  rejected(() => postMessage(db, t, th, `${SECRET} call +48 123 456 789`), 'phone');
  rejected(() => postMessage(db, t, th, `${SECRET} write kida@example.invalid`), 'email_or_handle');
  denied(() => readThread(db, actorOf(db, ids.parentB), th));
  const log = auditOf(db, ids.owner);
  assert.ok(log.some(r => r.action === 'message.sent' && r.outcome === 'allowed' && r.actor_id === ids.teacherA));
  assert.ok(log.some(r => r.action === 'message.rejected.phone' && r.outcome === 'denied' && r.actor_id === ids.teacherA));
  assert.ok(log.some(r => r.action === 'message.thread.read' && r.outcome === 'denied' && r.actor_id === ids.parentB));
  const dump = JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
  assert.ok(!dump.includes(SECRET) && !dump.includes('123 456') && !dump.includes('example.invalid'));
  assert.throws(() => db.prepare('DELETE FROM audit_log').run());        // журнал не стирается
});

test('владелец читает журнал, но не тела сообщений — пока право не выдано явно', () => {
  const { db, ids, t, th } = threadA();
  postMessage(db, t, th, 'only for the family');
  const o = actorOf(db, ids.owner);
  assert.ok(readAudit(db, o).length > 0);                             // журнал — да
  denied(() => readThread(db, o, th));                                // тела — нет
  denied(() => postMessage(db, o, th, 'hello'));                      // и писать в ветки владелец не может
  assert.deepEqual(listThreads(db, o), []);
  assert.ok(auditOf(db, ids.owner).some(r => r.action === 'message.read_any' && r.outcome === 'denied'));
  // явная выдача права: читает, и каждое чтение остаётся в журнале
  db.prepare("INSERT INTO role_permissions(role, permission) VALUES ('owner','message.read_any')").run();
  assert.equal(readThread(db, o, th)[0].body, 'only for the family');
  assert.ok(auditOf(db, ids.owner).some(r => r.action === 'message.read_any' && r.outcome === 'allowed'));
});

test('findContactLeak: ложные срабатывания на обычных фразах минимальны', () => {
  for (const ok of ['Good job!', 'We meet at 10:30 tomorrow.', 'Homework: exercises 1-5, page 22.', 'Спасибо, до встречи на уроке 3 ноября.', 'I have 3 apples and 2 pears.'])
    assert.equal(findContactLeak(ok), null, ok);
});
