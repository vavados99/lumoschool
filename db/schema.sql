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
  starts_at  TEXT NOT NULL,            -- ISO UTC (Ф3: createSlot нормализует в toISOString)
  status     TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','cancelled','done')),
  duration_min INTEGER NOT NULL DEFAULT 50 CHECK (duration_min BETWEEN 15 AND 180),  -- Ф3
  audience   TEXT NOT NULL DEFAULT 'minor' CHECK (audience IN ('minor','adult')),     -- Ф4: дети/подростки или взрослые
  max_students INTEGER NOT NULL DEFAULT 6 CHECK (max_students BETWEEN 1 AND 50),      -- Ф4: лимит группы (6 дети/подростки, 8 взрослые; константы в access.ts)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE lesson_enrollments (
  lesson_id  INTEGER NOT NULL REFERENCES lessons(id),
  student_id INTEGER NOT NULL REFERENCES users(id),
  booked_by  INTEGER REFERENCES users(id),                                   -- Ф3: кто записал
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT,
  PRIMARY KEY (lesson_id, student_id)
);
CREATE INDEX lessons_teacher_idx ON lessons(teacher_id, starts_at);

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
 ('student','own_profile.read'),('student','own_lessons.read'),('student','own_contacts.read'),('student','lessons.enroll'),('student','lessons.cancel'),
 ('parent','own_profile.read'),('parent','own_contacts.read'),('parent','child_profile.read'),('parent','child_lessons.read'),('parent','consent.grant'),('parent','child_lessons.enroll'),('parent','child_lessons.cancel'),('parent','message.receive'),
 ('teacher','own_lessons.read'),('teacher','slots.create'),('teacher','lesson_students.read'),('teacher','message.send'),
 ('owner','own_profile.read'),('owner','own_contacts.read'),('owner','contacts.read_any'),('owner','students.read_all'),('owner','audit.read'),('owner','lessons.enroll'),('owner','lessons.cancel'),('owner','lessons.read_all'),('owner','lessons.set_capacity'),('owner','message.send');

-- Ф2: вход. Отдельно от contact_vault. Пароль — только хеш со своей солью и параметрами в строке.
CREATE TABLE credentials (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  login         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);
-- сессии: токен НЕ хранится, только sha256-хеш; время — миллисекунды unix
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
-- попытки входа (для ограничения); ключ — введённый логин, существует он или нет
CREATE TABLE login_attempts (
  id    INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  ts    INTEGER NOT NULL,
  ok    INTEGER NOT NULL
);
CREATE INDEX login_attempts_idx ON login_attempts(login, ts);
