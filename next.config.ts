import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
