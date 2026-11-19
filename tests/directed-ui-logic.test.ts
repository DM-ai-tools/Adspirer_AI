import { describe, expect, it } from "vitest";
import { addItem, printChanged, printToText, readyToConfirm, removeItem, textToPrint, toRequestDirections, updateItem, type ConfirmItem } from "@/lib/creatives/directed/confirm-list";

const item = (over: Partial<ConfirmItem> = {}): ConfirmItem => ({ picture: "A red door", print: [{ role: "headline", text: "Open it" }], unsure: false, note: null, ...over });

describe("the words box in the confirm step", () => {
  it("round-trips printed lines with and without a role, keeping the words exactly", () => {
    const print = [
      { role: "headline", text: "Keep   THIS, exactly!" },
      { role: null, text: "A line with: a colon inside" },
      { role: "button", text: "Get your audit" },
    ];
    expect(textToPrint(printToText(print))).toEqual(print);
  });

  it("reads a typed role label, ignores blank lines, and leaves other colons in the words", () => {
    expect(textToPrint("Headline: Open it\n\nButton: Book now\nWhat: not a role")).toEqual([
      { role: "Headline", text: "Open it" },
      { role: "Button", text: "Book now" },
      { role: null, text: "What: not a role" },
    ]);
    expect(textToPrint("")).toEqual([]);
  });
});

describe("role labels the parser chose that the words box does not know", () => {
  const print = [
    { role: "Title", text: "Summer Sale" },
    { role: "Main headline", text: "Everything must go" },
    { role: null, text: "Ends Sunday" },
  ];

  it("round-trips them when the box is told which roles the item already has, so no label becomes printed text", () => {
    const roles = print.map((l) => l.role).filter((r): r is string => Boolean(r));
    expect(textToPrint(printToText(print), roles)).toEqual(print);
  });

  it("without that knowledge an unknown label is just words (the old behaviour), never silently dropped", () => {
    expect(textToPrint("Title: Summer Sale")).toEqual([{ role: null, text: "Title: Summer Sale" }]);
  });

  it("reports no change when the box is left as it was, and a change when a word is edited", () => {
    expect(printChanged(print, printToText(print))).toBe(false);
    expect(printChanged(print, printToText(print) + "\n")).toBe(false);
    expect(printChanged(print, printToText(print).replace("Summer", "Winter"))).toBe(true);
    expect(printChanged([], "")).toBe(false);
  });
});

describe("editing the parsed list", () => {
  it("updates one item without touching the others, and an edit clears its unsure flag", () => {
    const list = [item({ picture: "A", unsure: true, note: "guess" }), item({ picture: "B" })];
    const next = updateItem(list, 0, { picture: "A, clarified" });
    expect(next.map((i) => i.picture)).toEqual(["A, clarified", "B"]);
    expect(next[0]).toMatchObject({ unsure: false, note: null });
    expect(list[0]!.picture).toBe("A");
  });

  it("removes one item and adds an empty one at the end, keeping order", () => {
    const list = [item({ picture: "A" }), item({ picture: "B" }), item({ picture: "C" })];
    expect(removeItem(list, 1).map((i) => i.picture)).toEqual(["A", "C"]);
    const added = addItem(list);
    expect(added).toHaveLength(4);
    expect(added[3]).toMatchObject({ picture: "", print: [], unsure: false });
  });
});

describe("whether the list can be confirmed", () => {
  it("needs at least one item", () => {
    expect(readyToConfirm([])).toEqual({ ok: false, reason: "Add at least one direction." });
  });

  it("is blocked by an image with no picture instruction, naming which one", () => {
    expect(readyToConfirm([item(), item({ picture: "  " })])).toEqual({ ok: false, reason: "Image 2 has no picture instruction yet." });
  });

  it("is not blocked by items that are only flagged as unsure", () => {
    expect(readyToConfirm([item({ unsure: true, note: "Two pictures in one row" }), item()])).toEqual({ ok: true, reason: null });
  });

  it("is blocked past the limit of 30, without cutting anything", () => {
    const many = Array.from({ length: 31 }, () => item());
    expect(readyToConfirm(many)).toEqual({ ok: false, reason: "A run takes at most 30 directions. Remove 1 or split the file." });
  });
});

describe("what is sent to start the run", () => {
  it("sends every item in order with its picture, printed lines and no-logo choice, and nothing else", () => {
    const out = toRequestDirections([item({ picture: " A ", noLogo: true, unsure: true, note: "x" }), item({ picture: "B", print: [] })]);
    expect(out).toEqual([
      { picture: "A", print: [{ role: "headline", text: "Open it" }], noLogo: true },
      { picture: "B", print: [] },
    ]);
  });
});
