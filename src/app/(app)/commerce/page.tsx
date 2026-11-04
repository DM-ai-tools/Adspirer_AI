"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, MessageSquare, ShoppingBag } from "lucide-react";
import { useApp } from "@/components/layout/app-provider";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingState } from "@/components/shared/loading-state";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CommerceOverview, type OkReport } from "@/components/commerce/commerce-overview";
import { ProductsTable } from "@/components/commerce/products-table";
import { FeedsList } from "@/components/commerce/feeds-list";
import { ProductSetsList } from "@/components/commerce/product-sets-list";
import { PixelMatching } from "@/components/commerce/pixel-matching";
import { apiFetch } from "@/lib/api-client";
import type { CatalogReport, CommerceState } from "@/lib/meta/catalog/service";

const RECONNECT_URL = "/api/auth/meta?returnTo=/commerce";

type Failure = Exclude<CommerceState, { state: "ok" }>;

/** Explains a failure state; permission and connection problems get a reconnect button. */
function FailureNotice({ failure }: { failure: Failure | Exclude<CatalogReport, { state: "ok" }> }) {
  const reconnect = failure.state === "missing_permission" || failure.state === "not_connected";
  const title = {
    not_connected: "Facebook is not connected",
    missing_permission: "Catalogue access is needed",
    no_ad_account: "No ad account for this client",
    no_catalog: "No catalogue found",
  }[failure.state];
  return (
    <EmptyState
      icon={ShoppingBag}
      title={title}
      description={failure.message}
      action={
        reconnect ? (
          <Button asChild>
            <a href={RECONNECT_URL}>Reconnect Facebook</a>
          </Button>
        ) : undefined
      }
    />
  );
}

