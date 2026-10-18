// Ф13: переводы. Каталоги — i18n/<язык>.json (плоские ключи 'раздел.имя').
// Значение — строка с {плейсхолдерами} либо объект форм множественного числа { one, few, many, other }.
// Единственный источник правды о языках — LANGS; запасной язык — FALLBACK.
import { readFileSync } from 'node:fs';

export const LANGS = ['uk', 'pl', 'en', 'de', 'cs', 'ru'] as const;
export type Lang = (typeof LANGS)[number];
export const FALLBACK: Lang = 'en';
export const DEFAULT_LANG: Lang = 'uk';   // язык платформы по умолчанию, если ничего не указано

export type Entry = string | Record<string, string>;
export type Catalog = Record<string, Entry>;
export type Params = Record<string, string | number>;

function load(lang: Lang): Catalog {
  return JSON.parse(readFileSync(new URL(`../i18n/${lang}.json`, import.meta.url), 'utf8')) as Catalog;
}
const catalogs = Object.fromEntries(LANGS.map(l => [l, load(l)])) as Record<Lang, Catalog>;

export const catalog = (lang: Lang): Catalog => catalogs[lang];
export const isLang = (x: unknown): x is Lang => typeof x === 'string' && (LANGS as readonly string[]).includes(x);

/** Формы множественного числа, которые язык требует по CLDR (через Intl). */
export const pluralCategories = (lang: Lang): string[] => new Intl.PluralRules(lang).resolvedOptions().pluralCategories;

export const hasKey = (key: string, lang: Lang = FALLBACK): boolean => Object.hasOwn(catalogs[lang], key);

export const PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

function pick(entry: Entry, lang: Lang, params: Params): string | undefined {
  if (typeof entry === 'string') return entry;
  const n = Number(params.count);
  if (!Number.isFinite(n)) return undefined;   // форму без {count} выбрать нельзя
  const cat = new Intl.PluralRules(lang).select(n);
  return entry[cat] ?? entry.other;
}

/** Перевод: запрошенный язык → запасной (en) → сам ключ (чтобы пропажа была видна, а не пустота). */
export function t(lang: string, key: string, params: Params = {}): string {
  const l: Lang = isLang(lang) ? lang : FALLBACK;
  for (const code of l === FALLBACK ? [l] : [l, FALLBACK]) {
    const c = catalogs[code];
    if (!Object.hasOwn(c, key)) continue;
    const s = pick(c[key], code, params);
    if (s !== undefined) return s.replace(PLACEHOLDER_RE, (m, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : m));
  }
  return key;
}

/** Язык из Accept-Language (с q-весами, 'pl-PL' → pl); null, если ни один поддерживаемый не назван ('*' не считается). */
export function fromAcceptLanguage(h: string | null | undefined): Lang | null {
  const base = (x: string) => x.trim().toLowerCase().split(/[-_]/)[0];
  const items = String(h ?? '').split(',').map((p, i) => {
    const [tag, ...rest] = p.split(';');
    const q = rest.map(r => r.trim()).find(r => r.startsWith('q='));
    const w = q ? Number(q.slice(2)) : 1;
    return { b: base(tag), w: Number.isFinite(w) ? w : 0, i };
  }).filter(x => x.w > 0 && isLang(x.b)).sort((a, b) => b.w - a.w || a.i - b.i);
  return items.length ? (items[0].b as Lang) : null;
}

/** Выбор языка: явный ?lang= → настройка пользователя → Accept-Language → DEFAULT_LANG. */
export function pickLang(opts: { query?: string | null; user?: string | null; acceptLanguage?: string | null } = {}): Lang {
  const base = (x: string) => x.trim().toLowerCase().split(/[-_]/)[0];
  for (const c of [opts.query, opts.user]) if (c && isLang(base(c))) return base(c) as Lang;
  return fromAcceptLanguage(opts.acceptLanguage) ?? DEFAULT_LANG;
}
