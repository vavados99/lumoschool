import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// Миграции — по порядку; номер версии = PRAGMA user_version. Файл базы можно открывать сколько угодно раз:
// применяются только недостающие. Новая схема = новый файл в конец списка (старые не править).
const MIGRATIONS = [
  new URL('../db/schema.sql', import.meta.url),               // v1: Ф1–Ф7
  new URL('../db/migrations/002-room.sql', import.meta.url),  // v2: Ф9 комната урока
  new URL('../db/migrations/003-notifications.sql', import.meta.url),  // v3: Ф18 уведомления родителю
  new URL('../db/migrations/004-outbox.sql', import.meta.url),  // v4: Ф19b очередь доставки уведомлений
];

/** Версия схемы, которую знает этот код (= число миграций). */
export const SCHEMA_VERSION = MIGRATIONS.length;

const version = (db: DatabaseSync) => Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);

/** Путь к базе передаёт вызывающий (из config.ts); ':memory:' для тестов. */
export function openDb(path: string = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA foreign_keys = ON');
  if (version(db) < MIGRATIONS.length) {
    db.exec('BEGIN IMMEDIATE');   // write-lock: два процесса не мигрируют одновременно
    try {
      let v = version(db);        // перечитываем под замком
      // файл создан старой версией openDb (схема v1 без отметки версии)
      if (v === 0 && db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'`).get()) v = 1;
      for (; v < MIGRATIONS.length; v++) db.exec(readFileSync(MIGRATIONS[v], 'utf8'));
      db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return db;
}
