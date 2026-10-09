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
