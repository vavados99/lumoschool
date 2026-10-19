// Ф26: (а) каждый слой защиты ручки удаления проверяется ОТДЕЛЬНЫМ тестом, красным только при поломке этого слоя:
//      слой «ядро» (consent.eraseData: права роли + принадлежность) — напрямую, без HTTP;
//      слой «маршрут» (список ролей в server.ts) — с подменой ядра на шпиона: роль, которой нельзя, до ядра не доходит;
//   (б) «надгробия» стёртых (erased_subjects: только id и время) и повторное стирание при восстановлении из старой копии.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';
import { seedDemo } from '../src/seed.ts';
import { createApp, listen, COOKIE } from '../src/server.ts';
import { actorOf, Denied } from '../src/access.ts';
import { eraseData, reapplyErasures } from '../src/consent.ts';
import { backupDb } from '../src/backup.ts';
import { restoreDb } from '../src/restore.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });
const n = (db: DatabaseSync, sql: string, ...p: (string | number)[]) => Number((db.prepare(sql).get(...p) as { c: number }).c);
const erasedRow = (db: DatabaseSync, id: number) => db.prepare('SELECT display_name, birth_date, anonymized_at FROM users WHERE id = ?').get(id) as { display_name: string; birth_date: string | null; anonymized_at: string | null };

// ---------- слой «ядро»: без HTTP ----------
test('Ф26 слой ЯДРО: eraseData сам отказывает преподавателю, ученику, чужому родителю — Denied, ничего не стёрто, отказ в журнале', () => {
  const db = openDb(':memory:');
  const demo = seedDemo(db);
  const U = demo.users;
  const kid = U.KidA.id;
  for (const [who, target] of [['TeacherA', 'KidA'], ['TeacherB', 'KidA'], ['KidA', 'KidA'], ['KidB', 'KidA'], ['AdultD', 'KidA'], ['ParentB', 'KidA'], ['ParentA', 'KidB'], ['ParentA', 'Owner'], ['ParentA', 'TeacherA'], ['Owner', 'TeacherA'], ['Owner', 'Owner']] as const) {
    assert.throws(() => eraseData(db, actorOf(db, U[who].id), U[target].id), Denied, `${who} → ${target}`);
  }
  assert.equal(erasedRow(db, kid).anonymized_at, null);
  assert.equal(n(db, 'SELECT COUNT(*) c FROM credentials WHERE user_id = ?', kid), 1);
  assert.equal(n(db, 'SELECT COUNT(*) c FROM erased_subjects'), 0, 'отказ не оставляет надгробий');
  assert.ok(n(db, `SELECT COUNT(*) c FROM audit_log WHERE action IN ('data.erase','data.erase_any') AND outcome = 'denied'`) >= 8);
  // и разрешённые доходят: родитель — своего ребёнка, владелец — любого ученика
  eraseData(db, actorOf(db, U.ParentA.id), kid);
  assert.equal(erasedRow(db, kid).display_name, 'Deleted user');
  eraseData(db, actorOf(db, U.Owner.id), U.KidB.id);
  assert.equal(erasedRow(db, U.KidB.id).display_name, 'Deleted user');
});

