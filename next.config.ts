import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Report exports read the embedded PDF fonts from disk at runtime; make sure
  // serverless deployments ship them with the export function.
  outputFileTracingIncludes: {
    "/api/reports/export": ["./public/fonts/**/*"],
    "/api/v2/reports/export": ["./public/fonts/**/*"],
  },
  // Faster cold compiles / tree-shaking for icon & UI barrels in both
  // webpack and Turbopack.
  experimental: {
    optimizePackageImports: [
      "lucide-react",
      "date-fns",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-select",
      "@radix-ui/react-dialog",
      "@radix-ui/react-tabs",
      "@radix-ui/react-avatar",
      "@radix-ui/react-scroll-area",
      "@radix-ui/react-tooltip",
      "@radix-ui/react-checkbox",
      "@radix-ui/react-switch",
    ],
  },
};

export default nextConfig;
