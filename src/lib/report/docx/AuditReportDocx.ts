import type { AuditReport } from "@/lib/report/schema";
import { C } from "@/lib/report/theme";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

/** Word-compatible HTML (.doc) from the structured audit report. */
export function renderAuditReportDocxHtml(r: AuditReport): string {
  const kpiCells = r.kpis
    .map(
      (k) => `
      <td style="width:25%;border:1px solid ${C.hair};background:${k.flag ? C.medBg : C.paper2};padding:10px;vertical-align:top;">
        <div style="font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${k.flag ? C.med : C.teal700};">${esc(k.label)}</div>
        <div style="font-size:20px;font-weight:600;color:${C.ink900};margin-top:6px;">${esc(k.value)}</div>
        ${k.note ? `<div style="font-size:10px;color:${C.ink500};margin-top:4px;">${esc(k.note)}</div>` : ""}
      </td>`,
    )
    .join("");

  const snapshotRows = r.snapshot
    .map(
      (row) => `
      <tr>
        <td style="width:34%;padding:8px 0;border-bottom:1px solid ${C.hair};font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${C.ink500};">${esc(row.label)}</td>
        <td style="padding:8px 0;border-bottom:1px solid ${C.hair};font-size:12px;color:${C.ink900};font-family:${row.mono ? "Consolas,monospace" : "Calibri,Arial,sans-serif"};">${esc(row.value)}</td>
      </tr>`,
    )
    .join("");

  const campaignBlocks = r.campaigns
    .map((c, i) => {
      const signals = c.deliverySignals
        .map(
          (b) =>
            `<li><strong>${esc(b.lead)}</strong> — ${esc(b.body)}</li>`,
        )
        .join("");
      const risks = c.risks
        .map(
          (b) =>
            `<li><strong>${esc(b.lead)}</strong> — ${esc(b.body)}</li>`,
        )
        .join("");
      return `
      <div style="border:1px solid ${C.hair};border-radius:8px;margin:16px 0;overflow:hidden;">
        <div style="background:${C.paper2};padding:12px 14px;border-bottom:1px solid ${C.hair};">
          <div style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${C.teal700};">Campaign ${String(i + 1).padStart(2, "0")}</div>
          <div style="font-size:14px;font-weight:600;color:${C.ink900};margin-top:4px;">${esc(c.name)}
            <span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;background:${c.status === "ACTIVE" ? C.okBg : C.lowBg};color:${c.status === "ACTIVE" ? C.ok : C.low};">${c.status}</span>
          </div>
        </div>
        <div style="padding:12px 14px;font-size:12px;color:${C.ink700};">
          <p><strong>ID:</strong> <code>${esc(c.id)}</code> · <strong>Objective:</strong> ${esc(c.objective)}</p>
          ${
            (c.metrics?.length || c.spend)
              ? `<table style="width:100%;border-collapse:collapse;margin:8px 0;">${[
                  ...(c.spend
                    ? [{ label: "Spend", value: c.spend }]
                    : []),
                  ...(c.metrics ?? []),
                ]
                  .map(
                    (row) =>
                      `<tr><td style="width:34%;padding:4px 0;border-bottom:1px solid ${C.hair};font-size:10px;text-transform:uppercase;color:${C.ink500};">${esc(row.label)}</td><td style="padding:4px 0;border-bottom:1px solid ${C.hair};">${esc(row.value)}</td></tr>`,
                  )
                  .join("")}</table>`
              : ""
          }
          ${signals ? `<p style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.ink500};">Delivery signals</p><ul>${signals}</ul>` : ""}
          ${risks ? `<p style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.ink500};">Risks</p><ul>${risks}</ul>` : ""}
        </div>
      </div>`;
    })
    .join("");

  const riskRows = r.risks
    .map((risk) => {
      const bg =
        risk.severity === "high"
          ? C.highBg
          : risk.severity === "medium"
            ? C.medBg
            : C.lowBg;
      const fg =
        risk.severity === "high"
          ? C.high
          : risk.severity === "medium"
            ? C.med
            : C.low;
      return `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid ${C.hair};font-weight:600;width:28%;">${esc(risk.title)}</td>
        <td style="padding:10px 0;border-bottom:1px solid ${C.hair};width:14%;"><span style="background:${bg};color:${fg};padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;text-transform:uppercase;">${risk.severity}</span></td>
        <td style="padding:10px 0;border-bottom:1px solid ${C.hair};color:${C.ink700};">${esc(risk.detail)}</td>
      </tr>`;
    })
    .join("");

  const recs = r.recommendations
    .map(
      (rec, i) => `
      <div style="padding:12px 0;border-bottom:1px solid ${C.hair};">
        <div style="display:inline-block;width:22px;height:22px;border-radius:6px;background:${C.teal700};color:#fff;text-align:center;font-weight:600;font-size:12px;line-height:22px;margin-right:8px;">${i + 1}</div>
        <strong style="font-size:13px;color:${C.ink900};">${esc(rec.title)}</strong>
        <div style="margin-top:4px;color:${C.ink700};font-size:12px;">${esc(rec.detail)}</div>
        <div style="margin-top:6px;font-size:10px;color:${C.teal800};">${esc(rec.impact)} impact${rec.effort ? ` · ${esc(rec.effort)}` : ""}</div>
      </div>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<title>${esc(r.meta.reportType)} — ${esc(r.meta.accountName)}</title>
<style>
  body { font-family: Calibri, Arial, sans-serif; color: ${C.ink900}; margin: 0; }
  h1 { color: ${C.paper}; font-size: 22pt; margin: 0; }
  h2 { color: ${C.teal900}; font-size: 14pt; border-bottom: 2pt solid ${C.teal700}; padding-bottom: 4pt; }
</style>
</head>
<body>
  <div style="background:${C.teal900};color:${C.paper};padding:28px 32px;">
    <div style="font-size:10px;letter-spacing:.16em;font-weight:700;color:${C.teal100};">ADSPIRER AI</div>
    <h1 style="margin-top:16px;">${esc(r.meta.reportType)}</h1>
    <div style="color:${C.teal100};margin-top:6px;">${esc(r.meta.subtitle)}</div>
    <div style="margin-top:16px;font-size:12px;color:${C.mastMeta};">
      ${esc(r.meta.accountName)} · ${esc(r.meta.period)} · ${esc(fmtDate(r.meta.generatedAt))}
      · Health ${r.healthScore ?? "—"}/100 (${esc(r.healthLabel)})
    </div>
  </div>

  <div style="padding:24px 32px;">
    <table style="width:100%;border-collapse:separate;border-spacing:8px 0;margin:0 -8px 20px;">
      <tr>${kpiCells}</tr>
    </table>

    <div style="border-left:4px solid ${C.teal400};background:${C.teal50};padding:14px 16px;margin-bottom:24px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${C.teal700};margin-bottom:6px;">Bottom line</div>
      <div style="font-size:13px;line-height:1.5;">${esc(r.bottomLine)}</div>
    </div>

    <h2>01 — Account snapshot</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">${snapshotRows}</table>

    <h2>03 — Campaign detail</h2>
    ${campaignBlocks || `<p style="color:${C.ink500};">No campaigns in evidence.</p>`}

    <h2>04 — Risk register</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tr>
        <th align="left" style="border-bottom:2px solid ${C.teal700};font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:${C.teal700};padding-bottom:6px;">Risk</th>
        <th align="left" style="border-bottom:2px solid ${C.teal700};font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:${C.teal700};padding-bottom:6px;">Severity</th>
        <th align="left" style="border-bottom:2px solid ${C.teal700};font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:${C.teal700};padding-bottom:6px;">Detail</th>
      </tr>
      ${riskRows || `<tr><td colspan="3" style="padding:10px 0;color:${C.ink500};">No account-wide risks flagged.</td></tr>`}
    </table>

    <h2>05 — Prioritised recommendations</h2>
    ${recs || `<p style="color:${C.ink500};">No recommendations.</p>`}

    <div style="border-left:4px solid ${C.teal400};background:${C.teal50};padding:14px 16px;margin:24px 0;">
      <div style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${C.teal700};margin-bottom:6px;">No changes were made</div>
      <div>These are advisory findings only. Request execution in chat to queue Approvals.</div>
    </div>

    <p style="font-size:11px;color:${C.ink500};border-top:1px solid ${C.hair};padding-top:12px;">
      <strong style="color:${C.ink900};">Methodology.</strong> ${esc(r.methodology)}
    </p>
    <p style="font-size:10px;color:${C.ink500};letter-spacing:.08em;text-transform:uppercase;">Adspirer AI · Confidential</p>
  </div>
</body>
</html>`;
}
