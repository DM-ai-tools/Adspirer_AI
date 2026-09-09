import { View, Text } from "@react-pdf/renderer";
import { C, S } from "@/lib/report/theme";
import { s } from "@/lib/report/pdf/styles";
import type { AuditReport } from "@/lib/report/schema";

type Bullet = AuditReport["campaigns"][number]["deliverySignals"][number];

export function SectionHead({
  n,
  kicker,
  title,
  lede,
}: {
  n: string;
  kicker: string;
  title: string;
  lede?: string;
}) {
  return (
    <View style={{ marginBottom: S[3] }} minPresenceAhead={70}>
      <Text style={s.eyebrow}>
        {n} — {kicker}
      </Text>
      <Text style={s.h2}>{title}</Text>
      <View style={s.secRule} />
      {lede ? (
        <Text
          style={{
            fontSize: 8,
            color: C.ink500,
            marginTop: S[2],
            maxWidth: "74%",
          }}
        >
          {lede}
        </Text>
      ) : null}
    </View>
  );
}

const CALLOUT = {
  brand: { rail: C.teal400, bg: C.teal50, ink: C.teal700 },
  warn: { rail: C.medFill, bg: C.medBg, ink: C.med },
  neutral: { rail: C.ink300, bg: C.paper2, ink: C.ink500 },
} as const;

export function Callout({
  label,
  children,
  variant = "brand",
}: {
  label?: string;
  children: string;
  variant?: keyof typeof CALLOUT;
}) {
  const v = CALLOUT[variant];
  return (
    <View
      style={[s.callout, { borderLeftColor: v.rail, backgroundColor: v.bg }]}
      wrap={false}
    >
      {label ? (
        <Text style={[s.calloutLbl, { color: v.ink }]}>{label}</Text>
      ) : null}
      <Text style={{ lineHeight: 1.55 }}>{children}</Text>
    </View>
  );
}

export function DefRows({
  rows,
}: {
  rows: { label: string; value: string; mono?: boolean }[];
}) {
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: C.hair }}>
      {rows.map((r) => (
        <View key={r.label} style={s.defRow}>
          <Text style={s.defLbl}>{r.label}</Text>
          <Text style={[s.defVal, r.mono ? s.mono : {}]}>{r.value}</Text>
        </View>
      ))}
    </View>
  );
}

const PILL = {
  ACTIVE: { bg: C.okBg, fg: C.ok, bd: C.okBorder },
  PAUSED: { bg: C.lowBg, fg: C.low, bd: C.pausedBorder },
  ARCHIVED: { bg: C.lowBg, fg: C.low, bd: C.pausedBorder },
} as const;

export function Pill({ status }: { status: keyof typeof PILL }) {
  const p = PILL[status];
  return (
    <Text
      style={[
        s.pill,
        { backgroundColor: p.bg, color: p.fg, borderColor: p.bd },
      ]}
    >
      {status}
    </Text>
  );
}

const SEV = {
  high: [C.highBg, C.high],
  medium: [C.medBg, C.med],
  low: [C.lowBg, C.low],
} as const;

export function SevChip({ level }: { level: keyof typeof SEV }) {
  return (
    <Text
      style={[
        s.sev,
        { backgroundColor: SEV[level][0], color: SEV[level][1] },
      ]}
    >
      {level}
    </Text>
  );
}

export function MarkList({
  items,
  risk = false,
}: {
  items: Bullet[];
  risk?: boolean;
}) {
  return (
    <View>
      {items.map((b, i) => (
        <View key={`${b.lead}-${i}`} style={s.bullet}>
          <View
            style={[
              s.dot,
              {
                backgroundColor: risk
                  ? b.severity === "high"
                    ? C.high
                    : C.medFill
                  : C.teal400,
              },
            ]}
          />
          <Text
            style={{
              flex: 1,
              fontSize: 8.5,
              lineHeight: 1.5,
              color: C.ink700,
            }}
          >
            <Text style={{ fontWeight: 600, color: C.ink900 }}>{b.lead}</Text>
            {b.body ? ` — ${b.body}` : ""}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function Bar({
  label,
  right,
  pct,
}: {
  label: string;
  right: string;
  pct: number | null;
}) {
  return (
    <View style={{ marginBottom: S[2] + 2 }} wrap={false}>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <Text style={{ fontSize: 8, fontWeight: 500 }}>{label}</Text>
        <Text style={{ fontSize: 8, color: C.ink500 }}>{right}</Text>
      </View>
      <View
        style={{
          height: 6,
          borderRadius: 3,
          backgroundColor: C.barTrack,
          overflow: "hidden",
        }}
      >
        {pct === null ? (
          <View
            style={{ height: 6, width: "100%", backgroundColor: C.noDataBar }}
          />
        ) : (
          <View
            style={{
              height: 6,
              width: `${Math.max(pct, 1)}%`,
              borderRadius: 3,
              backgroundColor: C.teal600,
            }}
          />
        )}
      </View>
    </View>
  );
}
