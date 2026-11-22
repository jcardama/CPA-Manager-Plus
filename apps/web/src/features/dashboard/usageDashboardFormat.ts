const UNITS: Array<[string, number]> = [
  ['T', 1e12],
  ['B', 1e9],
  ['M', 1e6],
  ['K', 1e3],
];

const threeDigits = (value: number) => {
  const abs = Math.abs(value);
  return value.toFixed(abs >= 99.95 ? 0 : abs >= 9.995 ? 1 : 2);
};

/** A number as three significant digits and a unit, kept apart so the unit can be set smaller. */
export function compactParts(value: number): [string, string] {
  const number = Number.isFinite(value) ? value : 0;
  const abs = Math.abs(number);
  for (const [unit, size] of UNITS) {
    // Just under a unit rounds up into it: 999,950 reads 1.00M, not 1000K.
    if (abs >= size * 0.9995) return [threeDigits(number / size), unit];
  }
  return [String(Math.round(number)), ''];
}

export const formatCompact = (value: number) => compactParts(value).join('');

export function moneyParts(value: number): [string, string] {
  const number = Number.isFinite(value) ? value : 0;
  return Math.abs(number) >= 999.5 ? compactParts(number) : [threeDigits(number), ''];
}

export const formatMoney = (value: number) =>
  value > 0 && value < 0.005 ? '<$0.01' : `$${moneyParts(value).join('')}`;

export function formatShare(ratio: number) {
  if (!(ratio > 0)) return '0%';
  if (ratio < 0.0005) return '<0.1%';
  if (ratio >= 0.9995) return '100%';
  return `${(ratio * 100).toFixed(1)}%`;
}

/** The size of a change, without its sign: the arrow beside it carries the direction. */
export function formatChange(ratio: number) {
  const percent = Math.abs(ratio * 100);
  return `${percent.toFixed(percent >= 99.95 ? 0 : 1)}%`;
}

/** Axis tick text: whole units where they fit, without padding zeros. */
export function formatTick(value: number) {
  for (const [unit, size] of UNITS) {
    if (value >= size) return `${Number((value / size).toFixed(1))}${unit}`;
  }
  return String(Math.round(value));
}

export interface UsageFormatters {
  exact: (value: number) => string;
  exactMoney: (value: number) => string;
  time: (ms: number) => string;
  weekday: (ms: number) => string;
  dayOfMonth: (ms: number) => string;
  dayMonth: (ms: number) => string;
  /** Monday-first short weekday names. */
  weekdays: string[];
  /** Short name of the browser's time zone, which every time on the page is in. */
  timeZone: string;
}

export function createUsageFormatters(locale: string): UsageFormatters {
  const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const cents = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const dayOfMonth = new Intl.DateTimeFormat(locale, { day: 'numeric' });
  const dayMonth = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
  // 5 January 2026 is a Monday.
  const monday = new Date(2026, 0, 5);
  return {
    exact: (value) => integer.format(Math.round(value)),
    exactMoney: (value) => `$${cents.format(value)}`,
    time: (ms) => time.format(ms),
    weekday: (ms) => weekday.format(ms),
    dayOfMonth: (ms) => dayOfMonth.format(ms),
    dayMonth: (ms) => dayMonth.format(ms),
    weekdays: Array.from({ length: 7 }, (_, index) =>
      weekday.format(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index))
    ),
    timeZone:
      new Intl.DateTimeFormat(locale, { timeZoneName: 'short' })
        .formatToParts(new Date())
        .find((part) => part.type === 'timeZoneName')?.value ?? '',
  };
}
