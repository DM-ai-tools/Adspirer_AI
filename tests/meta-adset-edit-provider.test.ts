import { describe, expect, it, vi } from "vitest";
import { MetaGraphProviderV2 } from "@/lib/meta/provider-v2";
import { ExecutionVerificationError } from "@/lib/errors";

type Handler = (path: string, params: Record<string, unknown>) => unknown;

/** Provider with its Graph client replaced by in-memory GET/POST handlers. */
function providerWith(handlers: { get: Handler; post?: Handler }) {
  const provider = new MetaGraphProviderV2("test-token");
  const get = vi.fn(async (path: string, params: Record<string, unknown> = {}) => handlers.get(path, params));
  const post = vi.fn(async (path: string, body: Record<string, unknown> = {}) =>
    handlers.post ? handlers.post(path, body) : { success: true },
  );
  (provider as unknown as { graph: unknown }).graph = { get, post };
  return { provider, get, post };
}

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

describe("updateAdSetSchedule", () => {
  const adSetRow = (over: Record<string, unknown> = {}) => ({
    id: "777",
    name: "Prospecting",
    status: "ACTIVE",
    account_id: "111",
    campaign_id: "999",
    start_time: "2026-01-01T00:00:00+0000",
    end_time: future(20).replace("Z", "+0000"),
    daily_budget: "3000",
    lifetime_budget: "0",
    ...over,
  });

  function setup(opts: { readBack?: (written: Record<string, unknown>) => Record<string, unknown>; readFails?: boolean; row?: Record<string, unknown> } = {}) {
    let written: Record<string, unknown> = {};
    return providerWith({
      get: (path, params) => {
        if (path !== "777") throw new Error(`unexpected GET ${path}`);
        if (String(params.fields).includes("account_id")) return adSetRow(opts.row);
        if (opts.readFails) throw new Error("read-back unavailable");
        return opts.readBack ? opts.readBack(written) : { ...adSetRow(opts.row), ...written };
      },
      post: (_path, body) => {
        written = body;
        return { success: true };
      },
    });
  }

  it("posts the new end date and verifies it by reading it back", async () => {
    const end = future(40);
    const { provider, post } = setup({ readBack: (w) => ({ ...adSetRow(), end_time: String(w.end_time).replace("Z", "+0000") }) });
    const result = await provider.updateAdSetSchedule({ adset_id: "777", end_time: end });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("777", { end_time: new Date(end).toISOString() });
    expect(result).toMatchObject({ id: "777", account_id: "act_111", verified: true });
    expect(result.end_time).toBe(new Date(end).toISOString());
    expect(result.previous_end_time).toMatch(/^20/);
  });

  it("fails when Meta accepted it but reads back a different end date", async () => {
    const { provider } = setup({ readBack: () => ({ ...adSetRow(), end_time: future(5) }) });
    await expect(provider.updateAdSetSchedule({ adset_id: "777", end_time: future(40) })).rejects.toBeInstanceOf(ExecutionVerificationError);
  });

  it("reports unverified, without failing, when the read-back itself fails", async () => {
    const { provider } = setup({ readFails: true });
    const result = await provider.updateAdSetSchedule({ adset_id: "777", end_time: future(40) });
    expect(result.verified).toBe(false);
    expect(result.verification_error).toMatch(/read-back unavailable/);
  });

  it("refuses an ad set in another account and posts nothing", async () => {
    const { provider, post } = setup();
    await expect(
      provider.updateAdSetSchedule({ account_id: "act_222", adset_id: "777", end_time: future(40) }),
    ).rejects.toThrow(/belongs to ad account act_111, not act_222. Nothing was changed/);
    expect(post).not.toHaveBeenCalled();
  });

  it("clears the end date by posting end_time 0 and checks it is gone", async () => {
    const { provider, post } = setup({ readBack: () => {
      const { end_time: _gone, ...rest } = adSetRow();
      void _gone;
      return rest;
    } });
    const result = await provider.updateAdSetSchedule({ adset_id: "777", clear_end_time: true });
    expect(post).toHaveBeenCalledWith("777", { end_time: "0" });
    expect(result).toMatchObject({ end_time: null, verified: true });
  });

  it("fails when the end date is still there after a clear", async () => {
    const { provider } = setup({ readBack: () => adSetRow() });
    await expect(provider.updateAdSetSchedule({ adset_id: "777", clear_end_time: true })).rejects.toBeInstanceOf(ExecutionVerificationError);
  });

  it("will not clear the end date of a lifetime-budget ad set, and posts nothing", async () => {
    const { provider, post } = setup({ row: { daily_budget: "0", lifetime_budget: "90000" } });
    await expect(provider.updateAdSetSchedule({ adset_id: "777", clear_end_time: true })).rejects.toThrow(/lifetime budget.*Nothing was changed/);
    expect(post).not.toHaveBeenCalled();
  });

  it("will not move the start of an ad set that has started, and posts nothing", async () => {
    const { provider, post } = setup();
    await expect(provider.updateAdSetSchedule({ adset_id: "777", start_time: future(3) })).rejects.toThrow(/already started/);
    expect(post).not.toHaveBeenCalled();
  });
});
