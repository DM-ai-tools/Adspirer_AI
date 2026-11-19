import { beforeEach, describe, expect, it, vi } from "vitest";

let model: object | null = {};
vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => model }));
const extracted: Array<{ filename: string }> = [];
let extractedText = "extracted text from a document";
vi.mock("@/lib/documents/extract-text", async (orig) => ({
  ...(await orig<typeof import("@/lib/documents/extract-text")>()),
  extractDocumentText: async (i: { filename: string }) => {
    extracted.push(i);
    return { text: extractedText, kind: "docx", mimeType: "x" };
  },
}));

import { MAX_DIRECTIONS, normaliseParsed, parseDirectionsFile } from "@/lib/creatives/directed/file";

beforeEach(() => {
  model = {};
  extracted.length = 0;
  extractedText = "extracted text from a document";
});

const item = (over: Record<string, unknown> = {}) => ({ picture: "A red door", print: [{ role: "headline", text: "Open it" }], no_logo: false, unsure: false, note: null, ...over });
const generator = (directions: unknown[]) => (async () => ({ object: { directions } })) as never;
const file = (name: string, text = "1. A red door. Headline: Open it") => ({ name, bytes: Buffer.from(text, "utf8") });

describe("normalising parsed directions", () => {
  it("keeps file order and the words exactly", () => {
    const out = normaliseParsed({ directions: [item({ picture: "First" }), item({ picture: "Second", print: [{ role: null, text: "Keep   THIS, exactly!" }] }), item({ picture: "Third" })] });
    expect(out.map((d) => d.picture)).toEqual(["First", "Second", "Third"]);
    expect(out[1]!.print).toEqual([{ role: null, text: "Keep   THIS, exactly!" }]);
  });

  it("keeps an item that has words but no clear picture, flagged as unsure", () => {
    const out = normaliseParsed({ directions: [item({ picture: "  ", unsure: false, note: null })] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ picture: "", unsure: true });
  });

  it("drops only items that are completely empty, and never merges or reorders", () => {
    const out = normaliseParsed({ directions: [item({ picture: "A" }), item({ picture: "", print: [] }), item({ picture: "C" })] });
    expect(out.map((d) => d.picture)).toEqual(["A", "C"]);
  });

  it("carries the unsure note, never a no-logo option, and returns nothing for garbage", () => {
    const out = normaliseParsed({ directions: [item({ unsure: true, note: "Two pictures in one row", no_logo: true })] });
    expect(out[0]).toMatchObject({ unsure: true, note: "Two pictures in one row" });
    expect(out[0]).not.toHaveProperty("noLogo");
    expect(normaliseParsed(null)).toEqual([]);
    expect(normaliseParsed({ directions: "nope" })).toEqual([]);
  });
});

describe("reading a directions file", () => {
  it("reads a txt file directly and returns one item per direction", async () => {
    const out = await parseDirectionsFile(file("directions.txt"), { generate: generator([item(), item({ picture: "B" })]) });
    expect(out).toHaveLength(2);
    expect(extracted).toHaveLength(0);
  });

  it.each(["docx", "pdf", "xlsx", "csv", "md"])("extracts the text of a .%s file with the document reader", async (ext) => {
    const out = await parseDirectionsFile(file(`directions.${ext}`), { generate: generator([item()]) });
    expect(extracted).toEqual([expect.objectContaining({ filename: `directions.${ext}` })]);
    expect(out).toHaveLength(1);
  });

  it("refuses other file types", async () => {
    await expect(parseDirectionsFile(file("pic.png"), { generate: generator([item()]) })).rejects.toThrow("That file type isn't supported");
    await expect(parseDirectionsFile(file("notes"), { generate: generator([item()]) })).rejects.toThrow("That file type isn't supported");
  });

  it("refuses a file with no readable text", async () => {
    await expect(parseDirectionsFile(file("a.txt", "   \n  "), { generate: generator([item()]) })).rejects.toThrow("The file has no readable text");
    extractedText = "  ";
    await expect(parseDirectionsFile(file("a.docx"), { generate: generator([item()]) })).rejects.toThrow("The file has no readable text");
  });

  it("refuses to cut a long list: more than the limit is an error, not a truncation", async () => {
    const many = Array.from({ length: MAX_DIRECTIONS + 1 }, (_, i) => item({ picture: `P${i}` }));
    await expect(parseDirectionsFile(file("a.txt"), { generate: generator(many) })).rejects.toThrow(`This file has ${MAX_DIRECTIONS + 1} directions; the most for one run is ${MAX_DIRECTIONS}. Split it and upload the parts.`);
    const exact = Array.from({ length: MAX_DIRECTIONS }, (_, i) => item({ picture: `P${i}` }));
    expect(await parseDirectionsFile(file("a.txt"), { generate: generator(exact) })).toHaveLength(MAX_DIRECTIONS);
  });

  it("says so when nothing could be found, and when no model is configured", async () => {
    await expect(parseDirectionsFile(file("a.txt"), { generate: generator([]) })).rejects.toThrow(/couldn't find any directions/i);
    model = null;
    await expect(parseDirectionsFile(file("a.txt"), { generate: generator([item()]) })).rejects.toThrow(/language model/i);
  });
});
