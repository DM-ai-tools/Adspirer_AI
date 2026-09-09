/**
 * Design tokens for Adspirer audit reports.
 * The only place hex colours may live in the report package.
 */
export const C = {
  teal900: "#062B28",
  teal800: "#0B5750",
  teal700: "#0F766E",
  teal600: "#0D9488",
  teal400: "#2DD4BF",
  teal100: "#CCFBF1",
  teal50: "#F0FDFA",

  ink900: "#0B0F14",
  ink700: "#334155",
  ink500: "#64748B",
  ink300: "#CBD5E1",
  hair: "#E6ECEA",
  paper: "#FFFFFF",
  paper2: "#FAFBFB",

  high: "#B42318",
  highBg: "#FEF3F2",
  med: "#B54708",
  medBg: "#FFFAEB",
  medFill: "#F79009",
  medBorder: "#FEDF89",
  low: "#475467",
  lowBg: "#F2F4F7",
  ok: "#067647",
  okBg: "#ECFDF3",
  okBorder: "#ABEFC6",

  mastMeta: "#7FD9CF",
  barTrack: "#EEF2F1",
  noDataBar: "#E4E7EC",
  pausedBorder: "#E4E7EC",
} as const;

export const T = {
  h1: 20,
  h2: 12,
  h3: 9.5,
  body: 9,
  small: 8,
  micro: 6.5,
  kpi: 16,
  score: 22,
  mono: 8,
  lhBody: 1.5,
  lhTight: 1.25,
} as const;

export const S = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
} as const;

export const PAGE = { size: "A4" as const, margin: 36, footerH: 46 };
export const R = { sm: 4, md: 6, lg: 8, pill: 999 } as const;
