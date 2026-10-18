// Ф13: сторож переводов. Падает, если каталоги разошлись, есть пустоты/заглушки, не хватает форм множественного числа
// или код в src/ просит ключ, которого нет.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { LANGS, FALLBACK, DEFAULT_LANG, PLACEHOLDER_RE, catalog, hasKey, isLang, pickLang, pluralCategories, t, type Entry } from '../src/i18n.ts';
import { createApp } from '../src/server.ts';
import { seed } from './seed.ts';

const keysOf = (l: (typeof LANGS)[number]) => Object.keys(catalog(l)).sort();
const forms = (e: Entry): string[] => (typeof e === 'string' ? [e] : Object.values(e));
const phs = (e: Entry) => [...new Set(forms(e).flatMap(s => [...s.matchAll(PLACEHOLDER_RE)].map(m => m[1])))].sort();

test('список языков: ровно 6, без повторов, запасной входит в список', () => {
  assert.deepEqual([...LANGS].sort(), ['cs', 'de', 'en', 'pl', 'ru', 'uk']);
  assert.ok(isLang(FALLBACK) && isLang(DEFAULT_LANG));
  assert.deepEqual(readdirSync(new URL('../i18n', import.meta.url)).sort(), LANGS.map(l => `${l}.json`).sort(), 'файл каталога ↔ язык один к одному');
});

test('во всех каталогах одинаковый набор ключей; в каждом не меньше 25', () => {
  const ref = keysOf(FALLBACK);
  assert.ok(ref.length >= 25, `ключей ${ref.length}`);
  for (const l of LANGS) {
    const k = keysOf(l);
    assert.deepEqual(ref.filter(x => !k.includes(x)), [], `${l}: пропали ключи`);
    assert.deepEqual(k.filter(x => !ref.includes(x)), [], `${l}: лишние ключи`);
  }
});

test('нет пустых строк и подозрительных заглушек', () => {
  const bad = /\b(TODO|FIXME|XXX|lorem|ipsum|TBD)\b|^\s*$|\?\?\?/i;
  for (const l of LANGS) for (const [k, e] of Object.entries(catalog(l))) {
    assert.ok(typeof e === 'string' || (e && typeof e === 'object'), `${l}.${k}: тип`);
    for (const s of forms(e)) {
      assert.equal(typeof s, 'string', `${l}.${k}: не строка`);
      assert.ok(!bad.test(s), `${l}.${k}: пусто или заглушка: «${s}»`);
    }
  }
});

test('набор плейсхолдеров {name} один и тот же во всех языках для ключа', () => {
  for (const [k, e] of Object.entries(catalog(FALLBACK))) for (const l of LANGS) {
    assert.deepEqual(phs(catalog(l)[k]), phs(e), `${l}.${k}: плейсхолдеры расходятся с ${FALLBACK}`);
  }
});

test('множественные числа: заданы все формы, которые требует язык, и нет посторонних', () => {
  const plural = Object.keys(catalog(FALLBACK)).filter(k => typeof catalog(FALLBACK)[k] !== 'string');
  assert.ok(plural.length >= 2);
  for (const l of LANGS) {
    const need = pluralCategories(l).sort();
    for (const k of plural) {
      const e = catalog(l)[k];
      assert.equal(typeof e, 'object', `${l}.${k}: должен быть объектом форм`);
      assert.deepEqual(Object.keys(e).sort(), need, `${l}.${k}: формы должны быть ${need.join(',')}`);
      assert.ok(phs(e).includes('count'), `${l}.${k}: нужен {count}`);
    }
  }
});

test('t(): подстановка, множественные формы по правилам языка, запасной язык', () => {
  assert.equal(t('de', 'greeting.hello', { name: 'Łukasz' }), 'Hallo, Łukasz!');
  const n = (l: string, c: number) => t(l, 'lesson.count', { count: c });
  assert.deepEqual([1, 2, 5, 22, 25, 11, 21].map(c => n('uk', c)), ['1 урок', '2 уроки', '5 уроків', '22 уроки', '25 уроків', '11 уроків', '21 урок']);
  assert.deepEqual([1, 2, 5, 22, 12, 112].map(c => n('pl', c)), ['1 lekcja', '2 lekcje', '5 lekcji', '22 lekcje', '12 lekcji', '112 lekcji']);
  assert.deepEqual([1, 3, 5].map(c => n('cs', c)), ['1 lekce', '3 lekce', '5 lekcí']);
  assert.deepEqual([1, 2, 5, 21].map(c => n('ru', c)), ['1 урок', '2 урока', '5 уроков', '21 урок']);
  assert.deepEqual([1, 2].map(c => n('en', c)), ['1 lesson', '2 lessons']);
  assert.equal(t('pl', 'role.teacher'), 'Nauczyciel');
  // неизвестный язык → en; неизвестный ключ → сам ключ; неподставленный плейсхолдер остаётся видимым
  assert.equal(t('xx', 'role.owner'), 'Owner');
  assert.equal(t('uk', 'no.such.key'), 'no.such.key');
  assert.equal(t('en', 'greeting.hello'), 'Hello, {name}!');
  assert.equal(t('en', 'greeting.hello', { name: '{x}' }), 'Hello, {x}!');
  assert.ok(!hasKey('no.such.key'));
});

