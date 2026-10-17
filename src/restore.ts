// Ф11: восстановление базы из копии. Сначала копия проверяется, потом (и только потом) подменяется рабочий файл,
// а прежний файл откладывается рядом как страховка. Сервер на время восстановления нужно остановить.
// CLI:  DATABASE_PATH=/путь/lumo.sqlite node src/restore.ts <файл-копии>
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, copyFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCHEMA_VERSION } from './db.ts';

export const REQUIRED_TABLES = ['users', 'contact_vault', 'students', 'teachers', 'parent_child', 'parental_consents', 'lessons',
  'lesson_enrollments', 'role_permissions', 'audit_log', 'credentials', 'sessions', 'login_attempts', 'settings', 'msg_threads', 'msg_posts'];

/** Бросает Error, если файл — не целая копия нашей базы. Файл не меняет (открывает только на чтение). */
export function verifyBackup(file: string): { userVersion: number } {
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`backup rejected: file not found: ${file}`);
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const ic = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    if (ic.length !== 1 || ic[0].integrity_check !== 'ok') throw new Error('integrity_check failed');
    const uv = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (!(uv >= 1)) throw new Error(`bad user_version ${uv}`);
    if (uv > SCHEMA_VERSION) throw new Error(`schema v${uv} is newer than this code (v${SCHEMA_VERSION})`);
    const have = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(r => r.name));
    const missing = REQUIRED_TABLES.filter(t => !have.has(t));
    if (missing.length) throw new Error(`missing tables: ${missing.join(', ')}`);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('foreign_key_check failed');
    return { userVersion: uv };
  } catch (e) {
    throw new Error(`backup rejected: ${(e as Error).message}`);   // и «file is not a database», и битые страницы
  } finally { try { db?.close(); } catch { /* уже закрыта */ } }
}

export type RestoreResult = { target: string; safetyCopy: string | null };

/** Восстановить target из копии. Битая копия → ошибка, target не тронут. Прежний target → <target>.pre-restore-<UTC> (0600). */
export function restoreDb(backupFile: string, target: string, opts: { now?: number } = {}): RestoreResult {
  const src = resolve(backupFile), dst = resolve(target);
  if (src === dst) throw new Error('backup file and target are the same file');
  verifyBackup(src);                                   // ДО любых изменений

  const tmp = `${dst}.restoring`;
  try {
    if (existsSync(tmp)) unlinkSync(tmp);
    copyFileSync(src, tmp);
    chmodSync(tmp, 0o600);
    verifyBackup(tmp);                                 // копия на диске назначения цела
  } catch (e) { try { unlinkSync(tmp); } catch { /* нет */ } throw e; }

  let safetyCopy: string | null = null;
  try {
    if (existsSync(dst)) {
      safetyCopy = `${dst}.pre-restore-${new Date(opts.now ?? Date.now()).toISOString().replace(/[-:.]/g, '')}`;
      if (existsSync(safetyCopy)) throw new Error(`safety copy already exists: ${safetyCopy}`);
      copyFileSync(dst, safetyCopy);                   // побайтно: рабочая база может быть и повреждена — это страховка «как было»
      chmodSync(safetyCopy, 0o600);
    }
    for (const ext of ['-wal', '-shm', '-journal']) { try { unlinkSync(dst + ext); } catch { /* нет */ } }   // хвосты старой базы испортят новую
    renameSync(tmp, dst);
  } catch (e) { try { unlinkSync(tmp); } catch { /* нет */ } throw e; }
  return { target: dst, safetyCopy };
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const target = process.env.DATABASE_PATH, file = process.argv[2];
  if (!target || target === ':memory:' || !file) { console.error('Usage: DATABASE_PATH=/path/lumo.sqlite npm run restore -- <backup file>'); process.exit(1); }
  try {
    const r = restoreDb(file, target);
    console.log(`restore ok: ${r.target}`);
    console.log(r.safetyCopy ? `previous database kept as: ${r.safetyCopy}` : 'no previous database existed');
  } catch (e) { console.error(`restore FAILED: ${(e as Error).message}`); process.exit(1); }
}
