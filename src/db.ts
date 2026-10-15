import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const SCHEMA = new URL('../db/schema.sql', import.meta.url);

/** Путь к базе — из окружения (DATABASE_PATH); ':memory:' для тестов. */
export function openDb(path: string = process.env.DATABASE_PATH ?? ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  return db;
}
