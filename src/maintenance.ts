// Ф11: ночная чистка для внешнего планировщика: срок хранения (runRetention, от имени владельца) + просроченные сессии и старые попытки входа.
// CLI:  DATABASE_PATH=/путь/lumo.sqlite node src/maintenance.ts   (запускать ПЕРЕД backup)
import { resolve } from 'node:path';
import { openDb } from './db.ts';
import { actorOf } from './access.ts';
import { runRetention } from './consent.ts';
import { purgeExpiredSessions, purgeOldAttempts } from './auth.ts';

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const path = process.env.DATABASE_PATH;
  if (!path || path === ':memory:') { console.error('Set DATABASE_PATH (file).'); process.exit(1); }
  const db = openDb(path);
  try {
    const owner = db.prepare(`SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1`).get() as { id: number } | undefined;
    if (!owner) throw new Error('no owner user');
    const now = Date.now();
    console.log('retention', JSON.stringify(runRetention(db, actorOf(db, owner.id), { now })));
    console.log('sessions purged', purgeExpiredSessions(db, now), 'attempts purged', purgeOldAttempts(db, now));
  } catch (e) { console.error(`maintenance FAILED: ${(e as Error).message}`); process.exit(1); } finally { db.close(); }
}
