import type { AuditReport } from "@/lib/report/schema";

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Deterministic markdown from the structured audit report. */
export function renderAuditReportMarkdown(r: AuditReport): string {
  const lines: string[] = [
    `# ${r.meta.reportType} — ${r.meta.accountName}`,
    `_${r.meta.period} · generated ${fmtDate(r.meta.generatedAt)} · account ${r.meta.accountId}_`,
    "",
    `**Bottom line.** ${r.bottomLine}`,
    "",
    `| Metric | Value |`,
    `| --- | --- |`,
    ...r.kpis.map(
      (k) =>
        `| ${k.label} | ${k.value}${k.note ? ` (${k.note})` : ""}${k.flag ? " ⚠️" : ""} |`,
    ),
    "",
    `## Account snapshot`,
    ...r.snapshot.map((row) => `- **${row.label}:** ${row.value}`),
    "",
  ];

  if (r.dataNotes.length) {
    lines.push(`## Data notes`, ...r.dataNotes.map((n) => `- ${n}`), "");
  }

  lines.push(`## Active campaigns`);
  if (!r.campaigns.length) {
    lines.push(`_No campaigns in evidence._`, "");
  } else {
    for (const c of r.campaigns) {
      lines.push(
        `### ${c.name} — \`${c.id}\`  ·  ${c.status}  ·  ${c.objective}`,
      );
      if (c.spend) lines.push(`- Spend: ${c.spend}`);
      if (c.metrics?.length) {
        lines.push(`**Performance**`);
        for (const m of c.metrics) {
          lines.push(`- ${m.label}: ${m.value}`);
        }
      }
      if (c.deliverySignals.length) {
        lines.push(`**Delivery signals**`);
        for (const b of c.deliverySignals) {
          lines.push(`- **${b.lead}** — ${b.body}`);
        }
      }
      if (c.risks.length) {
        lines.push(`**Risks**`);
        for (const b of c.risks) {
          lines.push(`- **${b.lead}** — ${b.body}`);
        }
      }
      lines.push("");
    }
  }

  lines.push(`## Risk register`, `| Risk | Severity | Detail |`, `| --- | --- | --- |`);
  if (!r.risks.length) {
    lines.push(`| — | — | No account-wide risks flagged |`);
  } else {
    for (const risk of r.risks) {
      lines.push(`| ${risk.title} | ${risk.severity} | ${risk.detail} |`);
    }
  }
  lines.push("");

  lines.push(`## Prioritised recommendations`);
  if (!r.recommendations.length) {
    lines.push(`_No recommendations._`);
  } else {
    r.recommendations.forEach((rec, i) => {
      const effort = rec.effort ? `, effort: ${rec.effort}` : "";
      lines.push(
        `${i + 1}. **${rec.title}** — ${rec.detail}  _(impact: ${rec.impact}${effort})_`,
      );
    });
  }
  lines.push("", `## Methodology`, r.methodology, "");

  return lines.join("\n");
}
