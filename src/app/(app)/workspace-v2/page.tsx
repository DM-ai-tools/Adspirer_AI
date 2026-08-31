import { Suspense } from "react";
import { LoadingState } from "@/components/shared/loading-state";
import { WorkspaceClient } from "../workspace/workspace-client";

export default function WorkspaceV2Page() {
  return (
    <Suspense fallback={<LoadingState label="Loading workspace…" />}>
      <WorkspaceClient workspaceVersion="v2" />
    </Suspense>
  );
}
