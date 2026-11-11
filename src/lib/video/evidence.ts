/**
 * Keeps a figure tied to what its source actually says. A results screenshot prints several numbers
 * that are easy to mix up (what was spent, what the platform tracked as conversion value, what was
 * really sold), is often annotated by whoever made it, and covers a stated period. Nothing here
 * decides what is true: it flags where the image and its annotations disagree, so that is settled
 * by a person before the figure is used. Pure, client-safe.
 */
import type { EvidenceCaution, StatMetric } from "@/lib/video/pipeline-types";

export type EvidenceStat = {
  value: string;
  /** The label the tool itself prints beside the figure. */
  label: string;
  /** A label someone added on top of the image for the same figure (a callout, a relabel), when there is one. */
  annotationLabel?: string | null;
};

export type EvidenceReading = {
  stats: EvidenceStat[];
  /** The period selected in the tool, as printed. */
  dateRange?: string | null;
  /** Every note added on top of the image, verbatim. */
  annotations?: string[];
  /** The currency named in the image (a code or a name). A bare symbol is not a currency. */
  currencyCode?: string | null;
};

/** What a label says the figure measures. The order matters: "conv. value / cost" is not "conv. value", and "cost / conv." is not "cost". */
export function metricOf(label: string): StatMetric {
  const l = label.toLowerCase().replace(/\s+/g, " ");
  if (/conv(ersion)?s?\.? ?value ?(\/|per|÷) ?cost|\broas\b|return on ad spend|value ?\/ ?cost/.test(l)) return "conversion_value_per_cost";
  if (/cost ?(\/|per) ?conv|cost per (conversion|acquisition|lead|result)|\bcpa\b|\bcpl\b/.test(l)) return "cost_per_conversion";
  if (/conv(ersion)?s?\.? ?value|conversion value/.test(l)) return "conversion_value";
  if (/\b(sales|revenue|turnover|income)\b/.test(l)) return "sales_revenue";
  if (/\b(cost|spend|spent|ad spend)\b/.test(l)) return "ad_spend";
  return "other";
}

const METRIC_WORDS: Record<StatMetric, string> = {
  ad_spend: "ad spend",
  conversion_value: "conversion value",
  sales_revenue: "sales revenue",
  cost_per_conversion: "cost per conversion",
  conversion_value_per_cost: "conversion value divided by cost",
  other: "another measure",
};

export const metricWords = (m: StatMetric) => METRIC_WORDS[m];

/**
 * The tool's own label and the added one, for a stat stored the older way with both in one string
 * ("Conv. value (Sales Revenue)", "Cost (Ad Spent)"): the part in brackets is the annotation.
 */
export function splitLabel(stat: EvidenceStat): { label: string; annotationLabel: string | null } {
  if (stat.annotationLabel) return { label: stat.label.trim(), annotationLabel: stat.annotationLabel.trim() };
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(stat.label.trim());
  if (m && m[1]!.trim()) return { label: m[1]!.trim(), annotationLabel: m[2]!.trim() };
  return { label: stat.label.trim(), annotationLabel: null };
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** The dates in a printed range ("1 June 2025 – 31 May 2026", "Jun 1, 2025 - May 31, 2026"), in order. */
export function datesIn(text: string): Date[] {
  const out: Date[] = [];
  const re = /(?:(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4}))|(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}))|(?:(\d{4})-(\d{2})-(\d{2}))/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let d: Date | null = null;
    if (m[1]) {
      const month = MONTHS[m[2]!.slice(0, 3).toLowerCase()];
      if (month !== undefined) d = new Date(Date.UTC(Number(m[3]), month, Number(m[1])));
    } else if (m[4]) {
      const month = MONTHS[m[4].slice(0, 3).toLowerCase()];
      if (month !== undefined) d = new Date(Date.UTC(Number(m[6]), month, Number(m[5])));
    } else if (m[7]) {
      d = new Date(Date.UTC(Number(m[7]), Number(m[8]) - 1, Number(m[9])));
    }
    if (d && !Number.isNaN(d.getTime())) out.push(d);
  }
  return out;
}

/** How many days a printed range covers, both end days counted. Null when two dates cannot be read from it. */
export function rangeDays(dateRange: string | null | undefined): number | null {
  if (!dateRange) return null;
  const dates = datesIn(dateRange);
  if (dates.length < 2) return null;
  const days = Math.round((dates[dates.length - 1]!.getTime() - dates[0]!.getTime()) / 86_400_000) + 1;
  return days > 0 ? days : null;
}

const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30.4, year: 365 };
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, twelve: 12 };

/** A claim about how long something took, read from a note or a spoken line: "In <1 year", "in under six months". */
export function timeClaim(text: string): { phrase: string; days: number; under: boolean } | null {
  const m = /\b(?:in|within|after|over)?\s*(<|under|less than|fewer than|just)?\s*(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|twelve)\s*(day|week|month|year)s?\b/i.exec(text);
  if (!m) return null;
  const n = /^\d/.test(m[2]!) ? Number(m[2]) : NUMBER_WORDS[m[2]!.toLowerCase()];
  const unit = UNIT_DAYS[m[3]!.toLowerCase()];
  if (!n || !unit) return null;
  const under = Boolean(m[1]) && !/^just$/i.test(m[1]!);
  // Only a claim that something took LESS than a period can be contradicted by a range of that length.
  if (!under && !/\b(in|within)\s/i.test(m[0])) return null;
  return { phrase: m[0].trim(), days: n * unit, under };
}

