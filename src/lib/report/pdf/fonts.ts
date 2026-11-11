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
      {
        src: fontPath("Inter-Italic.ttf"),
        fontWeight: 400,
        fontStyle: "italic",
      },
      { src: fontPath("Inter-Medium.ttf"), fontWeight: 500 },
      { src: fontPath("Inter-SemiBold.ttf"), fontWeight: 600 },
      { src: fontPath("Inter-Bold.ttf"), fontWeight: 700 },
    ],
  });

  // Traffic Radius's typeface (trafficradius.com.au), for headings and the cover. SIL Open Font License.
  Font.register({
    family: "Montserrat",
    fonts: [
      { src: fontPath("Montserrat-SemiBold.ttf"), fontWeight: 600 },
      { src: fontPath("Montserrat-Bold.ttf"), fontWeight: 700 },
      { src: fontPath("Montserrat-ExtraBold.ttf"), fontWeight: 800 },
    ],
  });

  Font.register({
    family: "JetBrainsMono",
    fonts: [
      { src: fontPath("JetBrainsMono-Regular.ttf"), fontWeight: 400 },
    ],
  });

  // No syllable hyphenation — mid-word breaks look cheap on paper. Very long
  // tokens (URLs, IDs) are the exception: let them break into chunks so they
  // wrap inside table cells instead of running past the edge.
  Font.registerHyphenationCallback((word) =>
    word.length > 40 ? (word.match(/.{1,24}/g) ?? [word]) : [word],
  );
}
