import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { getDemoStore, resetDemoStore } from "@/lib/demo/store";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
import { getCurrentUser } from "@/lib/security/auth";

import { POST as approveRoute } from "@/app/api/approvals/[id]/approve/route";
import { approve, createPendingApproval, getApproval } from "@/lib/approvals/service";
import { assertCanApproveTool, CATALOG_FIX_ADMIN_MESSAGE } from "@/lib/authz/assert";
import { assertMayApprove } from "@/lib/approvals/approver";
import { AuthorizationError } from "@/lib/errors";

const CLIENT_ID = "client_modern_dental";
const SET = "demo_set_spring";
const FEED = "demo_feed_1";
const IN_STOCK = '{"and":[{"tag":{"eq":"spring"}},{"availability":{"eq":"in stock"}}]}';

const as = (role: "admin" | "operator") => {
  const p = getDemoStore().profiles.find((x) => x.role === role)!;
  vi.mocked(getCurrentUser).mockResolvedValue({ id: p.id, email: p.email, profile: p });
  return p;
};
const callApprove = (id: string) =>
  approveRoute(new Request(`https://app.example.com/api/approvals/${id}/approve`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

const queue = (toolName: string, proposedArgs: Record<string, unknown>) =>
  createPendingApproval({ clientId: CLIENT_ID, toolName, proposedArgs });

beforeEach(() => {
  resetConfigCache();
  resetDemoStore();
  delete (globalThis as { __adspirerMockMetaState?: unknown }).__adspirerMockMetaState;
  vi.mocked(getCurrentUser).mockReset();
});

describe("catalogue fixes need an admin to approve", () => {
  it.each([
    ["update_product_set_filter", { product_set_id: SET, filter: IN_STOCK }],
    ["request_feed_refresh", { feed_id: FEED }],
  ])("an operator approving %s gets a clear 403 and nothing runs", async (toolName, args) => {
    const pending = await queue(toolName, args);
    as("operator");
    const res = await callApprove(pending.id);
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe(
      "Catalogue fixes change product sets for every ad set that uses them, so an admin has to approve them.",
    );
    expect((await getApproval(pending.id)).status).toBe("pending");
  });

  it("an operator cannot run a catalogue fix that was left approved", async () => {
    const pending = await queue("request_feed_refresh", { feed_id: FEED });
    const stored = getDemoStore().approvals.find((a) => a.id === pending.id)!;
    stored.status = "approved";
    as("operator");
    const res = await callApprove(pending.id);
    expect(res.status).toBe(403);
    expect((await getApproval(pending.id)).status).toBe("approved");
  });

  it("an admin approves and it executes", async () => {
    const pending = await queue("update_product_set_filter", { product_set_id: SET, filter: IN_STOCK });
    as("admin");
    const res = await callApprove(pending.id);
    expect(res.status).toBe(200);
    expect((await getApproval(pending.id)).status).toBe("executed");
  });

  it("the service refuses an operator even if the approval's risk were not high", async () => {
    const pending = await queue("update_product_set_filter", { product_set_id: SET, filter: IN_STOCK });
    const stored = getDemoStore().approvals.find((a) => a.id === pending.id)!;
    stored.risk_level = "low";
    const operator = getDemoStore().profiles.find((p) => p.role === "operator")!;
    await expect(approve({ approvalId: pending.id, reviewedBy: operator.id })).rejects.toThrow(CATALOG_FIX_ADMIN_MESSAGE);
  });

  it("other tools keep their rules: the gate only names the two catalogue fixes", async () => {
    const operator = { role: "operator" as const };
    expect(() => assertCanApproveTool(operator, "update_product_set_filter")).toThrow(AuthorizationError);
    expect(() => assertCanApproveTool(operator, "request_feed_refresh")).toThrow(CATALOG_FIX_ADMIN_MESSAGE);
    expect(() => assertCanApproveTool(operator, "pause_adset")).not.toThrow();
    expect(() => assertCanApproveTool({ role: "admin" as const }, "request_feed_refresh")).not.toThrow();
    const operatorId = getDemoStore().profiles.find((p) => p.role === "operator")!.id;
    await expect(assertMayApprove({ risk_level: "low", risk_reason: null, tool_name: "pause_adset" }, operatorId)).resolves.toBeUndefined();
  });
});
