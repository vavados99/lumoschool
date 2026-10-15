// Выдуманные данные. Ничего реального.
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';

export function seed(): { db: DatabaseSync; ids: Record<string, number> } {
  const db = openDb(':memory:');
  const u = (role: string, name: string, birth: string | null, email: string, phone: string) => {
    const id = Number(db.prepare('INSERT INTO users(role, display_name, birth_date) VALUES (?,?,?)').run(role, name, birth).lastInsertRowid);
    db.prepare('INSERT INTO contact_vault(user_id, email, phone) VALUES (?,?,?)').run(id, email, phone);
    if (role === 'student') db.prepare('INSERT INTO students(user_id, level) VALUES (?,?)').run(id, 'A2');
    if (role === 'teacher') db.prepare('INSERT INTO teachers(user_id, bio) VALUES (?,?)').run(id, 'bio');
    return id;
  };
  const ids: Record<string, number> = {
    owner: u('owner', 'Owner', null, 'owner@example.invalid', '+000-owner'),
    teacherA: u('teacher', 'TeacherA', null, 'ta@example.invalid', '+000-ta'),
    teacherB: u('teacher', 'TeacherB', null, 'tb@example.invalid', '+000-tb'),
    kidA: u('student', 'KidA', '2015-05-01', 'kida@example.invalid', '+000-kida'),   // ребёнок, урок учителя A
    kidB: u('student', 'KidB', '2014-03-01', 'kidb@example.invalid', '+000-kidb'),   // ребёнок, урок учителя B
    adultC: u('student', 'AdultC', '1990-01-01', 'c@example.invalid', '+000-c'),     // взрослый, урок учителя B
    parentA: u('parent', 'ParentA', '1985-01-01', 'pa@example.invalid', '+000-pa'),
    parentB: u('parent', 'ParentB', '1985-02-02', 'pb@example.invalid', '+000-pb'),
  };
  const pc = db.prepare('INSERT INTO parent_child(parent_id, child_id) VALUES (?,?)');
  pc.run(ids.parentA, ids.kidA); pc.run(ids.parentB, ids.kidB);
  const lesson = (t: number) => Number(db.prepare(`INSERT INTO lessons(teacher_id, starts_at) VALUES (?, '2026-11-01T10:00')`).run(t).lastInsertRowid);
  ids.lessonA = lesson(ids.teacherA); ids.lessonB = lesson(ids.teacherB);
  const en = db.prepare('INSERT INTO lesson_enrollments(lesson_id, student_id) VALUES (?,?)');
  en.run(ids.lessonA, ids.kidA); en.run(ids.lessonB, ids.kidB); en.run(ids.lessonB, ids.adultC);
  const cs = db.prepare(`INSERT INTO parental_consents(child_id, parent_id, granted_at) VALUES (?,?,datetime('now'))`);
  cs.run(ids.kidA, ids.parentA); cs.run(ids.kidB, ids.parentB);
  return { db, ids };
}
