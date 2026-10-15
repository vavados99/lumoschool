-- LUMOSCHOOL: схема доступов (Ф1). SQLite локально; для Postgres переносится 1:1.
-- Принцип: контактов (email, телефон) нет НИГДЕ, кроме contact_vault.
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id           INTEGER PRIMARY KEY,
  role         TEXT NOT NULL CHECK (role IN ('student','parent','teacher','owner')),
  display_name TEXT NOT NULL,          -- имя без фамилии
  birth_date   TEXT,                   -- ISO; для расчёта «до 16 лет»
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- СЕЙФ: единственное место для почты и телефона.
CREATE TABLE contact_vault (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email   TEXT,
  phone   TEXT
);

CREATE TABLE students (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  level   TEXT
);
CREATE TABLE teachers (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bio     TEXT
);

-- связь родитель — ребёнок
CREATE TABLE parent_child (
  parent_id INTEGER NOT NULL REFERENCES users(id),
  child_id  INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (parent_id, child_id)
);

-- согласие родителя (для детей до 16): без активной записи запись на урок запрещена
CREATE TABLE parental_consents (
  id         INTEGER PRIMARY KEY,
  child_id   INTEGER NOT NULL REFERENCES users(id),
  parent_id  INTEGER NOT NULL REFERENCES users(id),
  scope      TEXT NOT NULL DEFAULT 'data_processing',
  granted_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE lessons (
  id         INTEGER PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  starts_at  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'planned'
);
CREATE TABLE lesson_enrollments (
  lesson_id  INTEGER NOT NULL REFERENCES lessons(id),
  student_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (lesson_id, student_id)
);

-- «запрещено по умолчанию»: разрешено только то, что есть в этой таблице
CREATE TABLE role_permissions (
  role       TEXT NOT NULL,
  permission TEXT NOT NULL,
  PRIMARY KEY (role, permission)
);

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY,
  from_id    INTEGER NOT NULL REFERENCES users(id),
  to_id      INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- журнал действий: только дописывается; читает владелец
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  ts          TEXT NOT NULL DEFAULT (datetime('now')),
  actor_id    INTEGER,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   INTEGER,
  outcome     TEXT NOT NULL CHECK (outcome IN ('allowed','denied'))
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log append-only'); END;

-- матрица прав (план этапа 0, раздел 5)
INSERT INTO role_permissions(role, permission) VALUES
 ('student','own_profile.read'),('student','own_lessons.read'),('student','own_contacts.read'),
 ('parent','own_profile.read'),('parent','own_contacts.read'),('parent','child_profile.read'),('parent','child_lessons.read'),('parent','consent.grant'),('parent','child_lessons.enroll'),('parent','message.receive'),
 ('teacher','own_lessons.read'),('teacher','lesson_students.read'),('teacher','message.send'),
 ('owner','own_profile.read'),('owner','own_contacts.read'),('owner','contacts.read_any'),('owner','students.read_all'),('owner','audit.read'),('owner','lessons.enroll'),('owner','message.send');
