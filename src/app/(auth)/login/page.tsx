import { Suspense } from "react";
import LoginPageClient from "./page-client";

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center atmosphere-login text-muted">
          Loading…
        </div>
      }
    >
      <LoginPageClient />
    </Suspense>
  );
}
