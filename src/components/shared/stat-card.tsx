import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: LucideIcon;
  tone?: "default" | "accent" | "warning" | "danger" | "success";
  className?: string;
}) {
  const toneClass = {
    default: "text-foreground",
    accent: "text-accent",
    warning: "text-warning",
    danger: "text-danger",
    success: "text-success",
  }[tone];

  const iconTone = {
    default: "bg-secondary text-muted",
    accent: "bg-accent-muted text-accent",
    warning: "bg-warning-muted text-warning",
    danger: "bg-danger-muted text-danger",
    success: "bg-success-muted text-success",
  }[tone];

  return (
    <Card className={cn("bg-card/80", className)}>
      <CardContent className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            {label}
          </p>
          <p className={cn("mt-1 font-mono text-2xl font-semibold tabular-nums", toneClass)}>
            {value}
          </p>
          {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
        </div>
        {Icon ? (
          <div
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
              iconTone,
            )}
          >
            <Icon className="h-4 w-4" />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
