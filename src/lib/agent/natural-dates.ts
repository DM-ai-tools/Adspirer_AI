/**
 * Natural-language date ranges for audits and performance questions:
 * "1st sept to 15th sept", "1 Sep – 15 Sep 2026", "Sept 1-15", "1-15 september",
 * "01/09/2026 to 15/09/2026", "September 2026", "for august", "last month".
 *
 * Numeric dates are read day-first (AU/UK) unless only month-first is valid.
 * A missing year means the most recent such date that isn't in the future.
 */

export type ParsedRange = { dateStart: string; dateStop: string; dateLabel: string };

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept(?:ember)?|sep|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
const YEAR = "(?:,?\\s*(20\\d{2}))?";
const SEP = "\\s*(?:to|till|until|through|thru|and|-|–|—)\\s*";
const LABEL_FMT = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

type Parts = { day: number; month: number; year: number | null };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const monthOf = (word: string) => MONTHS[word.toLowerCase().replace(/\.$/, "")];

function valid(p: Parts, year: number) {
  const d = utc(year, p.month, p.day);
  return d.getUTCMonth() === p.month && d.getUTCDate() === p.day;
}

/** Resolve years: explicit wins; otherwise the latest year that keeps the range in the past. */
function finish(start: Parts, stop: Parts, today: Date): ParsedRange | null {
  const thisYear = today.getUTCFullYear();
  let stopYear = stop.year ?? start.year ?? thisYear;
  let startYear = start.year ?? stopYear;
  // "15 Dec to 10 Jan" crosses a year boundary: the start is in the year before.
  if (start.year == null && utc(startYear, start.month, start.day) > utc(stopYear, stop.month, stop.day)) {
    startYear -= 1;
  }
  // A range that hasn't started yet means last year's; one that is still
  // running ("1 Oct to 31 Oct" on 9 Oct) keeps this year and is clamped.
  if (stop.year == null && start.year == null && utc(startYear, start.month, start.day) > today) {
    stopYear -= 1;
    startYear -= 1;
  }
  if (!valid(start, startYear) || !valid(stop, stopYear)) return null;
  const from = utc(startYear, start.month, start.day);
  let to = utc(stopYear, stop.month, stop.day);
  if (from > to) return null;
  if (to > today) to = today; // Meta has no data for future days.
  if (from > to) return null;
  return {
    dateStart: iso(from),
    dateStop: iso(to),
    dateLabel: `${LABEL_FMT.format(from)} – ${LABEL_FMT.format(to)}`,
  };
}

const fullYear = (y: string | undefined) =>
  y == null ? null : y.length === 2 ? 2000 + Number(y) : Number(y);

