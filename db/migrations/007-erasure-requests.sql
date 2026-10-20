-- Ф28: канал приёма просьб об удалении данных. ТОЛЬКО id, роли-пути, статус и время — ни имён, ни контактов, ни свободного текста.
--  * note — не текст человека, а код из закрытого списка (исключает попадание персональных данных в заметку);
--  * одна открытая заявка на человека (частичный уникальный индекс) — повтор не плодит дубли;
--  * 'done' без проверки личности (identity_checked = 1) база не принимает вообще (триггер) — третья линия после HTTP и ядра.
CREATE TABLE erasure_requests (
  id               INTEGER PRIMARY KEY,
  subject_id       INTEGER NOT NULL REFERENCES users(id),   -- чьи данные стираем
  requested_by     INTEGER NOT NULL REFERENCES users(id),   -- кто подал (сам человек или родитель)
  via              TEXT NOT NULL CHECK (via IN ('self','parent','owner')),
  status           TEXT NOT NULL CHECK (status IN ('pending_parent','pending_owner','done','rejected')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at       TEXT,
  decided_by       INTEGER REFERENCES users(id),
  identity_checked INTEGER NOT NULL DEFAULT 0 CHECK (identity_checked IN (0,1)),
  note             TEXT CHECK (note IS NULL OR note IN ('identity_failed','duplicate','not_entitled','other'))
);
CREATE UNIQUE INDEX erasure_requests_open_idx ON erasure_requests(subject_id) WHERE status IN ('pending_parent','pending_owner');
CREATE INDEX erasure_requests_by_idx ON erasure_requests(requested_by, id);
CREATE TRIGGER erasure_done_needs_identity BEFORE UPDATE ON erasure_requests
WHEN NEW.status = 'done' AND NEW.identity_checked IS NOT 1
BEGIN SELECT RAISE(ABORT,'erasure done requires identity_checked'); END;

INSERT INTO role_permissions(role, permission) VALUES
  ('student','erasure.request'), ('parent','erasure.request'),
  ('student','erasure.read_own'), ('parent','erasure.read_own'),
  ('parent','erasure.confirm'),
  ('owner','erasure.read_all'), ('owner','erasure.decide');

-- уведомление родителю о заявке ребёнка идёт через ту же очередь outbox: расширяем CHECK вида уведомления (kind).
-- SQLite не умеет менять CHECK на месте → пересоздаём обе таблицы (outbox ссылается на parent_notifications), данные переносим как есть.
CREATE TABLE _pn_old AS SELECT * FROM parent_notifications;
CREATE TABLE _ob_old AS SELECT * FROM notification_outbox;
DROP TABLE notification_outbox;
DROP TABLE parent_notifications;
CREATE TABLE parent_notifications (
  id         INTEGER PRIMARY KEY,
  parent_id  INTEGER NOT NULL REFERENCES users(id),
  child_id   INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL CHECK (kind IN ('thread_message','room_message','erasure_request')),
  ref_id     INTEGER NOT NULL,          -- id ветки (thread_message), урока (room_message) или заявки (erasure_request)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at    TEXT
);
CREATE INDEX parent_notifications_idx ON parent_notifications(parent_id, id);
CREATE TABLE notification_outbox (
  id              INTEGER PRIMARY KEY,
  notification_id INTEGER NOT NULL UNIQUE REFERENCES parent_notifications(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','dead')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  sent_at         TEXT
);
CREATE INDEX notification_outbox_due_idx ON notification_outbox(status, next_attempt_at);
INSERT INTO parent_notifications(id, parent_id, child_id, kind, ref_id, created_at, read_at) SELECT id, parent_id, child_id, kind, ref_id, created_at, read_at FROM _pn_old;
INSERT INTO notification_outbox(id, notification_id, status, attempts, next_attempt_at, last_error, sent_at) SELECT id, notification_id, status, attempts, next_attempt_at, last_error, sent_at FROM _ob_old;
DROP TABLE _pn_old;
DROP TABLE _ob_old;
