import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { cropBox, cropToFormat, generationSize, parseImageFormat } from "@/lib/creatives/formats";
import { buildBrandImagePrompt } from "@/lib/creatives/openai-image";

describe("ad image formats", () => {
  it("renders portrait for 4:5 and 9:16 and square for 1:1", () => {
    expect(generationSize("1:1")).toBe("1024x1024");
    expect(generationSize("4:5")).toBe("1024x1536");
    expect(generationSize("9:16")).toBe("1024x1536");
  });

  it("centre-crops to the exact ratio", () => {
    expect(cropBox("4:5", 1024, 1536)).toEqual({ left: 0, top: 128, width: 1024, height: 1280 });
    expect(cropBox("9:16", 1024, 1536)).toEqual({ left: 80, top: 0, width: 864, height: 1536 });
    expect(cropBox("1:1", 1024, 1024)).toEqual({ left: 0, top: 0, width: 1024, height: 1024 });
  });

  it("crops a generated image to the format", async () => {
    const png = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: "#336699" } }).png().toBuffer();
    const out = await cropToFormat(png.toString("base64"), "9:16");
    const meta = await sharp(Buffer.from(out, "base64")).metadata();
    expect([meta.width, meta.height]).toEqual([864, 1536]);
  });

  it("reads a format, defaulting to the feed's 4:5", () => {
    expect(parseImageFormat("9:16")).toBe("9:16");
    expect(parseImageFormat("reels")).toBe("9:16");
    expect(parseImageFormat(undefined)).toBe("4:5");
  });

  it("tells the model the shape and, for Reels, the safe zone", () => {
    const base = { brandName: "Acme", serviceName: "Implants" };
    const reels = buildBrandImagePrompt({ ...base, format: "9:16" });
    expect(reels).toMatch(/9:16/);
    expect(reels).toMatch(/bottom 35%/);
    expect(reels).not.toMatch(/Square 1:1/);
    expect(buildBrandImagePrompt({ ...base, format: "4:5" })).toMatch(/4:5/);
  });
});

describe("image_choice carries the format", () => {
  it("keeps format from the agent's image_choice block", async () => {
    const { extractImageChoice } = await import("@/lib/agent/reply-format");
    const ui = extractImageChoice('Pick one:\n{"ui":"image_choice","headline":"Hi","format":"9:16"}');
    expect(ui?.format).toBe("9:16");
  });
});
