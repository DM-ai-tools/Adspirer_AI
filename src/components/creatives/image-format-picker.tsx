"use client";

import { IMAGE_FORMAT_OPTIONS, type ImageFormat } from "@/lib/creatives/formats";
import { cn } from "@/lib/utils";

/** Pick the shape the stills are rendered in (every shape is rendered natively, not cropped). */
export function ImageFormatPicker({
  value,
  onChange,
  disabled,
}: {
  value: ImageFormat;
  onChange: (value: ImageFormat) => void;
  disabled?: boolean;
}) {
  const current = IMAGE_FORMAT_OPTIONS.find((o) => o.value === value);
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted">Image size</p>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Image size">
        {IMAGE_FORMAT_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            disabled={disabled}
            title={option.use}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
              option.value === value
                ? "border-accent bg-accent/10 font-medium text-foreground"
                : "border-border text-muted hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      {current ? <p className="text-[11px] text-muted">{current.use}</p> : null}
    </div>
  );
}
