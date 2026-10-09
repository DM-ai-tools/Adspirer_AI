import { Suspense } from "react";
import { LoadingState } from "@/components/shared/loading-state";
import { WorkspaceClient } from "./workspace-client";

export default function WorkspacePage() {
  return (
    <Suspense fallback={<LoadingState label="Loading workspace…" />}>
      <WorkspaceClient />
    </Suspense>
  );
}
