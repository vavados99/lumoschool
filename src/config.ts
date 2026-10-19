// Ф12: вся конфигурация — из переменных окружения, с проверкой формата. Секреты в коде и репозитории не лежат.
// Режим LUMO_MODE: prod | dev | test. Не задан — считается prod (отказ по умолчанию: забыли настроить → сервер не стартует).
// Сообщения об ошибках называют ИМЯ переменной и правило, но никогда не содержат значения.
import { randomBytes } from 'node:crypto';

export type Mode = 'prod' | 'dev' | 'test';
export type Config = {
  readonly mode: Mode;
  readonly port: number;
  readonly databasePath: string;
  readonly backupDir: string | null;
  readonly backupKeep: number;
  readonly cookieSecure: boolean;
  readonly trustedProxies: readonly string[];       // Ф17: TRUSTED_PROXY — адреса прокси через запятую; пусто = X-Forwarded-For не читаем
  readonly messageRetentionDays: number | null;      // null → значение по умолчанию из consent.ts
  readonly loginAttemptRetentionDays: number | null;
  readonly schedulerEnabled: boolean;                // Ф19c: SCHEDULER=off выключает встроенный планировщик (по умолчанию включён)
  readonly outboxIntervalMs: number;                 // SCHEDULER_OUTBOX_MS
  readonly backupIntervalMs: number;                 // SCHEDULER_BACKUP_MS
  readonly cleanupIntervalMs: number;                // SCHEDULER_CLEANUP_MS
  readonly shutdownTimeoutMs: number;                // Ф21: SHUTDOWN_TIMEOUT_MS — сколько ждать запросы в полёте при остановке
  readonly sessionSecret: string;                    // не перечисляется, в JSON/логах скрыт
};

export class ConfigError extends Error {
  constructor(msg: string) { super(msg); this.name = 'ConfigError'; }
}

export const MIN_SECRET_LENGTH = 32;
const WEAK_WORDS = ['changeme', 'change-me', 'secret', 'test', 'password', 'passwd', 'example', 'default', 'qwerty', '123456', 'letmein', 'todo', 'placeholder', 'insert', 'your-', 'xxxx'];

/** Причина слабости (текст без значения) или null, если секрет приемлем. */
export function weakSecretReason(v: string): string | null {
  if (v.length < MIN_SECRET_LENGTH) return `shorter than ${MIN_SECRET_LENGTH} characters`;
  const low = v.toLowerCase();
  if (WEAK_WORDS.some(w => low.includes(w))) return 'contains a placeholder or well-known weak word';
  if (new Set(v).size < 8) return 'too few distinct characters (repeating pattern)';
  if (/\s/.test(v)) return 'contains whitespace';
  return null;
}

type Env = Record<string, string | undefined>;
const get = (env: Env, k: string): string | undefined => { const v = env[k]; return v === undefined || v === '' ? undefined : v; };

function intVar(env: Env, k: string, min: number, max: number, def: number | null): number | null {
  const v = get(env, k);
  if (v === undefined) return def;
  if (!/^\d{1,9}$/.test(v) || Number(v) < min || Number(v) > max) throw new ConfigError(`${k} must be an integer from ${min} to ${max}`);
  return Number(v);
}

export type LoadOptions = { secret?: boolean };   // secret:false — для CLI без сессий (backup/restore/maintenance)

