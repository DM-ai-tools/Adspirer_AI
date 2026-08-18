import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

export function LoadingState({
  label = "Loading…",
  className,
  skeleton,
}: {
  label?: string;
  className?: string;
  skeleton?: boolean;
}) {
  if (skeleton) {
    return (
      <div className={cn("space-y-3", className)}>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex min-h-[180px] flex-col items-center justify-center gap-3 text-muted",
        className,
      )}
    >
      <Loader2 className="h-5 w-5 animate-spin text-accent" />
      <p className="text-sm">{label}</p>
    </div>
  );
}
