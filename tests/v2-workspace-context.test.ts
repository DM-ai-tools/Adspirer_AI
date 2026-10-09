import { describe, expect, it } from "vitest";
import { getProviderForBackend } from "@/lib/adspirer/client";
import { runWithWorkspaceContext } from "@/lib/runtime/workspace-context";
import { getProvider } from "@/lib/adspirer/client";

describe("workspace context provider selection", () => {
  it("returns meta direct provider for v2 context", async () => {
    const provider = await runWithWorkspaceContext(
      { version: "v2", backend: "meta_direct" },
      async () => getProvider("test_meta_token"),
    );
    expect(provider.name).toBe("MetaGraphProviderV2");
  });

  it("supports explicit backend selection helper", () => {
    const provider = getProviderForBackend("meta_direct", "test_meta_token");
    expect(provider.name).toBe("MetaGraphProviderV2");
  });
});

describe("meta_direct without a token", () => {
  it("asks the user to connect Facebook", () => {
    expect(() => getProviderForBackend("meta_direct")).toThrow(
      /Connect your Facebook account/,
    );
  });
});
