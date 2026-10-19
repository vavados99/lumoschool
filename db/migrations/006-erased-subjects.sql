-- Ф26: «надгробия» стёртых по просьбе людей. ТОЛЬКО id и время — ни имён, ни контактов, ни текстов.
-- Зачем: резервные копии стирание не затрагивает; при восстановлении из старой копии (restore.ts) эти люди
-- обезличиваются повторно. Строки только дописываются: ни править, ни удалять нельзя (иначе человек «вернётся»).
CREATE TABLE erased_subjects (
  user_id   INTEGER PRIMARY KEY,
  erased_at TEXT NOT NULL
);
CREATE TRIGGER erased_subjects_no_update BEFORE UPDATE ON erased_subjects
WHEN NOT (NEW.user_id = OLD.user_id AND NEW.erased_at = OLD.erased_at)
BEGIN SELECT RAISE(ABORT,'erased_subjects append-only'); END;
CREATE TRIGGER erased_subjects_no_delete BEFORE DELETE ON erased_subjects
BEGIN SELECT RAISE(ABORT,'erased_subjects append-only'); END;
