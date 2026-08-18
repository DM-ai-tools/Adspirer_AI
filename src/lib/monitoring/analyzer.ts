import type { MonitoringFinding, MonitoringSnapshot } from "@/types";

export type AnomalyAnalysis = {
  findings: MonitoringFinding[];
  summary: string;
};

/**
 * Detect anomalies by comparing the latest snapshot to a baseline snapshot.
 * Produces findings only — never mutates campaigns/budgets.
 */
export function analyzeSnapshots(input: {
  current: MonitoringSnapshot;
  baseline?: MonitoringSnapshot | null;
}): AnomalyAnalysis {
  const findings: MonitoringFinding[] = [];
  const current = input.current.metrics;
  const baseline = input.baseline?.metrics ?? null;

  const checkIncrease = (
    key: string,
    title: string,
    thresholdPct: number,
    severity: MonitoringFinding["severity"],
  ) => {
    if (!baseline || baseline[key] == null || current[key] == null) return;
    const base = baseline[key];
    const value = current[key];
    if (base <= 0) return;
    const deltaPct = ((value - base) / base) * 100;
    if (deltaPct >= thresholdPct) {
      findings.push({
        code: `${key.toUpperCase()}_UP`,
        severity,
        title,
        detail: `${key} rose ${deltaPct.toFixed(1)}% vs baseline (${base} → ${value}).`,
        metric_key: key,
        metric_value: value,
        baseline_value: base,
      });
    }
  };

  const checkDecrease = (
    key: string,
    title: string,
    thresholdPct: number,
    severity: MonitoringFinding["severity"],
  ) => {
    if (!baseline || baseline[key] == null || current[key] == null) return;
    const base = baseline[key];
    const value = current[key];
    if (base <= 0) return;
    const deltaPct = ((base - value) / base) * 100;
    if (deltaPct >= thresholdPct) {
      findings.push({
        code: `${key.toUpperCase()}_DOWN`,
        severity,
        title,
        detail: `${key} fell ${deltaPct.toFixed(1)}% vs baseline (${base} → ${value}).`,
        metric_key: key,
        metric_value: value,
        baseline_value: base,
      });
    }
  };

  checkIncrease("cpl", "CPL above baseline", 15, "warning");
  checkIncrease("cpc", "CPC above baseline", 20, "warning");
  checkIncrease("frequency", "Frequency elevated", 25, "info");
  checkDecrease("ctr", "CTR declined", 15, "warning");
  checkDecrease("leads", "Lead volume declined", 20, "critical");
  checkIncrease("spend", "Spend spike", 40, "info");

  if (current.frequency != null && current.frequency >= 3.5) {
    findings.push({
      code: "FREQUENCY_HIGH",
      severity: "warning",
      title: "High frequency risk",
      detail: `Frequency is ${current.frequency}. Consider creative refresh (no auto-pause).`,
      metric_key: "frequency",
      metric_value: current.frequency,
    });
  }

  // Preserve any precomputed findings on the snapshot without mutating ads.
  if (input.current.findings?.length) {
    for (const existing of input.current.findings) {
      if (!findings.some((f) => f.code === existing.code)) {
        findings.push(existing);
      }
    }
  }

  const summary = findings.length
    ? `Detected ${findings.length} finding(s). No automatic mutations applied.`
    : "No anomalies detected. No automatic mutations applied.";

  return { findings, summary };
}
