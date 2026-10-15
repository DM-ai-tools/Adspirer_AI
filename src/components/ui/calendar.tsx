"use client";

import * as React from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { cn } from "@/lib/utils";

/** react-day-picker in the app's colours (dark theme tokens). */
function Calendar({ className, ...props }: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      className={cn("cf-calendar text-sm", className)}
      style={
        {
          "--rdp-accent-color": "var(--accent)",
          "--rdp-accent-background-color": "var(--accent-muted)",
          "--rdp-day-height": "34px",
          "--rdp-day-width": "34px",
          "--rdp-day_button-height": "32px",
          "--rdp-day_button-width": "32px",
          "--rdp-range_start-color": "var(--accent-foreground)",
          "--rdp-range_end-color": "var(--accent-foreground)",
          "--rdp-range_start-date-background-color": "var(--accent)",
          "--rdp-range_end-date-background-color": "var(--accent)",
          "--rdp-range_middle-background-color": "var(--accent-muted)",
          "--rdp-range_middle-color": "var(--foreground)",
          "--rdp-today-color": "var(--accent)",
          "--rdp-disabled-opacity": "0.3",
          "--rdp-outside-opacity": "0.35",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Calendar };
