import { beforeEach, describe, expect, it, vi } from "vitest";
import { getProviderForBackend } from "@/lib/adspirer/client";
import { executeApprovedAction } from "@/lib/approvals/executor";
import { assessRisk } from "@/lib/approvals/risk";
import { approve, createPendingApproval } from "@/lib/approvals/service";
import { prepareApprovalArgs } from "@/lib/approvals/validate-args";
import { listChanges, type ChangeLogEntry } from "@/lib/changes/change-log";
import { inverseOf } from "@/lib/changes/rollback";
import { CatalogAccessError } from "@/lib/meta/catalog/errors";
import { MetaGraphError } from "@/lib/meta/graph-client";
import { MetaGraphProviderV2 } from "@/lib/meta/provider-v2";
import { getExecuteToolSchema } from "@/lib/tools/execute/schemas";
import { humanToolLabel, humanToolProgressLabel } from "@/lib/tools/display-labels";
import { classify } from "@/lib/tools/policy";

const CLIENT_ID = "client_modern_dental";
const REVIEWER = "profile_admin_demo";
const SET = "demo_set_spring";
const FEED = "demo_feed_1";
const IN_STOCK = '{"and":[{"tag":{"eq":"spring"}},{"availability":{"eq":"in stock"}}]}';
const PERMISSION_MESSAGE =
  "The approver's Facebook connection cannot manage this catalogue: reconnect Facebook, or have someone with access approve.";

const provider = () => getProviderForBackend(null);

async function run(toolName: string, args: Record<string, unknown>) {
  const pending = await createPendingApproval({ clientId: CLIENT_ID, toolName, proposedArgs: args });
  await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
  const { approval } = await executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER });
  return { pending, approval };
}

type Handler = (path: string, params: Record<string, unknown>) => unknown;

/** Provider with its Graph client replaced by in-memory GET/POST handlers. */
function providerWith(handlers: { get: Handler; post?: Handler }) {
  const live = new MetaGraphProviderV2("test-token");
  const calls: string[] = [];
  const get = vi.fn(async (path: string, params: Record<string, unknown> = {}) => {
    calls.push(`GET ${path}`);
    return handlers.get(path, params);
  });
  const post = vi.fn(async (path: string, body: Record<string, unknown> = {}) => {
    calls.push(`POST ${path}`);
    return handlers.post ? handlers.post(path, body) : { success: true };
  });
  (live as unknown as { graph: unknown }).graph = { get, post };
  return { provider: live, get, post, calls };
}

const permissionError = () =>
  new MetaGraphError("(#100) Missing permission: catalog_management has not been approved", 100, 400);

beforeEach(() => {
  delete (globalThis as { __adspirerMockMetaState?: unknown }).__adspirerMockMetaState;
});

