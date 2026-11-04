"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatCard } from "@/components/shared/stat-card";
import { apiFetch } from "@/lib/api-client";
import type { CatalogFinding } from "@/lib/meta/catalog/findings";
import type { CatalogReport } from "@/lib/meta/catalog/service";

export type OkReport = Extract<CatalogReport, { state: "ok" }>;

const nf = (value: number) => value.toLocaleString("en-US");

const SEVERITY: Record<
  CatalogFinding["severity"],
  { label: string; variant: "danger" | "warning" | "muted" }
> = {
  critical: { label: "Critical", variant: "danger" },
  high: { label: "High", variant: "danger" },
  medium: { label: "Medium", variant: "warning" },
  low: { label: "Low", variant: "muted" },
};

const FIX_SUMMARY: Record<string, string> = {
  update_product_set_filter: "Limits this product set to products that are in stock.",
  request_feed_refresh: "Asks Meta to re-read your product feed now.",
  pause_adset: "Pauses the ad set until you turn it back on.",
};

/** Products Meta flagged as must-fix, leaving out the out-of-stock ones (they have their own card). */
function rejectedCount(report: OkReport): number {
  let total = 0;
  for (const d of report.snapshot.diagnostics) {
    if (d.severity !== "MUST_FIX") continue;
    const outOfStock = d.children
      .filter((c) => c.type === "PRODUCT_OUT_OF_STOCK")
      .reduce((sum, c) => sum + c.affectedItems, 0);
    total += Math.max(0, d.affectedItems - outOfStock);
  }
  return total;
}

function feedHealth(report: OkReport): {
  value: string;
  hint: string;
  tone: "success" | "warning" | "default";
} {
  const { feeds } = report.snapshot;
  if (feeds.length === 0) {
    return {
      value: "No feed",
      hint: "Products are added by hand or through an integration",
      tone: "default",
    };
  }
  const flagged = report.findings.some((f) => f.id.startsWith("feed_"));
  return flagged
    ? {
        value: "Needs attention",
        hint: "Your product list is stale or has upload errors",
        tone: "warning",
      }
    : {
        value: "Healthy",
        hint: "Your product list is uploading on schedule",
        tone: "success",
      };
}

function matchRate(report: OkReport): number | null {
  let matched = 0;
  let total = 0;
  for (const e of report.snapshot.events) {
    matched += e.matched;
    total += e.matched + e.unmatched;
  }
  return total > 0 ? matched / total : null;
}

export function CommerceOverview({
  report,
  clientId,
  catalogId,
}: {
  report: OkReport;
  clientId: string;
  catalogId: string;
}) {
  const [queueing, setQueueing] = useState<Set<string>>(new Set());
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const { snapshot, findings } = report;

  const feed = feedHealth(report);
  const rate = matchRate(report);
  const rejected = rejectedCount(report);

  async function queueFix(findingId: string) {
    setQueueing((prev) => new Set(prev).add(findingId));
    try {
      const data = await apiFetch<
        { approvalId: string } | { state: string; message: string }
      >("/api/commerce/fixes", {
        method: "POST",
        body: JSON.stringify({ clientId, catalogId, findingId }),
      });
      if ("approvalId" in data) {
        setQueued((prev) => new Set(prev).add(findingId));
        toast.success("Fix queued for approval", {
          description: (
            <Link href="/approvals" className="underline underline-offset-2">
              Review it in Approvals
            </Link>
          ),
        });
      } else {
        toast.error(data.message);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not queue the fix");
    } finally {
      setQueueing((prev) => {
        const next = new Set(prev);
        next.delete(findingId);
        return next;
      });
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          label="Products"
          value={nf(snapshot.productCount)}
          hint="Items in this catalogue"
        />
        <StatCard
          label="Out of stock"
          value={snapshot.outOfStockCount === null ? "—" : nf(snapshot.outOfStockCount)}
          hint={
            snapshot.outOfStockCount === null
              ? "Meta did not return stock figures"
              : "Products Meta won't show in ads"
          }
          tone={snapshot.outOfStockCount ? "warning" : "default"}
        />
        <StatCard
          label="Rejected"
          value={nf(rejected)}
          hint="Products Meta flagged with a problem and may not show"
          tone={rejected > 0 ? "danger" : "default"}
        />
        <StatCard label="Feed" value={feed.value} hint={feed.hint} tone={feed.tone} />
        <StatCard
          label="Match rate"
          value={rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}
          hint="Shopper activity on your site that Meta can tie to a product"
          tone={rate === null ? "default" : rate < 0.9 ? "warning" : "success"}
        />
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Suggestions</h2>
        {findings.length === 0 ? (
          <Card>
            <CardContent className="p-4 text-sm text-muted">
              Nothing to fix. We found no catalogue problems affecting your ads.
            </CardContent>
          </Card>
        ) : (
          findings.map((finding) => {
            const severity = SEVERITY[finding.severity];
            const busy = queueing.has(finding.id);
            const done = queued.has(finding.id);
            return (
              <Card key={finding.id}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-medium">{finding.title}</p>
                    <Badge variant={severity.variant}>{severity.label}</Badge>
                  </div>
                  {finding.evidence.length > 0 ? (
                    <ul className="space-y-1 text-xs text-muted">
                      {finding.evidence.map((line, i) => (
                        <li
                          key={i}
                          className={
                            line.startsWith("  ")
                              ? "ml-8 list-[circle]"
                              : "ml-4 list-disc"
                          }
                        >
                          {line.trim()}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted">
                      How to fix
                    </p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {finding.howToFix}
                    </p>
                  </div>
                  {finding.fix ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy || done}
                        onClick={() => void queueFix(finding.id)}
                      >
                        {busy ? (
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                        )}
                        {done ? "Queued" : "Queue fix"}
                      </Button>
                      <span className="text-xs text-muted">
                        {FIX_SUMMARY[finding.fix.toolName] ?? ""} Nothing changes
                        until you approve it.
                      </span>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
