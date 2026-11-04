"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import type { ClientCatalogUse } from "@/lib/meta/catalog/service";
import type { LearningLink } from "@/lib/meta/catalog/findings";
import type { CatalogProductSet } from "@/lib/meta/catalog/types";

const nf = (value: number) => value.toLocaleString("en-US");

const LEARNING: Record<
  "LEARNING" | "SUCCESS" | "FAIL" | "UNKNOWN",
  { label: string; variant: "warning" | "success" | "danger" | "muted"; help: string }
> = {
  LEARNING: {
    label: "Learning",
    variant: "warning",
    help: "Meta is still working out who to show this ad to.",
  },
  SUCCESS: {
    label: "Learning done",
    variant: "success",
    help: "Meta has finished learning for this ad set.",
  },
  FAIL: {
    label: "Learning limited",
    variant: "danger",
    help: "Meta could not finish learning, so delivery may be weak.",
  },
  UNKNOWN: {
    label: "Unknown",
    variant: "muted",
    help: "Meta has not reported a learning status.",
  },
};

export function ProductSetsList({
  productSets,
  uses,
  learningLinks,
}: {
  productSets: CatalogProductSet[];
  uses: ClientCatalogUse[];
  learningLinks: LearningLink[];
}) {
  if (productSets.length === 0) {
    return (
      <EmptyState
        title="No product sets"
        description="Product sets are groups of products you choose to advertise together. None are in use yet."
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        A product set is a group of products an ad set sells. Too few in-stock
        products in a set can keep its ads in learning.
      </p>
      {productSets.map((set) => {
        const setUses = uses.filter((u) => u.productSetId === set.id);
        return (
          <Card key={set.id}>
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-sm font-medium">{set.name}</p>
                <div className="flex gap-4 text-xs text-muted">
                  <span>
                    <span className="font-mono text-sm text-foreground">
                      {nf(set.productCount)}
                    </span>{" "}
                    products
                  </span>
                  <span>
                    <span className="font-mono text-sm text-foreground">
                      {set.inStockCount === null ? "—" : nf(set.inStockCount)}
                    </span>{" "}
                    in stock
                  </span>
                </div>
              </div>
              {set.inStockCount === null ? (
                <p className="text-xs text-muted">
                  Stock is only counted for sets that ads are using.
                </p>
              ) : null}
              {setUses.length === 0 ? (
                <p className="text-xs text-muted">No ad sets use this product set.</p>
              ) : (
                <ul className="space-y-2">
                  {setUses.map((use) => {
                    const learning = LEARNING[use.learningStatus ?? "UNKNOWN"];
                    const link = learningLinks.find(
                      (l) => l.adSetId === use.adSetId && l.productSetId === set.id,
                    );
                    return (
                      <li
                        key={use.adSetId}
                        className="rounded-md border border-border bg-secondary/20 p-2.5"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm">{use.adSetName}</span>
                          <div className="flex items-center gap-2">
                            {link?.verdict === "likely_contributor" ? (
                              <Badge variant="warning">Catalogue may be the cause</Badge>
                            ) : null}
                            <span title={learning.help}>
                              <Badge variant={learning.variant}>{learning.label}</Badge>
                            </span>
                          </div>
                        </div>
                        {link?.verdict === "likely_contributor" &&
                        link.reasons.length > 0 ? (
                          <ul className="mt-1.5 space-y-0.5 text-xs text-muted">
                            {link.reasons.map((reason, i) => (
                              <li key={i} className="ml-4 list-disc">
                                {reason}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