describe("catalogue fix tools: wiring", () => {
  it("are execute tools with labels", () => {
    expect(classify("update_product_set_filter")).toBe("execute");
    expect(classify("request_feed_refresh")).toBe("execute");
    expect(humanToolLabel("update_product_set_filter")).toBe("Update product set filter");
    expect(humanToolLabel("request_feed_refresh")).toBe("Refresh catalogue feed");
    expect(humanToolProgressLabel("update_product_set_filter")).toMatch(/product set/i);
    expect(humanToolProgressLabel("request_feed_refresh")).toMatch(/feed/i);
  });

  it("the filter must be a string holding a JSON object", () => {
    const schema = getExecuteToolSchema("update_product_set_filter")!;
    expect(schema.safeParse({ product_set_id: SET, filter: IN_STOCK }).success).toBe(true);
    expect(schema.safeParse({ product_set_id: SET, filter: "availability = in stock" }).success).toBe(false);
    expect(schema.safeParse({ product_set_id: SET, filter: "[1,2]" }).success).toBe(false);
    expect(schema.safeParse({ product_set_id: SET, filter: "null" }).success).toBe(false);
    expect(schema.safeParse({ product_set_id: SET, filter: { availability: { eq: "in stock" } } }).success).toBe(false);
    expect(schema.safeParse({ filter: IN_STOCK }).success).toBe(false);
  });

  it("a feed refresh needs a feed id", () => {
    const schema = getExecuteToolSchema("request_feed_refresh")!;
    expect(schema.safeParse({ feed_id: FEED }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("is refused at proposal time with a non-JSON filter", async () => {
    await expect(
      createPendingApproval({ clientId: CLIENT_ID, toolName: "update_product_set_filter", proposedArgs: { product_set_id: SET, filter: "in stock only" } }),
    ).rejects.toThrow(/filter/);
  });

  it("the no-executor message names both tools", async () => {
    await expect(
      prepareApprovalArgs({ toolName: "edit_catalog_item", clientId: CLIENT_ID, args: {}, loadAccounts: async () => [] }),
    ).rejects.toThrow(/update_product_set_filter.*request_feed_refresh|request_feed_refresh.*update_product_set_filter/);
  });

  it("both are high risk, because every ad set using the set or catalogue changes", () => {
    const filter = assessRisk("update_product_set_filter", { product_set_id: SET, filter: IN_STOCK }, {});
    expect(filter.level).toBe("high");
    expect(filter.reason).toMatch(/product set/);
    expect(filter.reason).toMatch(/every ad set/);
    expect(filter.reason).toMatch(/other ad accounts/);
    const feed = assessRisk("request_feed_refresh", { feed_id: FEED }, {});
    expect(feed.level).toBe("high");
    expect(feed.reason).toMatch(/catalogue/);
    expect(feed.reason).toMatch(/every ad set/);
    expect(feed.reason).toMatch(/other ad accounts/);
  });
});

describe("catalogue fix tools: through approvals", () => {
  it("update_product_set_filter runs once with exactly the approved values and proves before and after", async () => {
    const spy = vi.spyOn(provider(), "updateProductSetFilter");
    spy.mockClear();
    const { pending, approval } = await run("update_product_set_filter", { product_set_id: SET, filter: IN_STOCK });
    expect(pending.risk_level).toBe("high");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ product_set_id: SET, filter: IN_STOCK });
    expect(approval.status).toBe("executed");
    const proof = approval.execution_result?.proof as Record<string, unknown>;
    expect(proof).toMatchObject({
      product_set_id: SET,
      before_filter: '{"tag":{"eq":"spring"}}',
      after_filter: IN_STOCK,
    });

    const [entry] = await listChanges(CLIENT_ID, 1);
    expect(entry).toMatchObject({ tool_name: "update_product_set_filter", entity_type: "product_set", entity_id: SET });
    expect(entry!.before?.filter).toBe('{"tag":{"eq":"spring"}}');
    expect(entry!.after?.filter).toBe(IN_STOCK);
  });

  it("request_feed_refresh runs once with exactly the approved feed and proves the upload", async () => {
    const spy = vi.spyOn(provider(), "requestFeedRefresh");
    spy.mockClear();
    const { pending, approval } = await run("request_feed_refresh", { feed_id: FEED });
    expect(pending.risk_level).toBe("high");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ feed_id: FEED });
    expect(approval.status).toBe("executed");
    const proof = approval.execution_result?.proof as Record<string, unknown>;
    expect(proof.feed_id).toBe(FEED);
    expect(typeof proof.upload_session_id).toBe("string");

    const [entry] = await listChanges(CLIENT_ID, 1);
    expect(entry).toMatchObject({ tool_name: "request_feed_refresh", entity_type: "feed", entity_id: FEED });
  });

  it("a permission failure reaches the approval record with the exact message", async () => {
    const spy = vi.spyOn(provider(), "updateProductSetFilter");
    spy.mockRejectedValueOnce(new CatalogAccessError("missing_permission", PERMISSION_MESSAGE));
    const pending = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "update_product_set_filter",
      proposedArgs: { product_set_id: SET, filter: '{"availability":{"eq":"in stock"}}' },
    });
    await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
    await expect(executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER })).rejects.toThrow(PERMISSION_MESSAGE);
    const { getApproval } = await import("@/lib/approvals/service");
    expect((await getApproval(pending.id)).execution_error).toBe(PERMISSION_MESSAGE);
  });

  it("catalogue changes say plainly that they cannot be rolled back", () => {
    const change = {
      id: "change_1",
      tool_name: "update_product_set_filter",
      entity_type: "product_set",
      entity_id: SET,
      account_id: null,
      before: { filter: '{"tag":{"eq":"spring"}}' },
      after: { filter: IN_STOCK },
    } as unknown as ChangeLogEntry;
    expect(() => inverseOf(change)).toThrow(/Catalogue changes can't be rolled back/);
    expect(() => inverseOf({ ...change, tool_name: "request_feed_refresh", entity_type: "feed" } as ChangeLogEntry)).toThrow(
      /Catalogue changes can't be rolled back/,
    );
  });
});

