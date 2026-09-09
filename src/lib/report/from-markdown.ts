import {
  parseAuditReport,
  type AuditReport,
} from "@/lib/report/schema";

/**
 * Detect a full operator-facing audit in chat prose/markdown.
 */
export function looksLikeFullAuditMarkdown(text: string): boolean {
  const t = text.toLowerCase();
  const isAuditTitle =
    /meta ads account audit/.test(t) ||
    (/account snapshot/.test(t) && /active campaigns?/.test(t));
  const hasRiskOrRecs =
    /risks?\s*&?\s*issues|risk register|prioritised recommendations|prioritized recommendations/.test(
      t,
    );
  const hasPerf =
    (/total spend|period spend|\$\d/.test(t) &&
      /ctr|cpc|impressions/i.test(t)) ||
    (/active campaigns?/.test(t) && /paused campaigns?/.test(t));
  return isAuditTitle && (hasRiskOrRecs || hasPerf) && text.trim().length > 600;
}

/** Thin structured stubs produced when OpenAI structured output failed. */
export function isThinHeuristicReport(report: AuditReport): boolean {
  const bl = report.bottomLine.toLowerCase();
  if (bl.includes("heuristic draft") || bl.includes("structured openai")) {
    return true;
  }
  if (
    report.dataNotes.some((n) =>
      /heuristic|provisional|without structured/i.test(n),
    )
  ) {
    return true;
  }
  const spendKpi = report.kpis.find((k) => /spend/i.test(k.label));
  const activeKpi = report.kpis.find((k) => /^active$/i.test(k.label));
  if (
    spendKpi &&
    /no data/i.test(spendKpi.value) &&
    report.risks.length <= 2 &&
    report.recommendations.length <= 2
  ) {
    return true;
  }
  if (activeKpi && /no data/i.test(activeKpi.value) && report.campaigns.length === 0) {
    return true;
  }
  return false;
}

/** Strip markdown emphasis and emoji noise from report field values. */
export function cleanCell(value: string): string {
  return value
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/`/g, "")
    .replace(/_/g, " ")
    .replace(/🟢|🔴|🟡|✅|⏳|⚠️|✦/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mapSeverity(raw: string): "high" | "medium" | "low" {
  const t = raw.toLowerCase();
  if (/critical|high|🔴/.test(t)) return "high";
  if (/medium|🟡/.test(t)) return "medium";
  return "low";
}

function mapImpact(raw: string): "high" | "medium" | "low" {
  return mapSeverity(raw);
}

/** Only treat numbered / markdown headings as section boundaries. */
function sectionHeading(n: number, ...titles: string[]): RegExp {
  const title = titles.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(
    `(?:^|\\n)\\s*(?:#{1,3}\\s*)?(?:${n}\\.\\s*)?(?:${title})\\b`,
    "i",
  );
}

function section(text: string, start: RegExp, end?: RegExp): string {
  const m = start.exec(text);
  if (!m || m.index == null) return "";
  const from = m.index + m[0].length;
  const rest = text.slice(from);
  if (!end) return rest.trim();
  const e = end.exec(rest);
  return (e && e.index != null ? rest.slice(0, e.index) : rest).trim();
}

function tableMetric(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // | Active campaigns | 2 |
  const pipe = new RegExp(
    `\\|\\s*\\*?\\*?${escaped}\\*?\\*?\\s*\\|\\s*([^|\\n]+)\\|`,
    "i",
  ).exec(text);
  if (pipe?.[1]) return cleanCell(pipe[1]);
  // Active campaigns: 2   OR   **Active campaigns** 2
  const prose = new RegExp(
    `${escaped}\\s*[:|]\\s*\\*?\\*?([^\\n|,]+)`,
    "i",
  ).exec(text);
  if (prose?.[1]) return cleanCell(prose[1]);
  return undefined;
}

