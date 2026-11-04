"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { apiFetch } from "@/lib/api-client";
import type { CatalogProductsResult } from "@/lib/meta/catalog/service";
import type { CatalogProduct, CatalogProductIssue } from "@/lib/meta/catalog/types";

type Filter = "all" | CatalogProductIssue;

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All products" },
  { value: "out_of_stock", label: "Out of stock" },
  { value: "rejected", label: "Rejected by Meta" },
  { value: "any_error", label: "Any problem" },
];

function availabilityBadge(availability: string | null) {
  if (!availability) return <Badge variant="muted">Unknown</Badge>;
  const inStock = availability.toLowerCase() === "in stock";
  return <Badge variant={inStock ? "success" : "warning"}>{availability}</Badge>;
}

export function ProductsTable({
  clientId,
  catalogId,
}: {
  clientId: string;
  catalogId: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [reloadKey, setReloadKey] = useState(0);
  // Results carry the key they were fetched for, so a stale page (older filter, client or
  // catalogue) is ignored instead of needing a reset inside the effect.
  const [result, setResult] = useState<{
    key: string;
    products: CatalogProduct[];
    next: string | null;
    failure: string | null;
    error: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const key = `${clientId}:${catalogId}:${filter}:${reloadKey}`;
  const keyRef = useRef(key);
  useEffect(() => {
    keyRef.current = key;
  }, [key]);

  const fetchPage = useCallback(
    async (after: string | null) => {
      const params = new URLSearchParams({ clientId });
      if (filter !== "all") params.set("issue", filter);
      if (after) params.set("after", after);
      return apiFetch<CatalogProductsResult>(
        `/api/commerce/${encodeURIComponent(catalogId)}/products?${params}`,
      );
    },
    [clientId, catalogId, filter],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchPage(null);
        if (cancelled) return;
        setResult(
          data.state === "ok"
            ? { key, products: data.products, next: data.next, failure: null, error: null }
            : { key, products: [], next: null, failure: data.message, error: null },
        );
      } catch (err) {
        if (cancelled) return;
        setResult({
          key,
          products: [],
          next: null,
          failure: null,
          error: err instanceof Error ? err.message : "Could not load products",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchPage, key]);

  const current = result?.key === key ? result : null;
  const loading = current === null;
  const products = current?.products ?? [];
  const next = current?.next ?? null;
  const error = current?.error ?? null;
  const failure = current?.failure ?? null;

  async function loadMore() {
    if (!next) return;
    const requestKey = key;
    setLoadingMore(true);
    try {
      const data = await fetchPage(next);
      if (keyRef.current !== requestKey) return;
      if (data.state === "ok") {
        setResult((prev) =>
          prev && prev.key === requestKey
            ? { ...prev, products: [...prev.products, ...data.products], next: data.next }
            : prev,
        );
      } else {
        toast.error(data.message);
      }
    } catch (err) {
      if (keyRef.current === requestKey) {
        toast.error(err instanceof Error ? err.message : "Could not load more products");
      }
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          Browse the products in this catalogue, or narrow to the ones with problems.
        </p>
        <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <SelectTrigger className="h-8 w-[200px] text-xs" aria-label="Show products">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error ? (
        <ErrorState
          title="Could not load products"
          description={error}
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      ) : failure ? (
        <EmptyState title="Products unavailable" description={failure} />
      ) : loading ? (
        <div className="flex min-h-[120px] items-center justify-center text-muted">
          <Loader2 className="h-5 w-5 animate-spin text-accent" />
        </div>
      ) : products.length === 0 ? (
        <EmptyState
          title="No products found"
          description={
            filter === "all"
              ? "This catalogue has no products."
              : "No products match this filter in the part of the catalogue we checked."
          }
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Stock</TableHead>
                  <TableHead>Meta review</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Problems</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <div className="text-sm font-medium">
                        {p.url ? (
                          <a
                            href={p.url}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:underline"
                          >
                            {p.name ?? p.retailerId}
                          </a>
                        ) : (
                          (p.name ?? p.retailerId)
                        )}
                      </div>
                      <div className="font-mono text-xs text-muted">{p.retailerId}</div>
                    </TableCell>
                    <TableCell>{availabilityBadge(p.availability)}</TableCell>
                    <TableCell className="text-sm">{p.reviewStatus ?? "—"}</TableCell>
                    <TableCell className="text-sm">{p.price ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted">
                      {p.errors.length === 0
                        ? "None"
                        : p.errors.map((e) => e.title).join("; ")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {next ? (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                Load more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
