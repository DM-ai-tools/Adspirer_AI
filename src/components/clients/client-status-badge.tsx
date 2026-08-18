import type { AccessStatus } from "@/types";
import { Badge } from "@/components/ui/badge";

const STATUS_LABEL: Record<AccessStatus, string> = {
  not_requested: "Not requested",
  requested: "Access pending",
  granted: "Connected",
  stale: "Stale access",
  revoked: "Revoked",
};

const STATUS_VARIANT: Record<
  AccessStatus,
  "default" | "secondary" | "outline" | "success" | "warning" | "danger" | "muted"
> = {
  not_requested: "muted",
  requested: "warning",
  granted: "success",
  stale: "danger",
  revoked: "danger",
};

export function ClientStatusBadge({
  status,
  className,
}: {
  status: AccessStatus | "needs_attention" | "not_connected";
  className?: string;
}) {
  if (status === "needs_attention") {
    return (
      <Badge variant="warning" className={className}>
        Needs attention
      </Badge>
    );
  }
  if (status === "not_connected") {
    return (
      <Badge variant="muted" className={className}>
        Not connected
      </Badge>
    );
  }

  return (
    <Badge variant={STATUS_VARIANT[status]} className={className}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}