export default function CommercePage() {
  const { clients, selectedClientId, setSelectedClientId } = useApp();
  const client = clients.find((c) => c.id === selectedClientId);

  const [reloadKey, setReloadKey] = useState(0);
  const retry = useCallback(() => setReloadKey((k) => k + 1), []);
  const [pickedCatalogId, setPickedCatalogId] = useState<string | null>(null);

  // Each result carries the key it was fetched for, so a stale response (another client,
  // catalogue or retry) is ignored without resetting state inside the effect.
  const commerceKey = selectedClientId ? `${selectedClientId}:${reloadKey}` : null;
  const [commerceResult, setCommerceResult] = useState<{
    key: string;
    data: CommerceState | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!selectedClientId || !commerceKey) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await apiFetch<CommerceState>(
          `/api/commerce?clientId=${encodeURIComponent(selectedClientId)}`,
        );
        if (!cancelled) setCommerceResult({ key: commerceKey, data, error: null });
      } catch (err) {
        if (!cancelled) {
          setCommerceResult({
            key: commerceKey,
            data: null,
            error: err instanceof Error ? err.message : "Could not load catalogues",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedClientId, commerceKey]);

  const commerceNow = commerceResult?.key === commerceKey ? commerceResult : null;
  const commerce = commerceNow?.data ?? null;
  const commerceError = commerceNow?.error ?? null;
  const catalogs = commerce?.state === "ok" ? commerce.catalogs : [];
  const catalogId =
    catalogs.find((c) => c.id === pickedCatalogId)?.id ?? catalogs[0]?.id ?? null;

  const reportKey =
    selectedClientId && catalogId ? `${selectedClientId}:${catalogId}:${reloadKey}` : null;
  const [reportResult, setReportResult] = useState<{
    key: string;
    data: CatalogReport | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!selectedClientId || !catalogId || !reportKey) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await apiFetch<CatalogReport>(
          `/api/commerce/${encodeURIComponent(catalogId)}?clientId=${encodeURIComponent(selectedClientId)}`,
        );
        if (!cancelled) setReportResult({ key: reportKey, data, error: null });
      } catch (err) {
        if (!cancelled) {
          setReportResult({
            key: reportKey,
            data: null,
            error: err instanceof Error ? err.message : "Could not load the catalogue report",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedClientId, catalogId, reportKey]);

  const reportNow = reportResult?.key === reportKey ? reportResult : null;
  const report = reportNow?.data ?? null;
  const reportError = reportNow?.error ?? null;
  const catalog = catalogs.find((c) => c.id === catalogId);
  const askPrompt = catalog
    ? `Look at my "${catalog.name}" catalogue (id ${catalog.id}). Why might products not be showing or ads stuck in learning, and what should I fix first?`
    : "";
  const askHref =
    selectedClientId && askPrompt
      ? `/workspace?clientId=${encodeURIComponent(selectedClientId)}&prompt=${encodeURIComponent(askPrompt)}`
      : selectedClientId
        ? `/workspace?clientId=${encodeURIComponent(selectedClientId)}`
        : "/workspace";

  function renderBody() {
    if (!client || !selectedClientId) {
      return (
        <EmptyState
          icon={ShoppingBag}
          title="Select a client"
          description="Choose a client to see the health of the product catalogues they advertise from."
        />
      );
    }
    if (commerceError) {
      return <ErrorState title="Could not load catalogues" description={commerceError} onRetry={retry} />;
    }
    if (!commerce) return <LoadingState label="Loading catalogues…" />;
    if (commerce.state !== "ok") return <FailureNotice failure={commerce} />;
    if (!catalogId) {
      return (
        <FailureNotice
          failure={{ state: "no_catalog", message: "No catalogue is linked to this client's ad accounts." }}
        />
      );
    }
    if (reportError) {
      return <ErrorState title="Could not load this catalogue" description={reportError} onRetry={retry} />;
    }
    if (!report) return <LoadingState label="Reading the catalogue from Meta…" />;
    if (report.state !== "ok") return <FailureNotice failure={report} />;

    const ok: OkReport = report;
    return (
      <div className="space-y-4">
        {ok.snapshot.warnings.length > 0 ? (
          <div className="flex gap-2 rounded-lg border border-warning/30 bg-warning-muted p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div>
              <p className="font-medium">Some information could not be loaded</p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted">
                {ok.snapshot.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        <Tabs defaultValue="overview">
          <TabsList className="h-auto flex-wrap">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="products">Products</TabsTrigger>
            <TabsTrigger value="feeds">Feeds</TabsTrigger>
            <TabsTrigger value="sets">Product sets</TabsTrigger>
            <TabsTrigger value="pixel">Pixel matching</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <CommerceOverview report={ok} clientId={selectedClientId} catalogId={catalogId} />
          </TabsContent>
          <TabsContent value="products">
            <ProductsTable clientId={selectedClientId} catalogId={catalogId} />
          </TabsContent>
          <TabsContent value="feeds">
            <FeedsList feeds={ok.snapshot.feeds} />
          </TabsContent>
          <TabsContent value="sets">
            <ProductSetsList
              productSets={ok.snapshot.productSets}
              uses={ok.uses}
              learningLinks={ok.learningLinks}
            />
          </TabsContent>
          <TabsContent value="pixel">
            <PixelMatching events={ok.snapshot.events} pixelIds={ok.snapshot.pixelIds} />
          </TabsContent>
        </Tabs>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Commerce"
        description="Check that your product catalogue is healthy, so Meta can show your products in ads."
        actions={
          <>
            <Select value={selectedClientId ?? ""} onValueChange={setSelectedClientId}>
              <SelectTrigger className="w-[200px]" aria-label="Client">
                <SelectValue placeholder="Select client" />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {catalogs.length > 0 ? (
              <Select value={catalogId ?? undefined} onValueChange={setPickedCatalogId}>
                <SelectTrigger className="w-[240px]" aria-label="Catalogue">
                  <SelectValue placeholder="Select catalogue" />
                </SelectTrigger>
                <SelectContent>
                  {catalogs.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {selectedClientId ? (
              <Button variant="secondary" asChild>
                <Link href={askHref}>
                  <MessageSquare className="mr-2 h-4 w-4" />
                  Ask in Workspace
                </Link>
              </Button>
            ) : null}
          </>
        }
      />
      {renderBody()}
    </div>
  );
}
