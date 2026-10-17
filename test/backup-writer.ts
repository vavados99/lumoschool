// Писатель для теста бэкапа: пока его не убьют, в цикле пишет в одной транзакции ПАРУ строк в settings
// и обновляет ВСЕ строки большой таблицы ledger одной версией. Целостный снимок видит либо старую версию целиком, либо новую.
import { openDb } from '../src/db.ts';
const db = openDb(process.env.DATABASE_PATH!);
db.exec('CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY, ver INTEGER NOT NULL, pad BLOB NOT NULL)');
db.exec('BEGIN');
const ins = db.prepare('INSERT INTO ledger(ver, pad) VALUES (0, zeroblob(1500))');
for (let k = 0; k < 12000; k++) ins.run();
db.exec('COMMIT');
let i = 0;
console.log('ready');
for (;;) {
  i++;
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?)').run(`w${i}a`, 'x'.repeat(200));
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?)').run(`w${i}b`, 'x'.repeat(200));
  db.prepare('UPDATE ledger SET ver = ?, pad = zeroblob(1500 + ?)').run(i, i % 7);
  db.exec('COMMIT');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);   // пауза: настоящий сервер пишет не в плотном цикле
}
