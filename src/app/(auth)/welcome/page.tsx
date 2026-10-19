import { Suspense } from "react";
import WelcomePageClient from "./page-client";

/** Landing page after an invite or password-reset link: choose a password. */
export default function WelcomePage() {
  return (
    <Suspense
      fallback={<div className="flex min-h-screen items-center justify-center atmosphere-login text-muted">Loading…</div>}
    >
      <WelcomePageClient />
    </Suspense>
  );
}