/** Читает и проверяет конфигурацию. Бросает ConfigError; значения секретов в сообщения не попадают. */
export function loadConfig(env: Env = process.env, opts: LoadOptions = {}): Config {
  const rawMode = get(env, 'LUMO_MODE') ?? 'prod';
  if (rawMode !== 'prod' && rawMode !== 'dev' && rawMode !== 'test') throw new ConfigError('LUMO_MODE must be one of: prod, dev, test');
  const mode: Mode = rawMode;

  const port = intVar(env, 'PORT', 1, 65535, 8787)!;
  const databasePath = get(env, 'DATABASE_PATH') ?? (mode === 'prod' ? '' : ':memory:');
  if (!databasePath) throw new ConfigError('DATABASE_PATH is required in prod mode');
  if (mode === 'prod' && databasePath === ':memory:') throw new ConfigError('DATABASE_PATH must be a file in prod mode');
  if (databasePath.includes('\0')) throw new ConfigError('DATABASE_PATH has invalid characters');
  const backupDir = get(env, 'BACKUP_DIR') ?? null;
  if (backupDir?.includes('\0')) throw new ConfigError('BACKUP_DIR has invalid characters');
  const backupKeep = intVar(env, 'BACKUP_KEEP', 1, 3650, 14)!;
  const cs = get(env, 'COOKIE_SECURE');
  if (cs !== undefined && cs !== '0' && cs !== '1') throw new ConfigError('COOKIE_SECURE must be 0 or 1');
  const cookieSecure = cs === '1';
  if (mode === 'prod' && opts.secret !== false && !cookieSecure) throw new ConfigError('COOKIE_SECURE=1 is required in prod mode (HTTPS behind proxy)');
  const trustedProxies = (get(env, 'TRUSTED_PROXY') ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (trustedProxies.some(x => !/^[0-9a-fA-F:.]{2,45}$/.test(x) || x === '*')) throw new ConfigError('TRUSTED_PROXY must be a comma-separated list of IP addresses');
  const messageRetentionDays = intVar(env, 'RETENTION_MESSAGE_DAYS', 0, 36500, null);
  const loginAttemptRetentionDays = intVar(env, 'RETENTION_LOGIN_ATTEMPT_DAYS', 0, 36500, null);

  const sch = get(env, 'SCHEDULER');
  if (sch !== undefined && sch !== 'on' && sch !== 'off') throw new ConfigError('SCHEDULER must be on or off');
  // интервалы: целое число миллисекунд; значения ниже нижней границы поднимает сам планировщик (scheduler.ts, MIN_INTERVAL_MS)
  const outboxIntervalMs = intVar(env, 'SCHEDULER_OUTBOX_MS', 1, 604_800_000, 60_000)!;
  const backupIntervalMs = intVar(env, 'SCHEDULER_BACKUP_MS', 1, 604_800_000, 86_400_000)!;
  const cleanupIntervalMs = intVar(env, 'SCHEDULER_CLEANUP_MS', 1, 604_800_000, 3_600_000)!;

  const shutdownTimeoutMs = intVar(env, 'SHUTDOWN_TIMEOUT_MS', 100, 600_000, 10_000)!;

  let sessionSecret = '';
  if (opts.secret !== false) {
    const s = get(env, 'SESSION_SECRET');
    if (s === undefined) {
      if (mode === 'prod') throw new ConfigError('SESSION_SECRET is required in prod mode');
      sessionSecret = randomBytes(32).toString('hex');   // dev/test: свой на каждый запуск процесса
    } else {
      const why = weakSecretReason(s);
      if (why && mode === 'prod') throw new ConfigError(`SESSION_SECRET is too weak: ${why}`);
      sessionSecret = s;
    }
  }

  const cfg = { mode, port, databasePath, backupDir, backupKeep, cookieSecure, trustedProxies, messageRetentionDays, loginAttemptRetentionDays, schedulerEnabled: sch !== 'off', outboxIntervalMs, backupIntervalMs, cleanupIntervalMs, shutdownTimeoutMs } as Config;
  // секрет — не перечисляемое поле: не попадёт в JSON.stringify, console.log, Object.keys
  Object.defineProperty(cfg, 'sessionSecret', { value: sessionSecret, enumerable: false });
  Object.defineProperty(cfg, 'toString', { value: () => `[Config mode=${mode}]`, enumerable: false });
  return Object.freeze(cfg);
}

/** Демо-данные (известные пароли) — только вне prod. Режим не задан = prod. */
export function assertSeedAllowed(env: Env = process.env): void {
  const m = get(env, 'LUMO_MODE') ?? 'prod';
  if (m !== 'dev' && m !== 'test') throw new ConfigError('seed refuses to run in prod mode (demo users have well-known passwords); set LUMO_MODE=dev for a local demo');
}
