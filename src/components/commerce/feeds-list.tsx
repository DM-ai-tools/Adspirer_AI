"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { formatRelative } from "@/lib/api-client";
import type { CatalogFeed } from "@/lib/meta/catalog/types";

const nf = (value: number) => value.toLocaleString("en-US");

export function FeedsList({ feeds }: { feeds: CatalogFeed[] }) {
  if (feeds.length === 0) {
    return (
      <EmptyState
        title="No feeds"
        description="A feed is the file or link Meta reads to keep your products up to date. This catalogue has none, so products are added by hand or through an integration."
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        A feed is the product list Meta re-reads on a schedule. A stale feed means
        prices and stock in your ads can be out of date.
      </p>
      {feeds.map((feed) => {
        const upload = feed.lastUpload;
        const errors = upload ? upload.errorCount : 0;
        return (
          <Card key={feed.id}>
            <CardContent className="space-y-2 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-sm font-medium">{feed.name}</p>
                {upload ? (
                  <Badge variant={errors > 0 ? "danger" : "success"}>
                    {errors > 0 ? `${nf(errors)} upload errors` : "Last upload OK"}
                  </Badge>
                ) : (
                  <Badge variant="muted">No upload yet</Badge>
                )}
              </div>
              <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <dt className="text-muted">Products</dt>
                  <dd className="font-mono text-sm">{nf(feed.productCount)}</dd>
                </div>
                <div>
                  <dt className="text-muted">Schedule</dt>
                  <dd className="text-sm">
                    {feed.scheduleInterval
                      ? feed.scheduleInterval.toLowerCase()
                      : "Not scheduled"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Last upload</dt>
                  <dd className="text-sm">{formatRelative(upload?.endTime)}</dd>
                </div>
                <div>
                  <dt className="text-muted">Warnings</dt>
                  <dd className="text-sm">{upload ? nf(upload.warningCount) : "—"}</dd>
                </div>
              </dl>
              {feed.scheduleUrl ? (
                <p className="truncate text-xs text-muted" title={feed.scheduleUrl}>
                  Reads from {feed.scheduleUrl}
                </p>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