function extractAccountName(text: string): string {
  const fromAccountLine =
    /(?:^|\n)\s*\*?\*?\s*Account\s*\*?\*?\s*:\s*\*?\*?\s*(.+?)\s*\*?\*?\s*\(\s*act_/i.exec(
      text,
    )?.[1];
  if (fromAccountLine) {
    const name = cleanCell(fromAccountLine);
    if (name && !/^here'?s?\b/i.test(name)) return name;
  }

  const fromTitle =
    /Meta Ads Account Audit\s*[—–-]\s*([^\n*]+)/i.exec(text)?.[1];
  if (fromTitle) {
    const name = cleanCell(fromTitle);
    if (name && !/^here'?s?\b/i.test(name)) return name;
  }

  const fromFor =
    /(?:audit(?:\s+report)?|review)\s+for\s+([A-Z][^.\n(]{2,80}?)\s*(?:\(|—|-|$)/i.exec(
      text,
    )?.[1];
  if (fromFor) {
    const name = cleanCell(fromFor);
    if (name && !/^here'?s?\b/i.test(name)) return name;
  }

  if (/TR Internal Marketing/i.test(text)) return "TR Internal Marketing";
  if (/Click Trends/i.test(text)) return "Click Trends";
  return "Meta ad account";
}

function extractPeriod(text: string): string {
  const raw =
    /(?:^|\n)\s*\*?\*?\s*Period\s*\*?\*?\s*:\s*\*?\*?\s*([^\n]+)/i.exec(text)?.[1] ||
    /(Last\s+\d+\s+days[^\n*]*)/i.exec(text)?.[1] ||
    "Audit period";
  return cleanCell(raw);
}

/**
 * Convert a chat audit (markdown / prose tables) into the branded AuditReport schema.
 */
export function auditReportFromMarkdown(
  markdown: string,
  fallbackTitle = "Meta Ads Account Audit",
): AuditReport | null {
  const text = markdown.replace(/\r\n/g, "\n").trim();
  if (!looksLikeFullAuditMarkdown(text)) return null;

  const accountName = extractAccountName(text);
  const accountId = /(act_\d{5,})/i.exec(text)?.[1] || "No data";

  // Prefer explicit "Currency: XXX". Never scan bare /AUD/ — it matches "Audit".
  const currencyMatch =
    /Currency\s*:\s*([A-Z]{3})\b/i.exec(text) ||
    /(?:^|\n)\s*Currency\s*[·|]\s*([A-Z]{3})\b/i.exec(text);
  const currency = (currencyMatch?.[1] || "USD").toUpperCase();
  const timezone = cleanCell(
    /Timezone\s*:\s*([^\n|·]+)/i.exec(text)?.[1] ||
      /Timezone\s*[·|]\s*([^\n|]+)/i.exec(text)?.[1] ||
      "UTC",
  );
  const period = extractPeriod(text);
  const generatedRaw =
    /Generated\s*:\s*([^\n]+)/i.exec(text)?.[1]?.trim() ||
    new Date().toISOString();
  const generatedAt = (() => {
    const cleaned = cleanCell(generatedRaw);
    const d = new Date(cleaned);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  })();

  // Snapshot: stop at numbered section 2 only — never at the "Active campaigns" table row.
  const snapshotSection = section(
    text,
    sectionHeading(1, "Account Snapshot", "Snapshot"),
    sectionHeading(2, "Active Campaigns", "Active campaign"),
  );
  const searchSnap = snapshotSection.length > 40 ? snapshotSection : text;

  const total =
    tableMetric(searchSnap, "Total campaigns") ||
    tableMetric(text, "Total campaigns");
  const active =
    tableMetric(searchSnap, "Active campaigns") ||
    tableMetric(text, "Active campaigns");
  const paused =
    tableMetric(searchSnap, "Paused campaigns") ||
    tableMetric(text, "Paused campaigns");
  const totalSpend =
    tableMetric(searchSnap, "Total spend (30 days)") ||
    tableMetric(searchSnap, "Total spend") ||
    tableMetric(searchSnap, "Period spend") ||
    tableMetric(text, "Total spend (30 days)") ||
    tableMetric(text, "Total spend") ||
    /\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?/.exec(text)?.[0];

  const impressions = tableMetric(searchSnap, "Impressions") || tableMetric(text, "Impressions");
  const clicks = tableMetric(searchSnap, "Clicks") || tableMetric(text, "Clicks");
  const ctr = tableMetric(searchSnap, "CTR") || tableMetric(text, "CTR");
  const cpc = tableMetric(searchSnap, "CPC") || tableMetric(text, "CPC");
  const reach = tableMetric(searchSnap, "Reach") || tableMetric(text, "Reach");
  const frequency =
    tableMetric(searchSnap, "Frequency") || tableMetric(text, "Frequency");
  const cpl = tableMetric(searchSnap, "CPL") || tableMetric(text, "CPL");

  const kpis = [
    {
      label: "Total campaigns",
      value: total ?? "No data",
      flag: !total,
    },
    {
      label: "Active",
      value: active ?? "No data",
      note: total ? `of ${total} total` : undefined,
      flag: !active,
    },
    {
      label: "Paused",
      value: paused ?? "No data",
      flag: !paused,
    },
    {
      label: "Period spend",
      value: totalSpend ?? "No data",
      note: period,
      flag: !totalSpend || /unknown|no data/i.test(totalSpend),
    },
  ];

  const snapshot = [
    { label: "Account", value: accountName },
    { label: "Account ID", value: accountId, mono: true },
    { label: "Currency", value: currency },
    { label: "Timezone", value: timezone },
    { label: "Period", value: period },
    ...(impressions ? [{ label: "Impressions", value: impressions }] : []),
    ...(clicks ? [{ label: "Clicks", value: clicks }] : []),
    ...(ctr ? [{ label: "CTR", value: ctr }] : []),
    ...(cpc ? [{ label: "CPC", value: cpc }] : []),
    ...(reach ? [{ label: "Reach", value: reach }] : []),
    ...(frequency ? [{ label: "Frequency", value: frequency }] : []),
    ...(cpl ? [{ label: "CPL", value: cpl }] : []),
  ];

  // Section 2 only — do not match the snapshot table's "Active campaigns" label.
  let activeBlock = section(
    text,
    sectionHeading(2, "Active Campaigns", "Active campaign detail"),
    sectionHeading(
      3,
      "Paused Campaign Inventory",
      "Paused Campaigns",
      "Paused campaign",
      "What's Working",
      "What is Working",
      "Risks",
      "Risks & Issues",
    ),
  );
  // Also try ending before section 4/5 if section 3 missing
  if (activeBlock.length < 80) {
    activeBlock = section(
      text,
      sectionHeading(2, "Active Campaigns"),
      sectionHeading(4, "What's Working", "What is Working"),
    );
  }
  if (activeBlock.length < 80) {
    activeBlock = section(
      text,
      sectionHeading(2, "Active Campaigns"),
      sectionHeading(5, "Risks", "Risks & Issues", "Risk register"),
    );
  }
  if (activeBlock.length < 80) {
    activeBlock = text;
  }

  // Campaign headers: "Name — 1202…" (em/en dash preferred; ASCII hyphen as last resort)
  const campaignHeaderRe =
    /(?:^|\n)[ \t]*(?:🟢|✅|\*|•|-)?[ \t]*([A-Za-z0-9][^\n|]{2,120}?)[ \t]+(?:—|–|\s-\s)[ \t]*(\d{15,})\b/g;
  const headerSource =
    activeBlock.length >= 80 && /[—–-][ \t]*\d{15,}/.test(activeBlock)
      ? activeBlock
      : text;
  let headers = [...headerSource.matchAll(campaignHeaderRe)];
  headers = headers.filter((h) => {
    const name = cleanCell(h[1] || "");
    return (
      name.length >= 3 &&
      !/^account snapshot|^period|^metric|^risk|^action|^objective/i.test(
        name,
      ) &&
      !/^video ad\b|^ad\s*\d+/i.test(name) &&
      !/^here'?s?\b/i.test(name)
    );
  });

  let totalSpendNum = Number(String(totalSpend ?? "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(totalSpendNum)) totalSpendNum = 0;

  const campaigns = headers.slice(0, 24).map((m, idx) => {
    const localStart = m.index ?? 0;
    const next = headers[idx + 1];
    const localEnd =
      next && typeof next.index === "number" ? next.index : headerSource.length;
    const chunk = headerSource.slice(localStart, localEnd);

    const name = cleanCell(m[1]) || "Campaign";
    const id = m[2];
    const objective =
      cleanCell(
        /Objective\s*:\s*([^\n|]+)/i.exec(chunk)?.[1] ||
          /OUTCOME_[A-Z_]+/.exec(chunk)?.[0] ||
          "Unknown",
      ) || "Unknown";
    const status: "ACTIVE" | "PAUSED" | "ARCHIVED" = /paused/i.test(
      chunk.slice(0, 200),
    )
      ? "PAUSED"
      : "ACTIVE";

    const spend =
      tableMetric(chunk, "Spend (30 days)") ||
      tableMetric(chunk, "Spend") ||
      cleanCell(/Spend\s*:\s*(\$[\d,.]+)/i.exec(chunk)?.[1] || "") ||
      undefined;
    const spendNum = Number(String(spend ?? "").replace(/[^0-9.]/g, ""));
    const spendSharePct =
      totalSpendNum > 0 && Number.isFinite(spendNum)
        ? Math.round((spendNum / totalSpendNum) * 1000) / 10
        : spend && /\$0(\.0+)?$/.test(spend)
          ? 0
          : null;

    const metricsList = [
      ["Spend", spend],
      ["Impressions", tableMetric(chunk, "Impressions")],
      ["Clicks", tableMetric(chunk, "Clicks")],
      ["CTR", tableMetric(chunk, "CTR")],
      ["CPC", tableMetric(chunk, "CPC")],
      ["Reach", tableMetric(chunk, "Reach")],
      ["Frequency", tableMetric(chunk, "Frequency")],
      ["CPL", tableMetric(chunk, "CPL")],
    ]
      .filter(([, v]) => Boolean(v))
      .map(([label, value]) => ({
        label: label!,
        value: cleanCell(value!),
      }));

    const deliverySignals: AuditReport["campaigns"][number]["deliverySignals"] =
      [];
    const campRisks: AuditReport["campaigns"][number]["risks"] = [];

    const obsBlock =
      /Key observations:([\s\S]*?)(?=(?:\n\s*🟢)|(?:\n\s*###)|Live ads:|(?:\n\s*\d+\.\s)|$)/i.exec(
        chunk,
      )?.[1] || "";
    for (const line of obsBlock.split("\n")) {
      const item = cleanCell(line.replace(/^[-*•]\s*/, ""));
      if (item.length < 8) continue;
      const lead = item.split(/[—–-]/)[0]?.trim().slice(0, 48) || item.slice(0, 40);
      const body =
        item.slice(lead.length).replace(/^[—–\-:]\s*/, "").trim() || item;
      if (/risk|under-?fund|zero spend|dead|broken|fatigue/i.test(item)) {
        campRisks.push({
          lead,
          body,
          severity: /zero|dead|broken|under/i.test(item) ? "high" : "medium",
        });
      } else {
        deliverySignals.push({ lead, body });
      }
    }

    if (!obsBlock) {
      for (const line of chunk.split("\n")) {
        const item = cleanCell(line.replace(/^[-*•]\s*/, ""));
        if (
          item.length < 20 ||
          /objective:|metric|value|---+|campaign id/i.test(item)
        ) {
          continue;
        }
        if (/zero spend|dead|broken|unapproved|no budget|risk:/i.test(item)) {
          campRisks.push({
            lead: item.slice(0, 40),
            body: item,
            severity: "high",
          });
        } else if (/active status|likely cause|spend|ctr|frequency/i.test(item)) {
          deliverySignals.push({ lead: item.slice(0, 40), body: item });
        }
      }
    }

    const liveAds = [
      ...chunk.matchAll(/(Video Ad \d+|Ad \d+)[^\n]*?(\d{15,})[^\n]*/gi),
    ];
    for (const ad of liveAds.slice(0, 6)) {
      deliverySignals.push({
        lead: cleanCell(ad[1]),
        body: `Ad ID ${ad[2]} live in this campaign.`,
      });
    }

    if (!deliverySignals.length && spend) {
      deliverySignals.push({
        lead: "Period delivery",
        body: `${spend} spend recorded for ${period}.`,
      });
    }

    return {
      name: name.slice(0, 140),
      id,
      status,
      objective,
      spend: spend || undefined,
      spendSharePct,
      metrics: metricsList,
      deliverySignals,
      risks: campRisks,
      checkedAgainst: ["Live insights", "Campaign inventory"],
    };
  });

  const riskSection = section(
    text,
    sectionHeading(5, "Risks", "Risks & Issues", "Risk register"),
    sectionHeading(
      6,
      "Optimizations",
      "Optimizations Actioned",
      "Prioritised Recommendations",
      "Prioritized Recommendations",
    ),
  );
  const risks: AuditReport["risks"] = [];
  for (const m of riskSection.matchAll(
    /\|\s*(\d+)\s*\|\s*([^|\n]+)\|\s*([^|\n]+)\|\s*([^|\n]+)\|/g,
  )) {
    const title = cleanCell(m[2]);
    if (!title || /^risk$/i.test(title)) continue;
    risks.push({
      title,
      severity: mapSeverity(m[3]),
      detail: cleanCell(m[4]),
    });
  }
  if (!risks.length) {
    for (const line of riskSection.split("\n")) {
      if (!/\|/.test(line) || /severity|---+|\|\s*#\s*\|/i.test(line)) continue;
      const cells = line
        .split("|")
        .map((c) => cleanCell(c))
        .filter(Boolean);
      if (cells.length >= 4 && /^\d+$/.test(cells[0])) {
        risks.push({
          title: cells[1],
          severity: mapSeverity(cells[2]),
          detail: cells[3],
        });
      }
    }
  }

  const recBlock = section(
    text,
    /(?:^|\n)\s*(?:#{1,3}\s*)?(?:7\.\s*)?Prioriti[sz]ed Recommendations\b/i,
    /(?:^|\n)\s*(?:#{1,3}\s*)?(?:8\.\s*)?(?:Immediate )?Next Steps\b|\*Report compiled|Report compiled from/i,
  );

  const recommendations: AuditReport["recommendations"] = [];
  for (const m of recBlock.matchAll(
    /\|\s*(\d+)\s*\|\s*([^|\n]+)\|\s*([^|\n]+)\|\s*([^|\n]+)\|/g,
  )) {
    const title = cleanCell(m[2]);
    if (!title || /^action$/i.test(title)) continue;
    recommendations.push({
      title: title.slice(0, 120),
      detail: title,
      impact: mapImpact(m[3]),
      effort: cleanCell(m[4]),
      tags: [],
    });
  }

  const working = section(
    text,
    sectionHeading(4, "What's Working", "What is Working"),
    sectionHeading(5, "Risks", "Risks & Issues"),
  );
  const strengths = working
    .split("\n")
    .map((l) => cleanCell(l.replace(/^[-*•✅]\s*/, "")))
    .filter((l) => l.length > 12)
    .slice(0, 6);

  const criticalCount = risks.filter((r) => r.severity === "high").length;
  const healthScore =
    criticalCount >= 3 ? 42 : criticalCount === 2 ? 55 : criticalCount === 1 ? 68 : 78;
  const healthLabel =
    healthScore < 50
      ? "At risk"
      : healthScore < 70
        ? "Needs attention"
        : "Healthy";

  const firstRec = recommendations[0]?.title;
  const firstRisk = risks[0]?.title;
  const bottomLine = cleanCell(
    [
      totalSpend
        ? `Account spent ${totalSpend} over ${period} with ${active ?? "few"} active campaigns.`
        : `Account review for ${accountName} over ${period}.`,
      firstRisk
        ? `Biggest exposure: ${firstRisk}.`
        : "Review delivery and tracking next.",
      firstRec
        ? `First action: ${firstRec}.`
        : "Confirm Approvals and tracking before scaling.",
    ].join(" "),
  ).slice(0, 420);

  const methodology = cleanCell(
    /\*Report compiled([^*]+)\*/i.exec(text)?.[1]?.trim() ||
      /Report compiled from([^\n]+)/i.exec(text)?.[1]?.trim() ||
      "Compiled from live Meta Graph evidence and the operator audit in this chat session. Recommendations are advisory until Approvals execute changes.",
  );

  try {
    return parseAuditReport({
      meta: {
        reportType: fallbackTitle.includes("Audit")
          ? "Meta Ads Account Audit"
          : cleanCell(fallbackTitle),
        subtitle:
          "Operator review of live delivery, risk and next actions",
        accountName,
        accountId,
        platform: "meta",
        period,
        generatedAt,
        currency,
        timezone,
      },
      healthScore,
      healthLabel,
      bottomLine,
      kpis,
      snapshot,
      dataNotes: strengths.map((n) => `Working: ${n}`),
      campaigns,
      risks: risks.slice(0, 12),
      recommendations: recommendations.slice(0, 10).map((r) => ({
        ...r,
        title: r.title.split(/[—.]/)[0]!.trim().slice(0, 100),
        detail: r.detail,
      })),
      methodology,
    });
  } catch {
    return null;
  }
}

export function withWorkingNotes(
  report: AuditReport,
  _markdown: string,
): AuditReport {
  return report;
}
