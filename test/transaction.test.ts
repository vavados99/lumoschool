// Ф4: проверка правил и запись — одна транзакция (BEGIN IMMEDIATE). Параллельные вызовы не пробивают лимит.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';
import { enroll, cancelEnrollment, actorOf, ScheduleError } from '../src/access.ts';
import { seed } from './seed.ts';

const NOW = Date.parse('2027-01-15T10:00:00Z');

test('транзакция: BEGIN IMMEDIATE до проверок, запись внутри транзакции, COMMIT в конце — и при отказе тоже (журнал остаётся)', () => {
  const { db, ids } = seed();
  const calls: string[] = [];
  const writesInTx: boolean[] = [];
  const spy = new Proxy(db, {
    get(t, k) {
      if (k === 'exec') return (sql: string) => { calls.push(sql); return t.exec(sql); };
      if (k === 'prepare') return (sql: string) => {
        if (/^\s*(INSERT INTO|UPDATE)\s+lesson_enrollments/i.test(sql)) writesInTx.push(t.isTransaction);
        if (/SELECT\s/i.test(sql) && calls.length === 0) assert.fail('чтение до BEGIN IMMEDIATE: ' + sql.slice(0, 40));
        return t.prepare(sql);
      };
      const v = (t as any)[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as DatabaseSync;
  const owner = actorOf(db, ids.owner);
  const lesson = Number(db.prepare(`INSERT INTO lessons(teacher_id, starts_at) VALUES (?, '2099-03-03T10:00:00.000Z')`).run(ids.teacherA).lastInsertRowid);
  enroll(spy, owner, lesson, ids.adultC, NOW);
  assert.deepEqual(calls, ['BEGIN IMMEDIATE', 'COMMIT']);
  assert.deepEqual(writesInTx, [true]);
  assert.equal(db.isTransaction, false);
  // отказ: транзакция закрыта, запись об отказе в журнале на месте
  calls.length = 0;
  assert.throws(() => enroll(spy, owner, lesson, ids.adultC, NOW), ScheduleError);
  assert.deepEqual(calls, ['BEGIN IMMEDIATE', 'COMMIT']);
  assert.equal(db.isTransaction, false);
  assert.ok((db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE action='enroll.duplicate' AND outcome='denied'`).get() as { c: number }).c >= 1);
  // отмена — тоже в транзакции
  calls.length = 0;
  cancelEnrollment(spy, owner, lesson, ids.adultC, NOW);
  assert.deepEqual(calls, ['BEGIN IMMEDIATE', 'COMMIT']);
});

test('неожиданная ошибка внутри транзакции — ROLLBACK, блокировка снята', () => {
  const { db, ids } = seed();
  const owner = actorOf(db, ids.owner);
  const lesson = Number(db.prepare(`INSERT INTO lessons(teacher_id, starts_at) VALUES (?, '2099-03-03T10:00:00.000Z')`).run(ids.teacherA).lastInsertRowid);
  db.exec('DROP TABLE parental_consents');                      // ломаем базу: проверка согласия упадёт SQL-ошибкой
  assert.throws(() => enroll(db, owner, lesson, ids.kidA, NOW), (e: unknown) => !(e instanceof ScheduleError));
  assert.equal(db.isTransaction, false);
});

type Res = Record<string, string>;
function runWorkers(path: string, ownerId: number, plan: string[][]): Promise<Res> {
  const startAt = Date.now() + 1500;
  return Promise.all(plan.map(jobs => new Promise<string>((resolve, reject) => {
    const p = spawn(process.execPath, [fileURLToPath(new URL('./race-worker.ts', import.meta.url)), path, String(startAt), String(ownerId), ...jobs], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', c => c === 0 ? resolve(out) : reject(new Error(`worker exit ${c}: ${err.slice(0, 200)}`)));
  }))).then(outs => {
    const r: Res = {};
    for (const line of outs.join('').trim().split('\n')) { const [k, v] = line.split(' '); r[k] = v; }
    return r;
  });
}

test('гонка: 10 процессов одновременно на урок с лимитом 3 — ровно 3 записи; один ученик на два пересекающихся урока — ровно одна запись', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumo-race-'));
  const path = join(dir, 'race.db');
  try {
    const db = openDb(path);
    const user = (role: string, name: string, birth: string | null) => {
      const id = Number(db.prepare('INSERT INTO users(role, display_name, birth_date) VALUES (?,?,?)').run(role, name, birth).lastInsertRowid);
      if (role === 'student') db.prepare('INSERT INTO students(user_id) VALUES (?)').run(id);
      return id;
    };
    const owner = user('owner', 'O', null), teacher = user('teacher', 'T', null);
    const lesson = (iso: string, max: number) => Number(db.prepare('INSERT INTO lessons(teacher_id, starts_at, max_students) VALUES (?,?,?)').run(teacher, iso, max).lastInsertRowid);
    const full = lesson('2099-05-05T10:00:00.000Z', 3);
    const students = Array.from({ length: 10 }, (_, i) => user('student', 'S' + i, '1990-01-01'));
    const l1 = lesson('2099-06-06T10:00:00.000Z', 6), l2 = lesson('2099-06-06T10:30:00.000Z', 6);  // пересекаются
    const dbl = user('student', 'D', '1990-01-01');
    db.close();

    // раунд 1: лимит. Каждый процесс — свой ученик на один и тот же урок.
    const r1 = await runWorkers(path, owner, students.map(s => [`${full}:${s}`]));
    const vals = Object.values(r1);
    assert.equal(vals.length, 10);
    assert.deepEqual(vals.filter(v => v.startsWith('error')), [], 'неожиданные ошибки: ' + JSON.stringify(r1));
    assert.equal(vals.filter(v => v === 'ok').length, 3);
    assert.equal(vals.filter(v => v === 'refused').length, 7);
    // раунд 2: один ученик, два пересекающихся урока, процессы атакуют попеременно
    const r2 = await runWorkers(path, owner, [[`${l1}:${dbl}`], [`${l2}:${dbl}`], [`${l1}:${dbl}`], [`${l2}:${dbl}`], [`${l2}:${dbl}`], [`${l1}:${dbl}`]]);
    assert.deepEqual(Object.values(r2).filter(v => v.startsWith('error')), [], JSON.stringify(r2));

    const chk = new DatabaseSync(path);
    const c = (sql: string, ...a: number[]) => (chk.prepare(sql).get(...a) as { c: number }).c;
    assert.equal(c(`SELECT COUNT(*) c FROM lesson_enrollments WHERE lesson_id=? AND status='active'`, full), 3);
    assert.equal(c(`SELECT COUNT(*) c FROM lesson_enrollments WHERE student_id=? AND status='active'`, dbl), 1);
    chk.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
