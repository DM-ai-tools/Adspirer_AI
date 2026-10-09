import { Document, Page, View, Text } from "@react-pdf/renderer";
import type { AuditReport } from "@/lib/report/schema";
import { C, S } from "@/lib/report/theme";
import { s } from "@/lib/report/pdf/styles";
import {
  SectionHead,
  Callout,
  DefRows,
  Pill,
  SevChip,
  MarkList,
  Bar,
} from "@/lib/report/pdf/components/atoms";
import { ensureReportFonts } from "@/lib/report/pdf/fonts";

function fmt(iso: string): string {
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

function Footer() {
  return (
    <View style={s.footer} fixed>
      <View style={s.footRule} />
      <View style={s.footRow}>
        <Text>
          <Text style={{ color: C.teal700, fontWeight: 600 }}>Spendsmith</Text>
          {" · Confidential"}
        </Text>
        <Text
          render={({ pageNumber, totalPages }) =>
            `Page ${pageNumber} of ${totalPages}`
          }
        />
      </View>
    </View>
  );
}

export function AuditReportDoc({ r }: { r: AuditReport }) {
  ensureReportFonts();
  const activeCampaigns = r.campaigns.filter((c) => c.status === "ACTIVE");
  const campaignCards =
    activeCampaigns.length > 0 ? activeCampaigns : r.campaigns;

  return (
    <Document
      title={`${r.meta.reportType} — ${r.meta.accountName}`}
      author="Spendsmith"
      subject={`${r.meta.period} · ${r.meta.accountId}`}
    >
      <Page size="A4" style={[s.page, s.pageLead]}>
        <View style={s.masthead}>
          <View>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 7,
                marginBottom: S[5],
              }}
            >
              <Text style={s.logoTile}>✦</Text>
              <Text style={s.wordmark}>SPENDSMITH</Text>
            </View>
            <Text style={s.h1}>{r.meta.reportType}</Text>
            <Text style={s.subtitle}>{r.meta.subtitle}</Text>
            <View
              style={{ flexDirection: "row", gap: 18, marginTop: S[4] }}
            >
              {(
                [
                  ["Account", r.meta.accountName],
                  ["Period", r.meta.period],
                  ["Generated", fmt(r.meta.generatedAt)],
                ] as const
              ).map(([k, v]) => (
                <View key={k}>
                  <Text
                    style={{
                      fontSize: 6,
                      letterSpacing: 0.7,
                      color: C.mastMeta,
                      textTransform: "uppercase",
                    }}
                  >
                    {k}
                  </Text>
                  <Text
                    style={{
                      fontSize: 8.5,
                      color: C.paper,
                      fontWeight: 500,
                      marginTop: 2,
                    }}
                  >
                    {v}
                  </Text>
                </View>
              ))}
            </View>
          </View>
          <View
            style={{
              minWidth: 88,
              alignItems: "center",
              padding: S[3],
              borderRadius: 8,
              backgroundColor: "rgba(45,212,191,0.13)",
              borderWidth: 1,
              borderColor: "rgba(45,212,191,0.34)",
            }}
          >
            <Text
              style={{ fontSize: 22, fontWeight: 600, color: C.teal400 }}
            >
              {r.healthScore ?? "—"}
              <Text style={{ fontSize: 9, color: C.mastMeta }}>/100</Text>
            </Text>
                <Text
                  style={{
                    fontSize: 5.5,
                    letterSpacing: 1,
                    color: C.teal100,
                    marginTop: 5,
                    textTransform: "uppercase",
                    textAlign: "center",
                  }}
                >
                  {r.healthLabel || "Account health"}
                </Text>
                <Text
                  style={{
                    fontSize: 5,
                    letterSpacing: 0.6,
                    color: C.mastMeta,
                    marginTop: 3,
                    textTransform: "uppercase",
                  }}
                >
                  Health score
                </Text>
          </View>
        </View>

        <View style={s.kpiRow}>
          {r.kpis.map((k) => (
            <View key={k.label} style={[s.kpi, k.flag ? s.kpiFlag : {}]}>
              <Text style={[s.kpiLbl, k.flag ? { color: C.med } : {}]}>
                {k.label}
              </Text>
              <Text style={s.kpiVal}>{k.value}</Text>
              {k.note ? <Text style={s.kpiNote}>{k.note}</Text> : null}
            </View>
          ))}
        </View>

        <Callout label="Bottom line">{r.bottomLine}</Callout>

        <View style={{ marginBottom: S[6] }}>
          <SectionHead n="01" kicker="Snapshot" title="Account snapshot" />
          <View style={{ flexDirection: "row", gap: S[6] }}>
            <View style={{ flex: 1 }}>
              <DefRows
                rows={r.snapshot.slice(0, Math.ceil(r.snapshot.length / 2))}
              />
            </View>
            <View style={{ flex: 1 }}>
              <DefRows
                rows={r.snapshot.slice(Math.ceil(r.snapshot.length / 2))}
              />
            </View>
          </View>
        </View>

        <View style={{ marginBottom: S[6] }}>
          <SectionHead
            n="02"
            kicker="Delivery"
            title={`Spend share · ${r.meta.period}`}
            lede="A flat grey bar means the API returned no itemised figure for the period — not that spend was zero."
          />
          {r.campaigns.length === 0 ? (
            <Callout label="Data note" variant="warn">
              No campaigns were available to chart for this period.
            </Callout>
          ) : (
            r.campaigns.map((c) => (
              <Bar
                key={c.id}
                label={c.name}
                pct={c.spendSharePct}
                right={
                  c.spendSharePct === null
                    ? "No itemised spend"
                    : (c.spend ?? "")
                }
              />
            ))
          )}
        </View>

        {r.dataNotes.map((n, i) => (
          <Callout
            key={i}
            label={/^Working:/i.test(n) ? "What's working" : "Data note"}
            variant={/^Working:/i.test(n) ? "brand" : "warn"}
          >
            {n.replace(/^Working:\s*/i, "")}
          </Callout>
        ))}
        <Footer />
      </Page>

      <Page size="A4" style={s.page}>
        <Text style={s.contsig} fixed>
          {r.meta.reportType} · {r.meta.accountName} · continued
        </Text>
        <SectionHead n="03" kicker="Campaigns" title="Campaign detail" />
        {campaignCards.length === 0 ? (
          <Callout label="No campaigns" variant="neutral">
            No campaign cards to show for this account and period.
          </Callout>
        ) : (
          campaignCards.map((c, i) => (
            <View key={c.id} style={s.card} wrap={false}>
              <View style={s.cardHd}>
                <View>
                  <Text style={s.eyebrow}>
                    Campaign {String(i + 1).padStart(2, "0")}
                  </Text>
                  <Text
                    style={{ fontSize: 10, fontWeight: 600, marginTop: 2 }}
                  >
                    {c.name}
                  </Text>
                </View>
                <Pill status={c.status} />
              </View>
              <View style={s.cardBd}>
                <View style={{ flexDirection: "row", gap: S[6] }}>
                  <View style={{ flex: 1 }}>
                    <DefRows
                      rows={[
                        { label: "Campaign ID", value: c.id, mono: true },
                        { label: "Objective", value: c.objective },
                      ]}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <DefRows
                      rows={[
                        {
                          label: "Buying type",
                          value: c.buyingType ?? "—",
                        },
                        {
                          label: "Start date",
                          value: c.startDate
                            ? `${c.startDate}${
                                c.daysLive ? ` · ${c.daysLive} days live` : ""
                              }`
                            : "—",
                        },
                      ]}
                    />
                  </View>
                </View>
                {(c.metrics?.length || c.spend) ? (
                  <>
                    <Text style={s.sublbl}>Performance</Text>
                    <DefRows
                      rows={[
                        ...(c.spend &&
                        !(c.metrics ?? []).some((m) =>
                          /spend/i.test(m.label),
                        )
                          ? [{ label: "Spend", value: c.spend }]
                          : []),
                        ...(c.metrics ?? []),
                      ]}
                    />
                  </>
                ) : null}
                {c.deliverySignals.length ? (
                  <>
                    <Text style={s.sublbl}>Delivery signals</Text>
                    <MarkList items={c.deliverySignals} />
                  </>
                ) : null}
                {c.risks.length ? (
                  <>
                    <Text style={s.sublbl}>Risks</Text>
                    <MarkList items={c.risks} risk />
                  </>
                ) : null}
                {c.checkedAgainst.length ? (
                  <>
                    <Text style={s.sublbl}>Checked against</Text>
                    <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
                      {c.checkedAgainst.map((t) => (
                        <Text key={t} style={s.chip}>
                          {t}
                        </Text>
                      ))}
                    </View>
                  </>
                ) : null}
              </View>
            </View>
          ))
        )}
        <Footer />
      </Page>

      <Page size="A4" style={s.page}>
        <Text style={s.contsig} fixed>
          {r.meta.reportType} · {r.meta.accountName} · continued
        </Text>

        <SectionHead
          n="04"
          kicker="Risk"
          title="Account-wide risk register"
        />
        <View
          style={{
            flexDirection: "row",
            borderBottomWidth: 1.5,
            borderBottomColor: C.teal700,
            paddingBottom: 6,
          }}
        >
          <Text style={[s.eyebrow, { width: "32%" }]}>Risk</Text>
          <Text style={[s.eyebrow, { width: "15%" }]}>Severity</Text>
          <Text style={[s.eyebrow, { flex: 1 }]}>Detail</Text>
        </View>
        {r.risks.length === 0 ? (
          <Callout label="No open risks" variant="neutral">
            No account-wide risks were flagged from the available evidence.
          </Callout>
        ) : (
          r.risks.map((k) => (
            <View
              key={k.title}
              style={{
                flexDirection: "row",
                borderBottomWidth: 1,
                borderBottomColor: C.hair,
                paddingVertical: S[2],
              }}
              wrap={false}
            >
              <View
                style={{
                  width: 3,
                  borderRadius: 2,
                  marginRight: 9,
                  backgroundColor:
                    k.severity === "high"
                      ? C.high
                      : k.severity === "medium"
                        ? C.medFill
                        : C.ink300,
                }}
              />
              <Text style={{ width: "30%", fontSize: 8.5, fontWeight: 600 }}>
                {k.title}
              </Text>
              <View style={{ width: "15%" }}>
                <SevChip level={k.severity} />
              </View>
              <Text
                style={{
                  flex: 1,
                  fontSize: 8,
                  color: C.ink700,
                  lineHeight: 1.45,
                }}
              >
                {k.detail}
              </Text>
            </View>
          ))
        )}

        <View style={{ marginTop: S[6] }}>
          <SectionHead
            n="05"
            kicker="Action"
            title="Prioritised recommendations"
            lede="Ordered by expected impact. Nothing below has been executed."
          />
          {r.recommendations.map((rec, i) => (
            <View key={rec.title} style={s.recRow} wrap={false}>
              <Text style={s.recNum}>{i + 1}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 9.5, fontWeight: 600 }}>
                  {rec.title}
                </Text>
                <Text
                  style={{
                    fontSize: 8,
                    color: C.ink700,
                    marginTop: 3,
                    lineHeight: 1.5,
                  }}
                >
                  {rec.detail}
                </Text>
                <View style={{ flexDirection: "row", marginTop: 5 }}>
                  <Text
                    style={[
                      s.tag,
                      {
                        backgroundColor: C.teal50,
                        borderColor: C.teal100,
                        color: C.teal800,
                      },
                    ]}
                  >
                    {rec.impact} impact
                  </Text>
                  {rec.effort ? <Text style={s.tag}>{rec.effort}</Text> : null}
                  {rec.tags.map((t) => (
                    <Text key={t} style={s.tag}>
                      {t}
                    </Text>
                  ))}
                </View>
              </View>
            </View>
          ))}
        </View>

        <View style={{ marginTop: S[5] }}>
          <Callout label="No changes were made">
            These are advisory findings only. To have Spendsmith execute any of
            them, request the action in chat and it will be queued for your
            approval.
          </Callout>
        </View>
        <Text style={s.disc}>
          <Text style={{ fontWeight: 600, color: C.ink900 }}>
            Methodology.{" "}
          </Text>
          {r.methodology}
        </Text>
        <Footer />
      </Page>
    </Document>
  );
}
