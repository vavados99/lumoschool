-- Ф29: родитель может отклонить заявку своего ребёнка (16–17 лет, pending_parent). Новый статус 'rejected_by_parent' — отдельно от
-- отказа владельца ('rejected'), чтобы в журнале и в списке было видно, кто закрыл. decided_by = id родителя. Данных человека не добавляется.
-- SQLite не меняет CHECK на месте → пересоздаём таблицу (на неё никто не ссылается), строки переносим как есть, индексы и триггер возвращаем.
CREATE TABLE _er_old AS SELECT * FROM erasure_requests;
DROP TABLE erasure_requests;
CREATE TABLE erasure_requests (
  id               INTEGER PRIMARY KEY,
  subject_id       INTEGER NOT NULL REFERENCES users(id),
  requested_by     INTEGER NOT NULL REFERENCES users(id),
  via              TEXT NOT NULL CHECK (via IN ('self','parent','owner')),
  status           TEXT NOT NULL CHECK (status IN ('pending_parent','pending_owner','done','rejected','rejected_by_parent')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at       TEXT,
  decided_by       INTEGER REFERENCES users(id),
  identity_checked INTEGER NOT NULL DEFAULT 0 CHECK (identity_checked IN (0,1)),
  note             TEXT CHECK (note IS NULL OR note IN ('identity_failed','duplicate','not_entitled','other'))
);
INSERT INTO erasure_requests(id, subject_id, requested_by, via, status, created_at, decided_at, decided_by, identity_checked, note)
  SELECT id, subject_id, requested_by, via, status, created_at, decided_at, decided_by, identity_checked, note FROM _er_old;
DROP TABLE _er_old;
CREATE UNIQUE INDEX erasure_requests_open_idx ON erasure_requests(subject_id) WHERE status IN ('pending_parent','pending_owner');
CREATE INDEX erasure_requests_by_idx ON erasure_requests(requested_by, id);
CREATE TRIGGER erasure_done_needs_identity BEFORE UPDATE ON erasure_requests
WHEN NEW.status = 'done' AND NEW.identity_checked IS NOT 1
BEGIN SELECT RAISE(ABORT,'erasure done requires identity_checked'); END;
-- закрытая заявка не оживает и не меняет исход (вторая линия после ядра)
CREATE TRIGGER erasure_closed_is_final BEFORE UPDATE ON erasure_requests
WHEN OLD.status IN ('done','rejected','rejected_by_parent')
BEGIN SELECT RAISE(ABORT,'erasure request already closed'); END;

INSERT INTO role_permissions(role, permission) VALUES ('parent','erasure.parent_reject');
