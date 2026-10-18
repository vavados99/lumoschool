// Сид ВЫДУМАННЫХ данных для локального каркаса. Ни одного реального имени, почты или телефона.
// Запуск: DATABASE_PATH=/путь/к/demo.sqlite node src/seed.ts   (в ':memory:' сидить бессмысленно — запрещено)
import type { DatabaseSync } from 'node:sqlite';
import { register } from './auth.ts';
import { openDb } from './db.ts';
import { assertSeedAllowed, ConfigError } from './config.ts';

export type DemoUser = { id: number; login: string; password: string; email: string; phone: string; display_name: string };
export type Demo = { users: Record<string, DemoUser>; lessons: Record<string, number>; surnames: string[] };

/** Выдуманные фамилии родителей (в базе их нет вообще — только имя; список нужен тестам утечек). */
export const DEMO_SURNAMES = ['Nobodyson', 'Testerova', 'Fakeman'];

export function seedDemo(db: DatabaseSync, now = Date.now()): Demo {
  assertSeedAllowed(process.env.LUMO_MODE === undefined ? { LUMO_MODE: 'test' } : process.env);   // явный prod — отказ
  const users: Record<string, DemoUser> = {};
  let n = 0;
  const mk = (key: string, role: string, name: string, birth: string | null): DemoUser => {
    n++;
    const nn = String(n).padStart(3, '0');
    const id = Number(db.prepare('INSERT INTO users(role, display_name, birth_date) VALUES (?,?,?)').run(role, name, birth).lastInsertRowid);
    const email = `${key.toLowerCase()}@example.test`;
    const phone = `+00 000 000 ${nn}`;
    db.prepare('INSERT INTO contact_vault(user_id, email, phone) VALUES (?,?,?)').run(id, email, phone);
    if (role === 'student') db.prepare('INSERT INTO students(user_id, level) VALUES (?,?)').run(id, 'A2');
    if (role === 'teacher') db.prepare('INSERT INTO teachers(user_id, bio) VALUES (?,?)').run(id, 'demo');
    const u = { id, login: key.toLowerCase(), password: `demo-password-${nn}`, email, phone, display_name: name };
    register(db, id, u.login, u.password);
    return users[key] = u;
  };
  const year = new Date(now).getUTCFullYear();
  mk('Owner', 'owner', 'Olga', null);
  mk('TeacherA', 'teacher', 'Tina', null);
  mk('TeacherB', 'teacher', 'Tom', null);
  mk('ParentA', 'parent', 'Paula', '1985-01-01');
  mk('ParentB', 'parent', 'Pavel', '1984-02-02');
  mk('ParentC', 'parent', 'Petra', '1983-03-03');
  mk('KidA', 'student', 'Kai', `${year - 9}-05-01`);        // ребёнок
  mk('KidB', 'student', 'Kira', `${year - 12}-03-01`);      // ребёнок
  mk('TeenC', 'student', 'Tess', `${year - 15}-07-01`);     // подросток
  mk('AdultD', 'student', 'Dan', '1990-01-01');             // взрослый

  const link = db.prepare('INSERT INTO parent_child(parent_id, child_id) VALUES (?,?)');
  link.run(users.ParentA.id, users.KidA.id); link.run(users.ParentB.id, users.KidB.id); link.run(users.ParentC.id, users.TeenC.id);
  const cs = db.prepare('INSERT INTO parental_consents(child_id, parent_id, granted_at) VALUES (?,?,?)');
  for (const [c, p] of [['KidA', 'ParentA'], ['KidB', 'ParentB'], ['TeenC', 'ParentC']]) cs.run(users[c].id, users[p].id, new Date(now).toISOString());

  const day = 86_400_000;
  const lesson = (t: string, d: number, audience: string) => Number(db.prepare('INSERT INTO lessons(teacher_id, starts_at, audience, max_students) VALUES (?,?,?,?)')
    .run(users[t].id, new Date(now + d * day).toISOString(), audience, audience === 'adult' ? 8 : 6).lastInsertRowid);
  const lessons = {
    a1: lesson('TeacherA', 3, 'minor'), a2: lesson('TeacherA', 5, 'minor'),
    b1: lesson('TeacherB', 4, 'minor'), b2: lesson('TeacherB', 6, 'adult'),
  };
  const en = db.prepare('INSERT INTO lesson_enrollments(lesson_id, student_id) VALUES (?,?)');
  en.run(lessons.a1, users.KidA.id); en.run(lessons.a1, users.KidB.id);
  en.run(lessons.a2, users.KidA.id);
  en.run(lessons.b1, users.TeenC.id); en.run(lessons.b1, users.KidB.id);
  en.run(lessons.b2, users.AdultD.id);

  // одна ветка: преподаватель A — Kai, с репликами преподавателя и родителя
  const th = Number(db.prepare('INSERT INTO msg_threads(teacher_id, student_id, created_by) VALUES (?,?,?)').run(users.TeacherA.id, users.KidA.id, users.TeacherA.id).lastInsertRowid);
  const post = db.prepare('INSERT INTO msg_posts(thread_id, from_id, body) VALUES (?,?,?)');
  post.run(th, users.TeacherA.id, 'Hello! Please bring your notebook to the next lesson.');
  post.run(th, users.ParentA.id, 'Thank you, we will.');
  return { users, lessons: { ...lessons, thread: th }, surnames: DEMO_SURNAMES };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try { assertSeedAllowed(); } catch (e) { console.error(`seed refused: ${(e as ConfigError).message}`); process.exit(1); }
  const path = process.env.DATABASE_PATH;
  if (!path || path === ':memory:') { console.error('Set DATABASE_PATH to a file (demo only, fictional data).'); process.exit(1); }
  const db = openDb(path);
  if ((db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c > 0) { console.error('Database is not empty: refusing to seed.'); process.exit(1); }
  const d = seedDemo(db);
  console.log('Seeded FICTIONAL demo data. Logins (password in brackets):');
  for (const u of Object.values(d.users)) console.log(`  ${u.login} [${u.password}]`);
}
