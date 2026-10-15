"use client";

import { useState } from "react";
import { CalendarDays } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { differenceInCalendarDays, format, parseISO, subMonths } from "date-fns";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type PickedRange = { since: string; until: string };

/** Same limits as the API: up to a year, within Meta's 37 months, not in the future. */
const MAX_DAYS = 366;

const iso = (d: Date) => format(d, "yyyy-MM-dd");
const label = (d: Date) => format(d, "MMM d, yyyy");

export function CustomRangePicker({
  value,
  active,
  onApply,
}: {
  value: PickedRange | null;
  active: boolean;
  onApply: (range: PickedRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  const today = new Date();
  const oldest = subMonths(today, 37);

  const from = draft?.from;
  const to = draft?.to ?? draft?.from;
  const days = from && to ? differenceInCalendarDays(to, from) + 1 : 0;
  const tooLong = days > MAX_DAYS;

  function onOpenChange(next: boolean) {
    // Start from the applied range each time the calendar opens.
    if (next) setDraft(value ? { from: parseISO(value.since), to: parseISO(value.until) } : undefined);
    setOpen(next);
  }

  function apply() {
    if (!from || !to || tooLong) return;
    onApply({ since: iso(from), until: iso(to) });
    setOpen(false);
  }

  const triggerText =
    active && value
      ? value.since === value.until
        ? format(parseISO(value.since), "MMM d")
        : `${format(parseISO(value.since), "MMM d")} – ${format(parseISO(value.until), "MMM d")}`
      : "Custom";

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-pressed={active}
          aria-label="Custom date range"
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
            active ? "bg-card font-medium text-foreground shadow-sm" : "text-muted hover:text-foreground",
          )}
        >
          <CalendarDays className="h-3.5 w-3.5" aria-hidden />
          {triggerText}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto max-w-[calc(100vw-2rem)]">
        <Calendar
          mode="range"
          numberOfMonths={2}
          selected={draft}
          onSelect={setDraft}
          defaultMonth={draft?.from ?? subMonths(today, 1)}
          disabled={[{ after: today }, { before: oldest }]}
          startMonth={oldest}
          endMonth={today}
          className="[&_.rdp-months]:flex-wrap"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-2">
          <p className={cn("text-xs", tooLong ? "text-danger" : "text-muted")}>
            {!from
              ? "Pick a start date, then an end date."
              : tooLong
                ? `That's ${days} days — pick ${MAX_DAYS} or fewer.`
                : `${label(from)}${to && iso(to) !== iso(from) ? ` – ${label(to)}` : ""} · ${days} day${days === 1 ? "" : "s"}`}
          </p>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={apply} disabled={!from || tooLong}>
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
