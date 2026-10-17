// Рабочий процесс для теста гонки: отдельный процесс, своё соединение с файловой базой.
// Аргументы: путь_к_базе, момент_старта_мс, ownerId, затем пары lessonId:studentId. Печатает по строке на пару.
import { DatabaseSync } from 'node:sqlite';
import { enroll, Denied, ScheduleError } from '../src/access.ts';

const [path, startAt, ownerId, ...jobs] = process.argv.slice(2);
const db = new DatabaseSync(path);
db.exec('PRAGMA busy_timeout = 20000');
while (Date.now() < Number(startAt)) { /* ждём общий старт, чтобы процессы столкнулись */ }
for (const j of jobs) {
  const [lesson, student] = j.split(':').map(Number);
  let res = 'ok';
  try { enroll(db, { id: Number(ownerId), role: 'owner' }, lesson, student); }
  catch (e) { res = e instanceof ScheduleError ? 'refused' : e instanceof Denied ? 'denied' : 'error:' + (e as Error).message; }
  console.log(`${j} ${res}`);
}
