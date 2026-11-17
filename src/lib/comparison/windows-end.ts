/**
 * A comparison must not include today: Meta's numbers for a day still in progress are partial, so a
 * window ending today understates the current period. Ranges the operator named ("last 30 days vs the
 * previous 30 days") are parsed as ending today, so they are moved back here.
 */

type Range = { since: string; until: string };

function shift(day: string, by: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

const days = (r: Range) => Math.round((Date.parse(`${r.until}T00:00:00Z`) - Date.parse(`${r.since}T00:00:00Z`)) / 86_400_000) + 1;

/**
 * Ends the current window on the last whole day.
 * - "Last N days vs the previous N days" (same length, previous right before current): both move back
 *   one day so they stay the same length and touch.
 * - Calendar pairs ("this week vs last week", "this month vs last month") keep their starts: only the
 *   current window's end is pulled back to yesterday, so weeks and months stay aligned.
 * Ranges that already end before today are returned as they are.
 */
export function endOnLastWholeDay(
  current: Range,
  previous: Range | null,
  today: string,
): { current: Range; previous: Range | null } {
  if (current.until < today) return { current, previous };
  const yesterday = shift(today, -1);
  const rolling = previous != null && shift(previous.until, 1) === current.since && days(previous) === days(current);
  if (rolling) {
    return {
      current: { since: shift(current.since, -1), until: shift(current.until, -1) },
      previous: { since: shift(previous.since, -1), until: shift(previous.until, -1) },
    };
  }
  // A one-day window of today has no whole day to fall back on inside it: use yesterday alone.
  const since = current.since > yesterday ? yesterday : current.since;
  return { current: { since, until: yesterday }, previous };
}
