// Date helpers. All "calendar dates" are plain YYYY-MM-DD strings interpreted
// in the workspace timezone (env.TIMEZONE); time-of-day is never stored.

const DAY_MS = 86_400_000;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Today's date (YYYY-MM-DD) in the given IANA timezone. */
export function todayInTZ(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Current hour of day (0-23) in the given IANA timezone. */
export function hourInTZ(tz: string): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  return Number(hour) % 24;
}

function toUTC(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUTC(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

export function addDays(ymd: string, n: number): string {
  return fromUTC(toUTC(ymd) + n * DAY_MS);
}

/** Whole days from today until the given date. Negative = in the past. */
export function daysUntil(ymd: string, tz: string): number {
  return Math.round((toUTC(ymd) - toUTC(todayInTZ(tz))) / DAY_MS);
}

/** "Mon, Jul 20" for a YYYY-MM-DD string. */
export function formatDate(ymd: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(toUTC(ymd)));
}

/**
 * Parse a human due date: "today", "tomorrow", a weekday name ("friday"),
 * "7/20", "7/20/2026", or "2026-07-20". Returns YYYY-MM-DD or null.
 * Bare weekdays and month/day dates resolve to the next future occurrence.
 */
export function parseDueDate(input: string, tz: string): string | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  const today = todayInTZ(tz);

  if (text === 'today') return today;
  if (text === 'tomorrow' || text === 'tmrw') return addDays(today, 1);

  const weekdayIdx = WEEKDAYS.findIndex((w) => w === text || w.slice(0, 3) === text);
  if (weekdayIdx >= 0) {
    const todayIdx = new Date(toUTC(today)).getUTCDay();
    let delta = (weekdayIdx - todayIdx + 7) % 7;
    if (delta === 0) delta = 7; // "friday" said on a Friday means next Friday
    return addDays(today, delta);
  }

  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return buildDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slash = text.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    let year = slash[3] ? Number(slash[3]) : Number(today.slice(0, 4));
    if (year < 100) year += 2000;
    let result = buildDate(year, month, day);
    // A bare month/day that already passed this year means next year
    if (result && !slash[3] && result < today) result = buildDate(year + 1, month, day);
    return result;
  }

  return null;
}

function buildDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ymd = fromUTC(Date.UTC(year, month - 1, day));
  // Reject rollovers like 2/30 -> 3/2
  return Number(ymd.slice(5, 7)) === month && Number(ymd.slice(8, 10)) === day ? ymd : null;
}

/** Human label for a due date relative to today: "today", "tomorrow", "overdue by 2 days", "Mon, Jul 20". */
export function dueLabel(ymd: string, tz: string): string {
  const days = daysUntil(ymd, tz);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 0) return `overdue by ${-days} day${days === -1 ? '' : 's'} (${formatDate(ymd)})`;
  return formatDate(ymd);
}
