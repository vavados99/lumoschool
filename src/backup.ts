// Ф11: резервная копия базы. Копия делается средствами SQLite (VACUUM INTO) — целостный снимок, пока сервер пишет;
// простое копирование файла так делать нельзя (можно поймать половину транзакции).
// CLI:  DATABASE_PATH=/путь/lumo.sqlite BACKUP_DIR=/путь/backups [BACKUP_KEEP=14] node src/backup.ts
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const DEFAULT_KEEP = 14;
/** Имя копии нашего шаблона: lumo-backup-20261018T013005123Z.sqlite (UTC; сортировка по имени = по времени). */
export const BACKUP_NAME = /^lumo-backup-\d{8}T\d{9}Z\.sqlite$/;

export function backupName(now = Date.now()): string {
  return `lumo-backup-${new Date(now).toISOString().replace(/[-:.]/g, '')}.sqlite`;
}

export type BackupResult = { file: string; rotated: string[] };

/** Копия базы (открытая база или путь к файлу) в каталог dir; затем ротация: остаются keep последних. */
export function backupDb(src: DatabaseSync | string, dir: string, opts: { keep?: number; now?: number } = {}): BackupResult {
  const keep = opts.keep ?? DEFAULT_KEEP;
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be an integer >= 1');
  if (typeof src === 'string' && (src === ':memory:' || !existsSync(src))) throw new Error(`database file not found: ${src}`);
  const dirAbs = resolve(dir);
  mkdirSync(dirAbs, { recursive: true, mode: 0o700 });
  const name = backupName(opts.now);
  const final = join(dirAbs, name), tmp = join(dirAbs, `.${name}.partial`);
  if (existsSync(final)) throw new Error(`backup already exists: ${name}`);
  if (existsSync(tmp)) unlinkSync(tmp);

  const db = typeof src === 'string' ? new DatabaseSync(src, { readOnly: true }) : src;
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    writeFileSync(tmp, '', { mode: 0o600 });          // пустой файл с правами 0600 ДО записи данных
    chmodSync(tmp, 0o600);
    db.prepare('VACUUM INTO ?').run(tmp);
    chmodSync(tmp, 0o600);
    const chk = new DatabaseSync(tmp, { readOnly: true });
    try {
      const r = chk.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
      if (r.length !== 1 || r[0].integrity_check !== 'ok') throw new Error('backup failed integrity_check');
    } finally { chk.close(); }
    renameSync(tmp, final);                           // копия появляется под финальным именем только целой
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* нет файла */ }
    throw e;
  } finally { if (typeof src === 'string') db.close(); }

  return { file: final, rotated: rotate(dirAbs, keep) };
}

/** Удаляет старые копии. Трогает ТОЛЬКО обычные файлы (не ссылки) прямо в каталоге dir с именем по шаблону BACKUP_NAME. */
export function rotate(dir: string, keep: number): string[] {
  const names = readdirSync(dir).filter(n => BACKUP_NAME.test(n) && lstatSync(join(dir, n)).isFile()).sort();
  const old = names.slice(0, Math.max(0, names.length - keep));
  for (const n of old) unlinkSync(join(dir, n));
  return old.map(n => join(dir, n));
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const path = process.env.DATABASE_PATH, dir = process.env.BACKUP_DIR;
  if (!path || path === ':memory:' || !dir) { console.error('Set DATABASE_PATH (file) and BACKUP_DIR.'); process.exit(1); }
  try {
    const r = backupDb(path, dir, process.env.BACKUP_KEEP ? { keep: Number(process.env.BACKUP_KEEP) } : {});
    console.log(`backup ok: ${r.file}`);
    if (r.rotated.length) console.log(`rotated out: ${r.rotated.length}`);
  } catch (e) { console.error(`backup FAILED: ${(e as Error).message}`); process.exit(1); }
}
