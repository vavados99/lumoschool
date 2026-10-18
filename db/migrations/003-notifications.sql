-- Ф18: уведомления родителю о репликах преподавателя его ребёнку. Текста сообщения здесь нет — только факт, ветка/урок и время.
CREATE TABLE parent_notifications (
  id         INTEGER PRIMARY KEY,
  parent_id  INTEGER NOT NULL REFERENCES users(id),
  child_id   INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL CHECK (kind IN ('thread_message','room_message')),
  ref_id     INTEGER NOT NULL,          -- id ветки (thread_message) или урока (room_message)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at    TEXT
);
CREATE INDEX parent_notifications_idx ON parent_notifications(parent_id, id);
INSERT INTO role_permissions(role, permission) VALUES ('parent','notifications.read');
