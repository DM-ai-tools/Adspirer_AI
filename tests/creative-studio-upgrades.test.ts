import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDocument } from "@/types";

const generateObjectMock = vi.fn();
vi.mock("ai", () => ({ generateObject: (...args: unknown[]) => generateObjectMock(...args) }));
vi.mock("@/lib/creatives/concept-writer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/creatives/concept-writer")>()),
  pickModel: () => ({ fake: "model" }),
}));

import { creativeDownloadUrl, downloadFileName } from "@/lib/creatives/download";
import { extractCreativeSource, pickSourceDocuments } from "@/lib/creatives/source-from-documents";
import { pickLogoDocument } from "@/lib/creatives/uploaded-logo";
import { buildConceptPrompt } from "@/lib/creatives/concept-writer";

const doc = (over: Partial<WorkspaceDocument>): WorkspaceDocument =>
  ({
    id: "d1",
    client_id: "c1",
    conversation_id: null,
    filename: "notes.txt",
    mime_type: "text/plain",
    extracted_text: "Some text that is long enough to count as readable content.",
    excerpt: null,
    doc_kind: "other",
    status: "ready",
    storage_key: "k",
    ...over,
  }) as unknown as WorkspaceDocument;

describe("downloads", () => {
  it("names the file after the headline and the right extension", () => {
    expect(downloadFileName("Spring Sale — 20% off!", "image/png", "abcdef123")).toBe("spring-sale-20-off-abcdef.png");
    expect(downloadFileName("", "image/jpeg", "abcdef123")).toBe("creative-abcdef.jpg");
  });

  it("points at the same-origin attachment route", () => {
    expect(creativeDownloadUrl("x y")).toBe("/api/creatives/assets/x%20y?download=1");
  });
});

describe("uploaded ad copy / landing page", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
  });

  it("prefers files attached to this chat and skips empty ones", () => {
    const docs = [
      doc({ id: "old", filename: "old.txt", conversation_id: "other" }),
      doc({ id: "mine", filename: "copy.docx", conversation_id: "chat1" }),
      doc({ id: "empty", filename: "blank.txt", conversation_id: "chat1", extracted_text: "", excerpt: "" }),
    ];
    expect(pickSourceDocuments(docs, "chat1").map((d) => d.id)).toEqual(["mine"]);
    expect(pickSourceDocuments(docs, "none").map((d) => d.id)).toEqual(["old", "mine"]);
  });

  it("returns the copy, page and offer the model read from the files", async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        headline: " Free shipping this week ",
        primary_text: "Our sofas ship free until Sunday.",
        cta: null,
        landing_page_url: "https://shop.example/sofas",
        landing_page_summary: "Sofas with free shipping.",
        used_files: ["copy.docx", "not-a-real-file.txt"],
      },
    });
    const source = await extractCreativeSource({
      docs: [doc({ filename: "copy.docx", conversation_id: "chat1" })],
      conversationId: "chat1",
      request: "make creatives from this ad copy",
    });
    expect(source).toMatchObject({
      headline: "Free shipping this week",
      primaryText: "Our sofas ship free until Sunday.",
      landingPageUrl: "https://shop.example/sofas",
      pageSummary: "Sofas with free shipping.",
      sourceFiles: ["copy.docx"],
    });
    expect(source?.cta).toBeUndefined();
  });

  it("returns null when nothing usable was found or there are no files", async () => {
    expect(await extractCreativeSource({ docs: [], request: "x" })).toBeNull();
    generateObjectMock.mockResolvedValue({
      object: { headline: null, primary_text: null, cta: null, landing_page_url: null, landing_page_summary: null, used_files: [] },
    });
    expect(await extractCreativeSource({ docs: [doc({})], request: "x" })).toBeNull();
  });

  it("returns null instead of throwing when the model fails", async () => {
    generateObjectMock.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(await extractCreativeSource({ docs: [doc({})], request: "x" })).toBeNull();
  });
});

describe("uploaded logo", () => {
  const image = (over: Partial<WorkspaceDocument>) => doc({ mime_type: "image/png", ...over });

  it("takes an image named like a logo, preferring one attached to this chat", () => {
    const docs = [image({ id: "a", filename: "acme-logo.png" }), image({ id: "b", filename: "Logo final.png", conversation_id: "chat1" })];
    expect(pickLogoDocument(docs, "chat1")?.id).toBe("b");
  });

  it("takes the only image in the chat when the operator says it is the logo", () => {
    const docs = [image({ id: "only", filename: "IMG_2041.png", conversation_id: "chat1" })];
    expect(pickLogoDocument(docs, "chat1", "use this as the logo")?.id).toBe("only");
    expect(pickLogoDocument(docs, "chat1", "make me some creatives")).toBeNull();
  });

  it("never mistakes a non-image or a photo for a logo", () => {
    expect(pickLogoDocument([doc({ filename: "logo-brief.docx" })], "chat1")).toBeNull();
    const two = [image({ id: "1", filename: "a.png", conversation_id: "chat1" }), image({ id: "2", filename: "b.png", conversation_id: "chat1" })];
    expect(pickLogoDocument(two, "chat1", "this is the logo")).toBeNull();
  });
});

describe("brand look and campaign hand-off wording", () => {
  it("asks the concept writer to carry the brand's scheme, typography and imagery", () => {
    const prompt = buildConceptPrompt({
      clientId: "c",
      serviceId: null,
      count: 2,
      brand: { name: "Acme", colors: ["#112233"], imageryNotes: "dark colour scheme" },
      business: {},
      offer: { name: "Sofas" },
    });
    expect(prompt).toContain("light or dark scheme, typography feel, imagery style");
    expect(prompt).toContain("dark colour scheme");
  });
});
