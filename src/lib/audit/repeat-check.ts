/**
 * Spots an audit that tells the same story in section after section. The audit
 * method asks the writer to explain each problem once (in Risks & Issues) and
 * point to it elsewhere; this measures whether that happened, so a drift shows
 * up in the logs instead of in a client's report.
 *
 * It looks at distinctive figures — money amounts, percentages, long ids —
 * because a finding that is re-explained keeps carrying its numbers. It does
 * not judge wording and does not rewrite anything.
 */

export type RepeatedFigure = {
  figure: string;
  /** The sections (by heading) the figure appears in. */
  sections: string[];
};

/** Sections that legitimately carry numbers: the snapshot table and the appended checklist. */
const EXEMPT = /snapshot|audit checklist|how the score works|scores by area|changes during this period/i;

/** A figure carried across more than this many sections counts as a repeated story. */
const MAX_SECTIONS = 3;

const FIGURE = /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?%|\b\d{12,}\b)/g;

function sectionsOf(markdown: string): Array<{ title: string; body: string }> {
  const out: Array<{ title: string; body: string }> = [];
  let current = { title: "(intro)", body: "" };
  for (const line of markdown.split("\n")) {
    const heading = /^\s{0,3}(?:#{1,3}\s+|\*\*)?(\d{1,2}\.\s+[A-Z][^\n|]{2,80}?)(?:\*\*)?\s*$/.exec(line) ?? /^\s{0,3}#{1,3}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      out.push(current);
      current = { title: heading[1]!.replace(/\*+/g, "").trim(), body: "" };
    } else {
      current.body += `${line}\n`;
    }
  }
  out.push(current);
  return out.filter((s) => s.body.trim());
}

/**
 * Figures that show up in more than three sections of the report. Figures in
 * the snapshot, the change history and the appended checklist don't count —
 * those sections exist to show numbers.
 */
export function findRepeatedFigures(markdown: string): RepeatedFigure[] {
  const seen = new Map<string, Set<string>>();
  for (const section of sectionsOf(markdown)) {
    if (EXEMPT.test(section.title)) continue;
    for (const match of section.body.matchAll(FIGURE)) {
      const figure = match[0].replace(/\s+/g, "");
      // Round, common percentages and tiny amounts are coincidence, not a repeated finding.
      if (/^\d{1,2}%$/.test(figure) || /^[$€£]\d{1,2}(?:\.0+)?$/.test(figure)) continue;
      const titles = seen.get(figure) ?? new Set<string>();
      titles.add(section.title);
      seen.set(figure, titles);
    }
  }
  return [...seen.entries()]
    .filter(([, titles]) => titles.size > MAX_SECTIONS)
    .map(([figure, titles]) => ({ figure, sections: [...titles] }))
    .sort((a, b) => b.sections.length - a.sections.length);
}
