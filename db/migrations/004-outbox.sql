-- Ф19b: очередь доставки уведомлений родителю. Адресов/телефонов/текста сообщений здесь нет:
-- получатель = id родителя (контакт берёт реальный отправитель из сейфа в момент отправки), язык и вид берутся из уведомления.
ALTER TABLE users ADD COLUMN lang TEXT;   -- предпочитаемый язык (uk/pl/en/de/cs/ru); NULL = язык по умолчанию
CREATE TABLE notification_outbox (
  id              INTEGER PRIMARY KEY,
  notification_id INTEGER NOT NULL UNIQUE REFERENCES parent_notifications(id) ON DELETE CASCADE,   -- одна доставка на уведомление
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','dead')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,      -- мс от эпохи; pending/failed берутся в работу, когда now >= этого значения
  last_error      TEXT,                            -- только короткий код (имя ошибки), без текста исключения
  sent_at         TEXT
);
CREATE INDEX notification_outbox_due_idx ON notification_outbox(status, next_attempt_at);
