// ============================================================
// Monthly AI budget — pure helpers.
//
// Spend is always DERIVED from `ai_usage` for the current calendar
// month in the account's business time zone (America/Sao_Paulo). No
// running counter is stored, so nothing needs resetting and a missed
// cron can never leave an account blocked (or unblocked) by mistake.
// ============================================================

export const AI_BUDGET_TIME_ZONE = 'America/Sao_Paulo';

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** Offset of `timeZone` from UTC at `date`, in ms (negative west of UTC). */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The UTC instant of 00:00 on the 1st of the month that `now` falls in,
 * as seen in `timeZone`. E.g. 2026-10-01T01:00Z is still September in
 * São Paulo (22:00 on 30/09), so the window starts 2026-09-01T03:00Z.
 */
export function monthStartInTimeZone(now: Date, timeZone: string = AI_BUDGET_TIME_ZONE): Date {
  const { year, month } = zonedParts(now, timeZone);
  const localMidnightAsUtc = Date.UTC(year, month - 1, 1, 0, 0, 0);
  // Two passes settle zones whose offset differs around the boundary.
  let guess = localMidnightAsUtc - zoneOffsetMs(new Date(localMidnightAsUtc), timeZone);
  guess = localMidnightAsUtc - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/** `YYYY-MM` of `now` in the budget time zone — for display. */
export function budgetMonthKey(now: Date, timeZone: string = AI_BUDGET_TIME_ZONE): string {
  const { year, month } = zonedParts(now, timeZone);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Share of the monthly budget at which owners and admins are warned. */
export const AI_BUDGET_ALERT_RATIO = 0.8;

/**
 * This call took the month's spend across the alert line. Spend only
 * grows inside a month, so the line is crossed once — no state to keep
 * (raising the budget later moves the line and may warn again).
 */
export function crossesBudgetAlert(spentBeforeCents: number, costCents: number, budgetCents: number): boolean {
  if (!(budgetCents > 0) || !(costCents > 0)) return false;
  const line = budgetCents * AI_BUDGET_ALERT_RATIO;
  return spentBeforeCents < line && spentBeforeCents + costCents >= line;
}

/** True when this month's spend has used up the budget (0 blocks everything). */
export function isBudgetExhausted(spentCents: number, budgetCents: number): boolean {
  const spent = Number.isFinite(spentCents) ? spentCents : 0;
  const budget = Number.isFinite(budgetCents) ? budgetCents : 0;
  return spent >= budget;
}