export function parseNaturalDateRange(text: string, now = new Date()): ParsedRange | null {
  const t = text.toLowerCase().replace(/\s+/g, " ");
  const today = utc(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const re = (src: string) => new RegExp(src, "i");

  // 1 Sep (2026) to 15 Sep (2026) — "1st of september till 15th september"
  let m = re(`\\b${DAY}\\s*(?:of\\s+)?${MONTH}${YEAR}${SEP}${DAY}\\s*(?:of\\s+)?${MONTH}${YEAR}`).exec(t);
  if (m) {
    return finish(
      { day: +m[1]!, month: monthOf(m[2]!)!, year: fullYear(m[3]) },
      { day: +m[4]!, month: monthOf(m[5]!)!, year: fullYear(m[6]) },
      today,
    );
  }
  // Sep 1 (2026) to Sep 15 (2026)
  m = re(`\\b${MONTH}\\s*${DAY}${YEAR}${SEP}${MONTH}\\s*${DAY}${YEAR}`).exec(t);
  if (m) {
    return finish(
      { day: +m[2]!, month: monthOf(m[1]!)!, year: fullYear(m[3]) },
      { day: +m[5]!, month: monthOf(m[4]!)!, year: fullYear(m[6]) },
      today,
    );
  }
  // 1-15 September (2026) · 1st to 15th of Sept
  m = re(`\\b${DAY}${SEP}${DAY}\\s*(?:of\\s+)?${MONTH}${YEAR}`).exec(t);
  if (m) {
    const month = monthOf(m[3]!)!;
    const year = fullYear(m[4]);
    return finish({ day: +m[1]!, month, year }, { day: +m[2]!, month, year }, today);
  }
  // September 1-15 (2026)
  m = re(`\\b${MONTH}\\s*${DAY}${SEP}${DAY}${YEAR}`).exec(t);
  if (m) {
    const month = monthOf(m[1]!)!;
    const year = fullYear(m[4]);
    return finish({ day: +m[2]!, month, year }, { day: +m[3]!, month, year }, today);
  }
  // 01/09/2026 to 15/09/2026 · 1.9.26 - 15.9.26
  m = /\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?\s*(?:to|till|until|through|thru|and|-|–|—)\s*(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?\b/.exec(t);
  if (m) {
    const y1 = fullYear(m[3]) ?? fullYear(m[6]);
    const y2 = fullYear(m[6]) ?? y1;
    const [a, b, c, d] = [+m[1]!, +m[2]!, +m[4]!, +m[5]!];
    // One reading for both dates: day-first (AU/UK) when both allow it,
    // otherwise month-first when both allow that.
    const dayFirstOk = b <= 12 && d <= 12 && a <= 31 && c <= 31;
    const monthFirstOk = a <= 12 && c <= 12 && b <= 31 && d <= 31;
    const start = dayFirstOk
      ? { day: a, month: b - 1, year: y1 }
      : monthFirstOk
        ? { day: b, month: a - 1, year: y1 }
        : null;
    const stop = dayFirstOk
      ? { day: c, month: d - 1, year: y2 }
      : monthFirstOk
        ? { day: d, month: c - 1, year: y2 }
        : null;
    if (start && stop) return finish(start, stop, today);
  }
  // Previous calendar month.
  if (/\b(last|previous|prior)\s+(calendar\s+)?month\b/.test(t)) {
    const first = utc(today.getUTCFullYear(), today.getUTCMonth() - 1, 1);
    const last = utc(today.getUTCFullYear(), today.getUTCMonth(), 0);
    return {
      dateStart: iso(first),
      dateStop: iso(last),
      dateLabel: `${LABEL_FMT.format(first)} – ${LABEL_FMT.format(last)}`,
    };
  }
  // A single day: "16th sept", "on 16 September 2026", "Sept 16", "16/09/2026".
  m = re(`\\b${DAY}\\s*(?:of\\s+)?${MONTH}${YEAR}`).exec(t) ?? null;
  if (m && (m[2]!.toLowerCase() !== "may" || m[3] || /\d/.test(m[1]!))) {
    const day: Parts = { day: +m[1]!, month: monthOf(m[2]!)!, year: fullYear(m[3]) };
    return finish(day, day, today);
  }
  m = re(`\\b${MONTH}\\s+${DAY}(?!\\d|\\s*(?:%|x|k|am|pm|days?|weeks?|months?))${YEAR}`).exec(t);
  if (m && m[1]!.toLowerCase() !== "may") {
    const day: Parts = { day: +m[2]!, month: monthOf(m[1]!)!, year: fullYear(m[3]) };
    return finish(day, day, today);
  }
  m = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})\b/.exec(t);
  if (m) {
    const [a, b] = [+m[1]!, +m[2]!];
    const year = fullYear(m[3]);
    const day: Parts | null =
      b <= 12 ? { day: a, month: b - 1, year } : a <= 12 ? { day: b, month: a - 1, year } : null;
    if (day) return finish(day, day, today);
  }

  // A whole month: "September 2026", "for sept", "in august", "month of july".
  // Bare "may" is ignored unless it clearly names the month.
  m = re(`(?:\\b(for|in|during|month of|of|whole|all of|throughout)\\s+)?\\b${MONTH}(?:\\s+(20\\d{2}))?\\b`).exec(t);
  if (m && (m[2]!.toLowerCase() !== "may" || m[1] || m[3])) {
    const month = monthOf(m[2]!)!;
    let year = m[3] ? Number(m[3]) : today.getUTCFullYear();
    if (!m[3] && utc(year, month, 1) > today) year -= 1;
    const lastDay = utc(year, month + 1, 0).getUTCDate();
    return finish({ day: 1, month, year }, { day: lastDay, month, year }, today);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Two ranges compared: "Oct 19-20 vs Oct 17-18", "this week vs last week",
// "last 7 days vs the 7 days before", "October compared to September".

export type ComparisonRanges = { current: ParsedRange; comparison: ParsedRange };

const DAY_MS = 86_400_000;

function rangeOf(from: Date, to: Date): ParsedRange {
  return { dateStart: iso(from), dateStop: iso(to), dateLabel: `${LABEL_FMT.format(from)} – ${LABEL_FMT.format(to)}` };
}

const fromIso = (s: string) => new Date(Date.parse(`${s}T00:00:00Z`));

/** One side of a comparison: relative words, ISO dates, then natural dates. */
function parseSide(text: string, today: Date, now: Date): ParsedRange | null {
  const t = text.toLowerCase();
  const lastN = /\b(?:last|past)\s+(\d{1,3})\s+days?\b/.exec(t);
  if (lastN) {
    const n = Math.min(365, Math.max(1, Number(lastN[1])));
    return rangeOf(new Date(today.getTime() - (n - 1) * DAY_MS), today);
  }
  // Weeks run Monday to Sunday; this week stops today.
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY_MS);
  if (/\bthis\s+week\b/.test(t)) return rangeOf(monday, today);
  if (/\b(?:last|previous|prior)\s+week\b/.test(t)) {
    return rangeOf(new Date(monday.getTime() - 7 * DAY_MS), new Date(monday.getTime() - DAY_MS));
  }
  if (/\bthis\s+month\b/.test(t)) return rangeOf(utc(today.getUTCFullYear(), today.getUTCMonth(), 1), today);
  if (/\byesterday\b/.test(t)) {
    const y = new Date(today.getTime() - DAY_MS);
    return rangeOf(y, y);
  }
  if (/\btoday\b/.test(t)) return rangeOf(today, today);
  const isoRange = /\b(20\d{2}-\d{2}-\d{2})\s*(?:to|through|until|–|—|-)\s*(20\d{2}-\d{2}-\d{2})\b/.exec(t);
  if (isoRange && isoRange[1]! <= isoRange[2]!) return rangeOf(fromIso(isoRange[1]!), fromIso(isoRange[2]!));
  const isoDay = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(t);
  if (isoDay) return rangeOf(fromIso(isoDay[1]!), fromIso(isoDay[1]!));
  return parseNaturalDateRange(text, now);
}

/** "the 7 days before", "previous 7 days", "the previous period" — relative to the other range. */
function parseRelativeTo(text: string, other: ParsedRange): ParsedRange | null {
  const t = text.toLowerCase();
  const start = fromIso(other.dateStart);
  const days = Math.round((fromIso(other.dateStop).getTime() - start.getTime()) / DAY_MS) + 1;
  const nDays =
    /\b(\d{1,3})\s+days?\s+(?:before|prior|earlier|preceding)\b/.exec(t) ??
    /\b(?:previous|prior|preceding)\s+(\d{1,3})\s+days?\b/.exec(t);
  const n = nDays
    ? Math.min(365, Math.max(1, Number(nDays[1])))
    : /\b(?:previous|prior|preceding)\s+period\b|\b(?:period|time)\s+before\b|\bbefore\s+that\b|\bsame\s+(?:length|period)\s+before\b/.test(t)
      ? days
      : null;
  if (n == null) return null;
  return rangeOf(new Date(start.getTime() - n * DAY_MS), new Date(start.getTime() - DAY_MS));
}

/**
 * Two named ranges, or null when the text doesn't compare two ranges.
 * The range that ends later is the current one; the other is the comparison.
 */
export function parseComparisonRanges(text: string, now = new Date()): ComparisonRanges | null {
  const t = text.replace(/\s+/g, " ");
  const today = utc(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const split =
    /^(.*?)\s+(?:vs\.?|versus|compared\s+(?:to|with)|against)\s+(.*)$/i.exec(t) ??
    /^(.*?\bcompar(?:e|ing)\b.*?)\s+with\s+(.*)$/i.exec(t);
  if (!split) return null;
  const a = parseSide(split[1]!, today, now);
  if (!a) return null;
  const b = parseRelativeTo(split[2]!, a) ?? parseSide(split[2]!, today, now);
  if (!b || (a.dateStart === b.dateStart && a.dateStop === b.dateStop)) return null;
  return b.dateStop > a.dateStop ? { current: b, comparison: a } : { current: a, comparison: b };
}