describe("MetaGraphProviderV2.updateProductSetFilter", () => {
  it("reads the set, writes the filter, reads it back", async () => {
    let written: string | undefined;
    const { provider: live, post, calls } = providerWith({
      get: (path, params) => {
        expect(path).toBe("PS1");
        expect(String(params.fields)).toContain("filter");
        return written
          ? { id: "PS1", name: "Spring", filter: written, product_count: 590 }
          : { id: "PS1", name: "Spring", filter: '{"tag":{"eq":"spring"}}', product_count: 640 };
      },
      post: (_path, body) => {
        written = String(body.filter);
        return { success: true };
      },
    });
    const result = await live.updateProductSetFilter({ product_set_id: "PS1", filter: IN_STOCK });
    expect(calls).toEqual(["GET PS1", "POST PS1", "GET PS1"]);
    expect(post).toHaveBeenCalledWith("PS1", { filter: IN_STOCK });
    expect(result).toMatchObject({
      product_set_id: "PS1",
      before_filter: '{"tag":{"eq":"spring"}}',
      after_filter: IN_STOCK,
      product_count_after: 590,
      verified: true,
    });
  });

  it("a set with no filter reports before_filter null", async () => {
    let written: string | undefined;
    const { provider: live } = providerWith({
      get: () => (written ? { id: "PS1", filter: written, product_count: 12 } : { id: "PS1", product_count: 100 }),
      post: (_path, body) => {
        written = String(body.filter);
        return { success: true };
      },
    });
    const result = await live.updateProductSetFilter({ product_set_id: "PS1", filter: IN_STOCK });
    expect(result.before_filter).toBeNull();
  });

  it("a permission error on the read is a CatalogAccessError and nothing is written", async () => {
    const { provider: live, post } = providerWith({
      get: () => {
        throw permissionError();
      },
    });
    const error = await live.updateProductSetFilter({ product_set_id: "PS1", filter: IN_STOCK }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CatalogAccessError);
    expect((error as CatalogAccessError).reason).toBe("missing_permission");
    expect((error as Error).message).toBe(PERMISSION_MESSAGE);
    expect(post).not.toHaveBeenCalled();
  });

  it("a permission error on the write is a CatalogAccessError too", async () => {
    const { provider: live } = providerWith({
      get: () => ({ id: "PS1", filter: null, product_count: 1 }),
      post: () => {
        throw permissionError();
      },
    });
    await expect(live.updateProductSetFilter({ product_set_id: "PS1", filter: IN_STOCK })).rejects.toThrow(PERMISSION_MESSAGE);
  });

  it("a failed read-back is reported as unverified, not as a failure", async () => {
    let posted = false;
    const { provider: live } = providerWith({
      get: () => {
        if (posted) throw new MetaGraphError("Meta took too long", undefined, 0);
        return { id: "PS1", filter: null, product_count: 1 };
      },
      post: () => {
        posted = true;
        return { success: true };
      },
    });
    const result = await live.updateProductSetFilter({ product_set_id: "PS1", filter: IN_STOCK });
    expect(result).toMatchObject({ after_filter: IN_STOCK, product_count_after: null, verified: false });
  });
});