/** What to settle about one image's figures before they are used. */
export function evidenceCautions(reading: EvidenceReading | null | undefined): EvidenceCaution[] {
  if (!reading) return [];
  const out: EvidenceCaution[] = [];

  for (const stat of reading.stats) {
    const { label, annotationLabel } = splitLabel(stat);
    if (!annotationLabel) continue;
    const printed = metricOf(label);
    const added = metricOf(annotationLabel);
    if (printed === added || added === "other") continue;
    // A paraphrase of the same measure ("Ad Spent" for "Cost") is not a disagreement; a different measure is.
    out.push({
      code: "label_differs",
      figure: stat.value,
      message:
        printed === "conversion_value" && added === "sales_revenue"
          ? `The image's own label for ${stat.value} is "${label}"; a note added on the image calls it "${annotationLabel}". Conversion value is what the ad platform tracked, not independently verified sales revenue: call it conversion value unless you can support the revenue figure another way.`
          : `The image's own label for ${stat.value} is "${label}" (${metricWords(printed)}); a note added on the image calls it "${annotationLabel}" (${metricWords(added)}). Use the image's own label, or confirm which is right before the figure is used.`,
    });
  }

  const days = rangeDays(reading.dateRange);
  if (days !== null) {
    for (const note of reading.annotations ?? []) {
      const claim = timeClaim(note);
      if (!claim) continue;
      const contradicted = claim.under ? days >= claim.days : days > claim.days * 1.05;
      if (contradicted) {
        out.push({
          code: "time_claim_unsupported",
          message: `A note on the image says "${note.trim()}", but the period selected in it is ${reading.dateRange!.trim()} (${days} days), which is not ${claim.under ? "less than" : "within"} that. Do not repeat the time claim until it is confirmed; state the period the image shows instead.`,
        });
      }
    }
  }

  const symbol = reading.stats.map((s) => /[$€£¥]/.exec(s.value)?.[0]).find(Boolean);
  if (symbol && !reading.currencyCode?.trim()) {
    out.push({ code: "currency_unstated", message: `The image prints "${symbol}" without naming the currency. Do not state which currency (for example Australian or US dollars) these figures are in unless that is confirmed.` });
  }
  return out;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, "");

/** A spoken line states a figure when it carries the figure's digits ("26.5 million" for "26.5M"). */
function lineHasFigure(line: string, value: string): boolean {
  const digits = /\d[\d,.]*/.exec(value)?.[0].replace(/,/g, "").replace(/\.$/, "");
  if (!digits) return false;
  const l = squash(line.replace(/,/g, ""));
  return l.includes(squash(value)) || new RegExp(`(^|[^0-9.])${digits.replace(".", "\\.")}([^0-9]|$)`).test(line.replace(/,/g, ""));
}

/**
 * Where the narration goes beyond what the evidence supports: a tracked conversion value spoken of
 * as sales or revenue, a time claim the image's period does not support, a currency the image does
 * not name. Each is something for the operator to confirm or reword, with the line it is in.
 */
export function narrationCautions(lines: Array<{ sceneNumber: number; text: string }>, readings: Array<EvidenceReading | null | undefined>): string[] {
  const out: string[] = [];
  const add = (m: string) => {
    if (!out.includes(m)) out.push(m);
  };
  for (const reading of readings) {
    if (!reading) continue;
    const cautions = evidenceCautions(reading);
    const timeUnsupported = cautions.some((c) => c.code === "time_claim_unsupported");
    const currencyUnstated = cautions.some((c) => c.code === "currency_unstated");
    for (const line of lines) {
      const said = reading.stats.filter((s) => lineHasFigure(line.text, s.value));
      if (!said.length) continue;
      for (const stat of said) {
        const printed = metricOf(splitLabel(stat).label);
        if (printed === "conversion_value" && /\b(revenue|sales|turnover|income|sold)\b/i.test(line.text) && !/conversion value/i.test(line.text)) {
          add(`Scene ${line.sceneNumber} speaks of ${stat.value} as sales or revenue, but the image labels it conversion value (what the ad platform tracked). Say "conversion value", or confirm the revenue figure.`);
        }
        if (printed === "ad_spend" && /\b(revenue|sales|earned|made|generated)\b/i.test(line.text) && said.length === 1) {
          add(`Scene ${line.sceneNumber} speaks of ${stat.value} as a result, but the image labels it as the amount spent.`);
        }
      }
      const claim = timeClaim(line.text);
      if (claim && timeUnsupported) add(`Scene ${line.sceneNumber} says "${claim.phrase}", which the period shown in the image (${reading.dateRange?.trim()}) does not support. Confirm it or state the period instead.`);
      if (currencyUnstated && /\b(australian dollars?|aud|us dollars?|usd|american dollars?|nz dollars?|nzd|canadian dollars?|cad)\b/i.test(line.text)) {
        add(`Scene ${line.sceneNumber} names a currency, but the image only prints a currency symbol. Confirm the currency before saying it.`);
      }
    }
  }
  return out;
}
