import path from "node:path";
import { Font } from "@react-pdf/renderer";

let registered = false;

function fontPath(name: string): string {
  return path.join(process.cwd(), "public", "fonts", name);
}

/** Register Inter + JetBrains Mono once per process. */
export function ensureReportFonts(): void {
  if (registered) return;
  registered = true;

  Font.register({
    family: "Inter",
    fonts: [
      { src: fontPath("Inter-Regular.ttf"), fontWeight: 400 },
      { src: fontPath("Inter-Medium.ttf"), fontWeight: 500 },
      { src: fontPath("Inter-SemiBold.ttf"), fontWeight: 600 },
      { src: fontPath("Inter-Bold.ttf"), fontWeight: 700 },
    ],
  });

  Font.register({
    family: "JetBrainsMono",
    fonts: [
      { src: fontPath("JetBrainsMono-Regular.ttf"), fontWeight: 400 },
    ],
  });

  // Disable aggressive hyphenation — mid-word breaks look cheap on paper.
  Font.registerHyphenationCallback((word) => [word]);
}
