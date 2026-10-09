/** Small guards shared by the Meta write path (provider-v2 mutation methods). */

/** Meta returns budgets as minor-unit strings ("0" when unset). */
export function positiveMinor(value: unknown): boolean {
  const n = Number(value);
  return value != null && value !== "" && Number.isFinite(n) && n > 0;
}

export function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Lifetime budgets need a future end_time. Checked before the first POST so a
 * bad schedule never leaves a half-built campaign behind.
 */
export function assertFutureEndTime(
  endTime: string | undefined,
  required: boolean,
): void {
  if (!endTime) {
    if (required) {
      throw new Error(
        "budget_lifetime requires end_time (ISO date/time). Nothing was created.",
      );
    }
    return;
  }
  const end = Date.parse(endTime);
  if (Number.isNaN(end)) {
    throw new Error(`end_time "${endTime}" is not a valid date/time. Nothing was created.`);
  }
  if (end <= Date.now()) {
    throw new Error(`end_time ${endTime} is in the past. Nothing was created.`);
  }
}
