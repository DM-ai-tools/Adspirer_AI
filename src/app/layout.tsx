import type { Metadata } from "next";
import { DM_Sans, JetBrains_Mono } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: {
    default: "Adspirer AI",
    template: "%s · Adspirer AI",
  },
  description:
    "Enterprise AI operations for Meta Ads — audit, approve, and execute with human control.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${dmSans.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans">
        {children}
        <Toaster
          theme="dark"
          position="top-right"
          toastOptions={{
            classNames: {
              toast:
                "bg-card border-border text-foreground shadow-lg font-sans",
              description: "text-muted",
              actionButton: "bg-accent text-accent-foreground",
            },
          }}
        />
      </body>
    </html>
  );
}