describe("MetaGraphProviderV2.requestFeedRefresh", () => {
  it("reads the schedule URL and asks Meta to fetch it", async () => {
    const { provider: live, post, calls } = providerWith({
      get: (path, params) => {
        expect(path).toBe("F1");
        expect(String(params.fields)).toContain("schedule");
        return { id: "F1", name: "Shopify feed", schedule: { url: "https://shop.example/feed.xml", interval: "DAILY" } };
      },
      post: () => ({ id: "UPLOAD9" }),
    });
    const result = await live.requestFeedRefresh({ feed_id: "F1" });
    expect(calls).toEqual(["GET F1", "POST F1/uploads"]);
    expect(post).toHaveBeenCalledWith("F1/uploads", { url: "https://shop.example/feed.xml" });
    expect(result).toEqual({ feed_id: "F1", upload_session_id: "UPLOAD9" });
  });

  it("returns a null session id when Meta gives none", async () => {
    const { provider: live } = providerWith({
      get: () => ({ id: "F1", schedule: { url: "https://shop.example/feed.xml" } }),
      post: () => ({ success: true }),
    });
    expect(await live.requestFeedRefresh({ feed_id: "F1" })).toEqual({ feed_id: "F1", upload_session_id: null });
  });

  it("refuses a feed with no schedule URL and posts nothing", async () => {
    const { provider: live, post } = providerWith({ get: () => ({ id: "F1", name: "Manual uploads" }) });
    await expect(live.requestFeedRefresh({ feed_id: "F1" })).rejects.toThrow("This feed has no schedule URL to re-fetch");
    expect(post).not.toHaveBeenCalled();
  });

  it("a permission error on the read is a CatalogAccessError and nothing is posted", async () => {
    const { provider: live, post } = providerWith({
      get: () => {
        throw permissionError();
      },
    });
    const error = await live.requestFeedRefresh({ feed_id: "F1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CatalogAccessError);
    expect((error as Error).message).toBe(PERMISSION_MESSAGE);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("catalogue fix tools: client ownership", () => {
  const NOT_LINKED = "This product set / feed is not linked to this client's ad accounts. Nothing was changed.";
  const commerce = (catalogIds: string[], productSetIds: string[] = []) => async () =>
    ({
      state: "ok" as const,
      catalogs: catalogIds.map((id) => ({ id, name: id, productCount: 1 })),
      uses: productSetIds.map((productSetId, i) => ({
        accountId: "act_1",
        adSetId: `as_${i}`,
        adSetName: "DPA",
        campaignId: "c1",
        productSetId,
        effectiveStatus: "ACTIVE",
        learningStatus: null,
        spendCents: 0,
        catalogId: catalogIds[0]!,
      })),
    });

  it("refuses a product set that is not the client's, and never calls the write", async () => {
    const spy = vi.spyOn(provider(), "updateProductSetFilter");
    spy.mockClear();
    const pending = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "update_product_set_filter",
      proposedArgs: { product_set_id: "someone_elses_set", filter: IN_STOCK },
    });
    await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
    await expect(executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER })).rejects.toThrow(NOT_LINKED);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a feed that is not in the client's catalogues, and never calls the refresh", async () => {
    const spy = vi.spyOn(provider(), "requestFeedRefresh");
    spy.mockClear();
    const pending = await createPendingApproval({ clientId: CLIENT_ID, toolName: "request_feed_refresh", proposedArgs: { feed_id: "foreign_feed" } });
    await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
    await expect(executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER })).rejects.toThrow(NOT_LINKED);
    expect(spy).not.toHaveBeenCalled();
  });

  it("a set one of the client's ad sets sells passes without any Graph read", async () => {
    const { assertCatalogTargetOwned } = await import("@/lib/meta/catalog/ownership");
    const { provider: live, get, post } = providerWith({ get: () => ({}) });
    await assertCatalogTargetOwned({ clientId: CLIENT_ID, target: { product_set_id: "PS1" }, provider: live, loadCommerce: commerce(["CAT1"], ["PS1"]) });
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("a set in one of the client's catalogues passes; one in a foreign catalogue is refused with no POST", async () => {
    const { assertCatalogTargetOwned } = await import("@/lib/meta/catalog/ownership");
    const { provider: live, get, post } = providerWith({
      get: (path, params) => {
        expect(String(params.fields)).toBe("product_catalog{id}");
        return { product_catalog: { id: path === "PS_OWNED" ? "CAT1" : "CAT_OTHER" } };
      },
    });
    await assertCatalogTargetOwned({ clientId: CLIENT_ID, target: { product_set_id: "PS_OWNED" }, provider: live, loadCommerce: commerce(["CAT1"]) });
    await expect(
      assertCatalogTargetOwned({ clientId: CLIENT_ID, target: { product_set_id: "PS_FOREIGN" }, provider: live, loadCommerce: commerce(["CAT1"]) }),
    ).rejects.toThrow(NOT_LINKED);
    expect(get).toHaveBeenCalledTimes(2);
    expect(post).not.toHaveBeenCalled();
  });

  it("a feed is the client's only when one of its catalogues lists it", async () => {
    const { assertCatalogTargetOwned } = await import("@/lib/meta/catalog/ownership");
    const { provider: live, post } = providerWith({
      get: (path) => {
        if (path === "CAT1/product_feeds") return { data: [{ id: "F_OWNED" }] };
        if (path === "CAT2/product_feeds") return { data: [{ id: "F_ALSO" }] };
        throw new Error(`unexpected GET ${path}`);
      },
    });
    await assertCatalogTargetOwned({ clientId: CLIENT_ID, target: { feed_id: "F_ALSO" }, provider: live, loadCommerce: commerce(["CAT1", "CAT2"]) });
    await expect(
      assertCatalogTargetOwned({ clientId: CLIENT_ID, target: { feed_id: "F_FOREIGN" }, provider: live, loadCommerce: commerce(["CAT1", "CAT2"]) }),
    ).rejects.toThrow(NOT_LINKED);
    expect(post).not.toHaveBeenCalled();
  });

  it("missing permission on the ownership lookup is the approver-permission message", async () => {
    const { assertCatalogTargetOwned } = await import("@/lib/meta/catalog/ownership");
    const { provider: live } = providerWith({
      get: () => {
        throw permissionError();
      },
    });
    await expect(
      assertCatalogTargetOwned({
        clientId: CLIENT_ID,
        target: { product_set_id: "PS1" },
        provider: live,
        loadCommerce: async () => ({ state: "missing_permission", message: "x" }),
      }),
    ).rejects.toThrow(PERMISSION_MESSAGE);
    await expect(
      assertCatalogTargetOwned({ clientId: CLIENT_ID, target: { product_set_id: "PS1" }, provider: live, loadCommerce: commerce(["CAT1"]) }),
    ).rejects.toThrow(PERMISSION_MESSAGE);
  });
});

describe("catalogue fix tools: error mapping and the writer's list", () => {
  it.each([
    [190, "Error validating access token: Session has expired"],
    [10, "Application does not have permission for this action"],
  ])("Graph code %i is the approver-permission message", async (code, message) => {
    const { provider: live, post } = providerWith({
      get: () => {
        throw new MetaGraphError(message, code, 400);
      },
    });
    await expect(live.updateProductSetFilter({ product_set_id: "PS1", filter: IN_STOCK })).rejects.toThrow(PERMISSION_MESSAGE);
    expect(post).not.toHaveBeenCalled();
  });

  it("a set Meta cannot find says so, and that nothing was changed", async () => {
    const { provider: live, post } = providerWith({
      get: () => {
        throw new MetaGraphError("Unsupported get request. Object with ID 'PS1' does not exist", 100, 400);
      },
    });
    const error = await live.updateProductSetFilter({ product_set_id: "PS1", filter: IN_STOCK }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CatalogAccessError);
    expect((error as CatalogAccessError).reason).toBe("not_found");
    expect((error as Error).message).toBe(
      "Meta could not find product set PS1, or the approver's Facebook connection cannot see it. Nothing was changed.",
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("the writer is not offered the catalogue fixes as things it can queue", async () => {
    const { capabilityPromptBlock } = await import("@/lib/agent/optimization-capabilities");
    const block = capabilityPromptBlock();
    const queueable = block.split("Queued from the Commerce page")[0]!;
    expect(queueable).not.toContain("update_product_set_filter");
    expect(queueable).not.toContain("request_feed_refresh");
    expect(queueable).not.toContain("product set's filter");
    expect(block).toMatch(/Queued from the Commerce page's suggestions[\s\S]*product set's filter/);
  });
});
