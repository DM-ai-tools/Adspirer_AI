import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDemoStore } from "@/lib/demo/store";
import { resetConfigCache } from "@/lib/config";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
import { getCurrentUser } from "@/lib/security/auth";

const scheduled: string[] = [];
vi.mock("@/lib/api/background", () => ({ runAfterResponse: (name: string) => void scheduled.push(name) }));
vi.mock("@/lib/creatives/cloudinary", () => ({ isCloudinaryConfigured: () => false, uploadCreativeImage: async () => ({ url: "", mime: "image/png" }) }));
vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => ({}) }));
vi.mock("ai", () => ({
  generateObject: async () => ({
    object: {
      directions: [
        { picture: "A red door", print: [{ role: "headline", text: "Open it" }], no_logo: false, unsure: false, note: null },
        { picture: "A pier at dawn", print: [], no_logo: false, unsure: true, note: "No words given" },
      ],
    },
  }),
}));

import { POST as startBulk } from "@/app/api/creatives/bulk/route";
import { POST as readFile } from "@/app/api/creatives/bulk/directions/route";
import { getRun } from "@/lib/creatives/bulk/runs";

const clientId = () => getDemoStore().clients[0]!.id;
const bulk = (body: unknown) => startBulk(new Request("https://app.example.com/api/creatives/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
const direction = (n: number) => ({ picture: `Picture ${n}`, print: [{ role: null, text: `Words ${n}` }] });

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test";
  resetConfigCache();
  scheduled.length = 0;
  const p = getDemoStore().profiles.find((x) => x.role === "admin")!;
  vi.mocked(getCurrentUser).mockResolvedValue({ id: p.id, email: p.email, profile: p });
});

describe("POST /api/creatives/bulk with directions", () => {
  it("makes a run with exactly one image per direction and schedules the directed renderer, not the hook planner", async () => {
    const res = await bulk({ clientId: clientId(), directions: [direction(1), direction(2), direction(3)], format: "4:5" });
    expect(res.status).toBe(200);
    const { data, runId } = (await res.json()) as { data?: { runId: string }; runId?: string };
    const run = (await getRun((data?.runId ?? runId)!))!;
    expect(run.items).toHaveLength(3);
    expect(run.inputs.directed).toBe(true);
    expect(scheduled).toEqual(["bulk-directed-run"]);
  });

  it("rejects more than thirty directions and a direction with no picture", async () => {
    expect((await bulk({ clientId: clientId(), directions: Array.from({ length: 31 }, (_, i) => direction(i)) })).status).toBeGreaterThanOrEqual(400);
    expect((await bulk({ clientId: clientId(), directions: [{ picture: "  ", print: [] }] })).status).toBeGreaterThanOrEqual(400);
    expect(scheduled).toEqual([]);
  });
});

describe("POST /api/creatives/bulk/directions", () => {
  const upload = (name: string, text: string, withClient = true) => {
    const form = new FormData();
    if (withClient) form.set("clientId", clientId());
    form.set("file", new File([text], name, { type: "text/plain" }));
    return readFile(new Request("https://app.example.com/api/creatives/bulk/directions", { method: "POST", body: form }));
  };

  it("reads a file into the parsed list for confirmation, flagged items included, and makes nothing", async () => {
    const res = await upload("directions.txt", "1. A red door. Headline: Open it\n2. A pier at dawn");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data?: { fileName: string; directions: Array<{ picture: string; unsure: boolean }> }; fileName?: string; directions?: Array<{ picture: string; unsure: boolean }> };
    const directions = json.data?.directions ?? json.directions!;
    expect(directions.map((d) => d.picture)).toEqual(["A red door", "A pier at dawn"]);
    expect(directions[1]!.unsure).toBe(true);
    expect(scheduled).toEqual([]);
  });

  it("refuses an unsupported file and a missing client", async () => {
    expect((await upload("pic.png", "x")).status).toBeGreaterThanOrEqual(400);
    expect((await upload("a.txt", "x", false)).status).toBeGreaterThanOrEqual(400);
  });
});
