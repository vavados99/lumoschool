-- Ф9: комната урока. Применяется миграцией (db.ts), на существующий файл — один раз.
ALTER TABLE lessons ADD COLUMN recording INTEGER NOT NULL DEFAULT 0 CHECK (recording IN (0,1));   -- записи ВЫКЛ по умолчанию
ALTER TABLE lessons ADD COLUMN recording_set_by INTEGER REFERENCES users(id);
ALTER TABLE lessons ADD COLUMN recording_set_at TEXT;

-- чат живёт в комнате урока, не в личных ветках; в журнал тексты не попадают
CREATE TABLE room_messages (
  id         INTEGER PRIMARY KEY,
  lesson_id  INTEGER NOT NULL REFERENCES lessons(id),
  from_id    INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX room_messages_idx ON room_messages(lesson_id, id);

-- кто сейчас в комнате (для правила «ребёнок не остаётся без взрослого»)
CREATE TABLE room_presence (
  lesson_id  INTEGER NOT NULL REFERENCES lessons(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  entered_at TEXT NOT NULL,
  left_at    TEXT,
  PRIMARY KEY (lesson_id, user_id)
);

INSERT INTO role_permissions(role, permission) VALUES
 ('student','room.enter'),('student','room.chat.read'),('student','room.chat.send'),('student','room.call_owner'),
 ('parent','room.enter'),('parent','room.chat.read'),('parent','room.call_owner'),
 ('teacher','room.enter'),('teacher','room.chat.read'),('teacher','room.chat.send'),('teacher','room.call_owner'),
 ('owner','room.enter'),('owner','room.chat.read'),('owner','room.chat.send'),('owner','room.call_owner'),
 ('owner','room.recording.set'),('owner','room.calls.read');
