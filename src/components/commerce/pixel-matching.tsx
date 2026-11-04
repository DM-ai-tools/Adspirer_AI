"use client";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CatalogEventMatch } from "@/lib/meta/catalog/types";

const nf = (value: number) => value.toLocaleString("en-US");

export function PixelMatching({ events }: { events: CatalogEventMatch[] }) {
  if (events.length === 0) {
    return (
      <EmptyState
        title="No pixel activity found"
        description="Meta has not reported shopper activity (views, add to carts, purchases) matched to this catalogue."
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        When a shopper views or buys something, your Meta pixel reports it. A match
        means Meta could tie that activity to a product in this catalogue. Low
        matching weakens product ads.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event</TableHead>
              <TableHead className="text-right">Matched</TableHead>
              <TableHead className="text-right">Not matched</TableHead>
              <TableHead className="text-right">Match rate</TableHead>
              <TableHead className="text-right">Matched another catalogue</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((e) => {
              const total = e.matched + e.unmatched;
              const rate = total > 0 ? e.matched / total : null;
              return (
                <TableRow key={`${e.event}:${e.pixelId ?? ""}`}>
                  <TableCell className="font-medium">{e.event}</TableCell>
                  <TableCell className="text-right font-mono">{nf(e.matched)}</TableCell>
                  <TableCell className="text-right font-mono">{nf(e.unmatched)}</TableCell>
                  <TableCell className="text-right">
                    {rate === null ? (
                      "—"
                    ) : (
                      <Badge variant={rate < 0.9 ? "warning" : "success"}>
                        {(rate * 100).toFixed(1)}%
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {nf(e.matchedOtherCatalogs)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
