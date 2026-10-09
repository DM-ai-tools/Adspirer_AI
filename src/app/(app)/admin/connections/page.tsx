import { Suspense } from "react";
import { LoadingState } from "@/components/shared/loading-state";
import ConnectionsPortalPage from "./connections-client";

export default function AdminConnectionsPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading connections…" />}>
      <ConnectionsPortalPage />
    </Suspense>
  );
}