// ---------- слой «маршрут»: ядро подменено шпионом, который ничего не проверяет ----------
test('Ф26 слой МАРШРУТ: список ролей ручки сам не пускает преподавателя/ученика/аноним до ядра; confirm проверяется до ядра', async () => {
  const db = openDb(':memory:');
  const demo = seedDemo(db);
  const calls: { actorId: number; subject: number }[] = [];
  const spy: typeof eraseData = (_db, a, subject) => { calls.push({ actorId: a.id, subject }); };   // «ядро» пропускает ВСЕХ
  const server = createApp(db, { rateLimit: false, eraser: spy });
  servers.push(server);
  const base = `http://127.0.0.1:${await listen(server, 0)}`;
  const jar: Record<string, string> = {};
  for (const k of ['TeacherA', 'TeacherB', 'KidA', 'TeenC', 'AdultD', 'ParentA', 'Owner']) {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: demo.users[k].login, password: demo.users[k].password }) });
    assert.equal(r.status, 200, k);
    jar[k] = /sid=([0-9a-f]+)/.exec(r.headers.get('set-cookie') ?? '')![1];
  }
  const post = (as: string | null, body: unknown) => fetch(`${base}/api/erase/${demo.users.KidA.id}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(as ? { cookie: `${COOKIE}=${jar[as]}` } : {}) }, body: JSON.stringify(body) });

  for (const who of ['TeacherA', 'TeacherB', 'KidA', 'TeenC', 'AdultD'])
    assert.equal((await post(who, { confirm: true })).status, 403, `${who}: маршрут обязан отказать сам`);
  assert.equal((await post(null, { confirm: true })).status, 401);
  assert.deepEqual(calls, [], 'до ядра запрещённые роли не дошли');

  for (const who of ['Owner', 'ParentA']) {
    assert.equal((await post(who, {})).status, 400, `${who}: без confirm`);
    assert.equal((await post(who, { confirm: 'yes' })).status, 400);
  }
  assert.deepEqual(calls, [], 'без confirm:true ядро не вызывается');

  assert.equal((await post('Owner', { confirm: true })).status, 200);
  assert.equal((await post('ParentA', { confirm: true })).status, 200);
  assert.deepEqual(calls, [{ actorId: demo.users.Owner.id, subject: demo.users.KidA.id }, { actorId: demo.users.ParentA.id, subject: demo.users.KidA.id }], 'разрешённые роли доходят до ядра с верными аргументами');
  assert.equal(erasedRow(db, demo.users.KidA.id).anonymized_at, null, 'шпион ничего не стирает — значит, отказы выше дало не ядро');
});

// ---------- надгробия ----------
test('Ф26 надгробие: после стирания в таблице только id и время; таблицу нельзя править и чистить', () => {
  const db = openDb(':memory:');
  const demo = seedDemo(db);
  const kid = demo.users.KidA.id;
  eraseData(db, actorOf(db, demo.users.Owner.id), kid, Date.parse('2026-10-01T10:00:00Z'));
  assert.deepEqual((db.prepare('PRAGMA table_info(erased_subjects)').all() as { name: string }[]).map(c => c.name), ['user_id', 'erased_at'], 'никаких персональных полей');
  assert.deepEqual(db.prepare('SELECT user_id, erased_at FROM erased_subjects').all().map(r => ({ ...r })), [{ user_id: kid, erased_at: '2026-10-01T10:00:00.000Z' }]);
  assert.throws(() => db.prepare('DELETE FROM erased_subjects').run(), /append-only/);
  assert.throws(() => db.prepare('UPDATE erased_subjects SET erased_at = ?').run('2000-01-01T00:00:00.000Z'), /append-only/);
  assert.throws(() => db.prepare('UPDATE erased_subjects SET user_id = 999').run(), /append-only/);
});

test('Ф26 повторное стирание не трогает человека, созданного ПОСЛЕ времени стирания (повторное использование id), и уже обезличенных', () => {
  const db = openDb(':memory:');
  const demo = seedDemo(db);
  const kid = demo.users.KidA.id;
  db.prepare('INSERT INTO erased_subjects(user_id, erased_at) VALUES (?, ?)').run(kid, '2000-01-01T00:00:00.000Z');   // «стёрт» раньше, чем строка создана
  assert.deepEqual(reapplyErasures(db), []);
  assert.equal(erasedRow(db, kid).display_name, 'Kai');
  db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run('1999-01-01 00:00:00', kid);   // теперь «был до стирания»
  assert.deepEqual(reapplyErasures(db), [kid]);
  assert.equal(erasedRow(db, kid).display_name, 'Deleted user');
  assert.deepEqual(reapplyErasures(db), [], 'второй раз — уже обезличен');
});

// ---------- копии и восстановление ----------
const tmp = () => mkdtempSync(join(tmpdir(), 'lumo-f26-'));
function rowsHash(file: string, sql: string, ...p: (string | number)[]): string {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return createHash('sha256').update((db.prepare(sql).all(...p) as object[]).map(r => JSON.stringify(r)).join('\n')).digest('hex'); } finally { db.close(); }
}
/** «чужие» данные: всё, что не относится к стёртому ребёнку (по id) */
const others = (file: string, kid: number) => ({
  users: rowsHash(file, 'SELECT * FROM users WHERE id != ? ORDER BY id', kid),
  contacts: rowsHash(file, 'SELECT * FROM contact_vault WHERE user_id != ? ORDER BY user_id', kid),
  creds: rowsHash(file, 'SELECT user_id, login, password_hash FROM credentials WHERE user_id != ? ORDER BY user_id', kid),
  lessons: rowsHash(file, 'SELECT * FROM lessons ORDER BY id'),
  enrollments: rowsHash(file, 'SELECT * FROM lesson_enrollments WHERE student_id != ? ORDER BY lesson_id, student_id', kid),
  consents: rowsHash(file, 'SELECT * FROM parental_consents WHERE child_id != ? ORDER BY id', kid),
  threads: rowsHash(file, 'SELECT * FROM msg_threads WHERE student_id != ? ORDER BY id', kid),
});

test('Ф26 seed → копия → стирание → восстановление из СТАРОЙ копии: стёртый снова обезличен, остальные данные целы, журнал это показывает', () => {
  const dir = tmp();
  try {
    const live = join(dir, 'live.sqlite');
    const db = openDb(live);
    const demo = seedDemo(db);
    const kid = demo.users.KidA.id;
    const { file: oldBackup } = backupDb(db, join(dir, 'bk'), { now: Date.parse('2026-10-01T03:00:00Z') });
    assert.equal(rowsHash(oldBackup, 'SELECT display_name FROM users WHERE id = ?', kid) !== '', true);
    const before = others(oldBackup, kid);

    eraseData(db, actorOf(db, demo.users.Owner.id), kid);                      // стирание ПОСЛЕ копии
    assert.equal(erasedRow(db, kid).display_name, 'Deleted user');
    db.close();

    // контроль: в старой копии человек ещё цел (иначе тест ничего не доказывает)
    const bk = new DatabaseSync(oldBackup, { readOnly: true });
    assert.equal((bk.prepare('SELECT display_name FROM users WHERE id = ?').get(kid) as any).display_name, 'Kai');
    assert.equal(n(bk, 'SELECT COUNT(*) c FROM contact_vault WHERE user_id = ?', kid), 1);
    bk.close();

    const r = restoreDb(oldBackup, live);
    assert.deepEqual(r.reErased, [kid]);
    assert.deepEqual(r.warnings, []);

    const after = openDb(live);
    try {
      assert.deepEqual({ ...erasedRow(after, kid) }, { display_name: 'Deleted user', birth_date: null, anonymized_at: erasedRow(after, kid).anonymized_at });
      assert.ok(erasedRow(after, kid).anonymized_at);
      for (const t of ['contact_vault', 'credentials', 'sessions', 'parent_child'])
        assert.equal(n(after, `SELECT COUNT(*) c FROM ${t} WHERE ${t === 'parent_child' ? 'child_id' : 'user_id'} = ?`, kid), 0, t);
      assert.equal(n(after, 'SELECT COUNT(*) c FROM msg_threads WHERE student_id = ?', kid), 0);
      assert.equal(n(after, `SELECT COUNT(*) c FROM parental_consents WHERE child_id = ? AND revoked_at IS NULL`, kid), 0);
      assert.equal(n(after, 'SELECT COUNT(*) c FROM audit_log WHERE actor_id = ?', kid), 0, 'ссылки в журнале обезличены');
      assert.equal(n(after, `SELECT COUNT(*) c FROM audit_log WHERE action = 'data.reerased_after_restore' AND target_id = ? AND outcome = 'allowed'`, kid), 1, 'повторное стирание видно в журнале');
      assert.equal(n(after, 'SELECT COUNT(*) c FROM erased_subjects WHERE user_id = ?', kid), 1, 'надгробие перенесено в восстановленную базу');
    } finally { after.close(); }
    assert.deepEqual(others(live, kid), before, 'остальные данные совпадают с копией');

    // повторное восстановление той же копии — снова обезличен (надгробие уже в базе), без предупреждений
    const r2 = restoreDb(oldBackup, live, { now: Date.now() + 1000 });
    assert.deepEqual(r2.reErased, [kid]);
    assert.equal(erasedRow(openDb(live), kid).display_name, 'Deleted user');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Ф26 копия, сделанная ПОСЛЕ стирания, несёт надгробие: восстановление в новый файл тоже обезличено; стирание родителя — тоже', () => {
  const dir = tmp();
  try {
    const live = join(dir, 'live.sqlite');
    const db = openDb(live);
    const demo = seedDemo(db);
    const { file: oldBackup } = backupDb(db, join(dir, 'bk'), { now: Date.parse('2026-10-01T03:00:00Z') });
    const parent = demo.users.ParentB.id;
    eraseData(db, actorOf(db, demo.users.Owner.id), parent);
    const { file: newBackup } = backupDb(db, join(dir, 'bk'), { now: Date.parse('2026-10-02T03:00:00Z') });
    db.close();

    const fresh = join(dir, 'fresh.sqlite');
    assert.deepEqual(restoreDb(newBackup, fresh).reErased, [], 'копия уже содержит стёртого — делать нечего');
    assert.equal(erasedRow(openDb(fresh), parent).display_name, 'Deleted user');

    // старая копия в новый путь: надгробие неоткуда взять — это ОГРАНИЧЕНИЕ (в docs/BACKUP.md): восстанавливать нужно на путь рабочей базы
    const fresh2 = join(dir, 'fresh2.sqlite');
    assert.deepEqual(restoreDb(oldBackup, fresh2).reErased, []);
    assert.notEqual(erasedRow(openDb(fresh2), parent).display_name, 'Deleted user');
    // ...но поверх рабочей базы — обезличен
    assert.deepEqual(restoreDb(oldBackup, live).reErased, [parent]);
    assert.equal(erasedRow(openDb(live), parent).display_name, 'Deleted user');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Ф26 изоляция после повторного стирания: преподаватель и другой родитель не видят обезличенного ребёнка', async () => {
  const dir = tmp();
  try {
    const live = join(dir, 'live.sqlite');
    const db = openDb(live);
    const demo = seedDemo(db);
    const kid = demo.users.KidA.id;
    const { file: bk } = backupDb(db, join(dir, 'bk'));
    eraseData(db, actorOf(db, demo.users.Owner.id), kid);
    db.close();
    restoreDb(bk, live);
    const db2 = openDb(live);
    const server = createApp(db2, { rateLimit: false });
    servers.push(server);
    const base = `http://127.0.0.1:${await listen(server, 0)}`;
    const login = async (k: string) => {
      const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: demo.users[k].login, password: demo.users[k].password }) });
      return { status: r.status, sid: /sid=([0-9a-f]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1] };
    };
    assert.equal((await login('KidA')).status, 401, 'стёртый не входит (вход восстановлен из копии и снова удалён)');
    for (const who of ['TeacherA', 'ParentB', 'KidB', 'Owner']) {
      const { sid } = await login(who);
      const txt = (await Promise.all(['/api/students', '/api/lessons', '/api/threads'].map(p => fetch(base + p, { headers: { cookie: `${COOKIE}=${sid}` } }).then(r => r.text())))).join('\n');
      assert.ok(!txt.includes('Kai'), `${who} не видит имя`);
      assert.ok(!txt.includes(demo.users.KidA.login), `${who} не видит логин`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
