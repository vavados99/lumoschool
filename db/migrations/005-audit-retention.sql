-- Ф25: срок хранения журнала действий и обезличивание ссылок на человека, ушедшего по просьбе.
-- Журнал по-прежнему «только дописывается»: меняется лишь то, что нужно по закону о данных.
--  * UPDATE разрешён ТОЛЬКО для actor_id / target_id и ТОЛЬКО на значение 0 («обезличено»); время, действие, тип, итог менять нельзя;
--  * DELETE разрешён ТОЛЬКО пока «ворота» открыты (их открывает на время своей транзакции чистка по сроку, consent.ts: runRetention).
--    Обычный DELETE без ворот по-прежнему падает. Это защита от случайного/ошибочного удаления, а не от человека с правом записи в файл базы.
CREATE TABLE audit_purge_gate (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  open INTEGER NOT NULL DEFAULT 0 CHECK (open IN (0,1))
);
INSERT INTO audit_purge_gate(id, open) VALUES (1, 0);

DROP TRIGGER audit_no_update;
DROP TRIGGER audit_no_delete;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
WHEN NOT (NEW.id = OLD.id AND NEW.ts = OLD.ts AND NEW.action = OLD.action AND NEW.target_type IS OLD.target_type AND NEW.outcome = OLD.outcome
          AND (NEW.actor_id IS OLD.actor_id OR NEW.actor_id = 0) AND (NEW.target_id IS OLD.target_id OR NEW.target_id = 0))
BEGIN SELECT RAISE(ABORT,'audit_log append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
WHEN (SELECT open FROM audit_purge_gate WHERE id = 1) IS NOT 1
BEGIN SELECT RAISE(ABORT,'audit_log append-only'); END;