test('диакритика на месте: каждый язык содержит свои буквы', () => {
  const all = (l: (typeof LANGS)[number]) => JSON.stringify(catalog(l));
  assert.match(all('pl'), /ą/); assert.match(all('pl'), /ł/); assert.match(all('pl'), /ś/); assert.match(all('pl'), /ż/); assert.match(all('pl'), /ó/);
  assert.match(all('de'), /ü/); assert.match(all('de'), /ß/); assert.match(all('de'), /ä/);
  assert.match(all('cs'), /č/); assert.match(all('cs'), /ř/); assert.match(all('cs'), /ě/); assert.match(all('cs'), /š/); assert.match(all('cs'), /ž/); assert.match(all('cs'), /ů/);
  assert.match(all('uk'), /є/); assert.match(all('uk'), /ї/); assert.match(all('uk'), /і/);
  assert.doesNotMatch(all('uk'), /[ыэъё]/, 'в украинском нет ы э ъ ё');
});

test('выбор языка: ?lang → настройка пользователя → Accept-Language (q) → по умолчанию', () => {
  assert.equal(pickLang({ query: 'pl', user: 'de', acceptLanguage: 'cs' }), 'pl');
  assert.equal(pickLang({ query: 'zz', user: 'de', acceptLanguage: 'cs' }), 'de');
  assert.equal(pickLang({ user: 'xx', acceptLanguage: 'fr;q=0.9, cs-CZ;q=0.8, en;q=0.5' }), 'cs');
  assert.equal(pickLang({ acceptLanguage: 'en;q=0.3, de;q=0.7' }), 'de');
  assert.equal(pickLang({ acceptLanguage: 'de;q=0, ru' }), 'ru');
  assert.equal(pickLang({ acceptLanguage: 'fr, ja' }), DEFAULT_LANG);
  assert.equal(pickLang({ acceptLanguage: 'uk_UA' }), 'uk');
  assert.equal(pickLang({}), DEFAULT_LANG);
});

test('код в src/ использует только существующие ключи (статический поиск t(…, \'ключ\'))', () => {
  const dir = new URL('../src/', import.meta.url);
  const used: { file: string; key: string }[] = [];
  for (const f of readdirSync(dir).filter(x => x.endsWith('.ts'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/(?<![\w.$])t\(\s*[^,()'"`]+,\s*(['"])([^'"]+)\1/g)) used.push({ file: f, key: m[2] });
  }
  for (const u of used) for (const l of LANGS) assert.ok(Object.hasOwn(catalog(l), u.key), `${u.file}: ключа «${u.key}» нет в ${l}`);
});

test('сервер: ошибка получает message_localized по ?lang / Accept-Language; код, статус и прежние поля не тронуты', async () => {
  const { db } = seed();
  const srv = createApp(db);
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const get = async (path: string, headers: Record<string, string> = {}) => {
      const r = await fetch(base + path, { headers });
      return { status: r.status, body: await r.json() as Record<string, unknown> };
    };
    const a = await get('/api/me', { 'Accept-Language': 'pl-PL,pl;q=0.9' });
    assert.equal(a.status, 401);
    assert.equal(a.body.error, 'unauthorized');
    assert.equal(a.body.message_localized, 'Zaloguj się.');
    assert.equal(a.body.lang, 'pl');
    const b = await get('/api/me?lang=de', { 'Accept-Language': 'pl' });
    assert.equal(b.body.message_localized, 'Bitte melde dich an.');
    const c = await get('/api/me', { 'Accept-Language': '*' });   // язык не назван → тело прежнее, без новых полей
    assert.deepEqual(c.body, { error: 'unauthorized' });
    const c2 = await get('/api/me?lang=xx');   // неизвестный язык → по умолчанию
    assert.equal(c2.body.lang, DEFAULT_LANG);
    assert.equal(c2.body.message_localized, 'Будь ласка, увійдіть.');
    const d = await get('/nope?lang=uk');
    assert.equal(d.status, 404);
    assert.equal(d.body.error, 'not_found');
    assert.equal(d.body.message_localized, 'Не знайдено.');
  } finally { srv.close(); srv.closeAllConnections(); }
});

