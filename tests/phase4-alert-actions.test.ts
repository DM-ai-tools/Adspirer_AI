import { describe, expect, it } from "vitest";
import { listOpenAlerts, updateAlert } from "@/lib/monitoring/alert-store";

describe("acknowledge and snooze (demo store)", () => {
  // Cold dynamic imports of the audit/health/approvals module graph take ~1s alone and far longer under full-suite load.
  it("lists open alerts and records acknowledge and snooze", { timeout: 20_000 }, async () => {
    const alerts = await listOpenAlerts("client_modern_dental");
    expect(alerts.length).toBeGreaterThan(0);
    const [first, second] = alerts;
    await updateAlert("client_modern_dental", first!.key, { action: "acknowledge", userId: "profile_admin_demo" });
    await updateAlert("client_modern_dental", second!.key, { action: "snooze", days: 3, userId: "profile_admin_demo" });
    const after = await listOpenAlerts("client_modern_dental");
    expect(after.find((a) => a.key === first!.key)?.acknowledged_at).toBeTruthy();
    const snoozed = after.find((a) => a.key === second!.key)!.snoozed_until!;
    expect(Date.parse(snoozed) - Date.now()).toBeGreaterThan(2.9 * 86_400_000);
  });

  it("refuses an unknown alert", async () => {
    await expect(updateAlert("client_modern_dental", "NOPE:1", { action: "acknowledge", userId: "u" })).rejects.toThrow(/not found/i);
  });
});
