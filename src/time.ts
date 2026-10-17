// Часовые пояса (Ф4). В базе время уроков — всегда UTC (ISO, 'Z'). Показ — только через Intl, без библиотек.
import { toMs } from './access.ts';

export const ZONES = ['Europe/Warsaw', 'Europe/Kyiv'] as const;
export type Zone = (typeof ZONES)[number];
export type LocalTime = { zone: Zone; date: string; time: string; offsetMin: number; text: string };

const fmts = new Map<Zone, Intl.DateTimeFormat>();
function fmt(zone: Zone): Intl.DateTimeFormat {
  let f = fmts.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    fmts.set(zone, f);
  }
  return f;
}

/** Показ момента (ISO UTC) в зоне школы/ученика. Неизвестная зона или дата — ошибка, не молчаливый UTC. */
export function showInZone(startsAtUtc: string, zone: Zone): LocalTime {
  if (!(ZONES as readonly string[]).includes(zone)) throw new RangeError(`unsupported zone: ${zone}`);
  const ms = toMs(startsAtUtc);
  if (!Number.isFinite(ms)) throw new RangeError('invalid date');
  const p: Record<string, string> = {};
  for (const x of fmt(zone).formatToParts(new Date(ms))) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  const offsetMin = Math.round((asUtc - Math.floor(ms / 60_000) * 60_000) / 60_000);
  const date = `${p.year}-${p.month}-${p.day}`, time = `${p.hour}:${p.minute}`;
  return { zone, date, time, offsetMin, text: `${date} ${time}` };
}
