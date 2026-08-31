/**
 * Shared handler for ?meta_connected= / ?meta_error= query params after OAuth.
 * Shows a toast once, then strips the OAuth params from the URL.
 */
export function handleMetaOAuthReturn(options: {
  searchParams: URLSearchParams | { get(name: string): string | null };
  pathname: string;
  replace: (url: string) => void;
  toastSuccess: (message: string) => void;
  toastError: (message: string) => void;
  onConnected?: () => void;
}): boolean {
  const connected = options.searchParams.get("meta_connected") === "true";
  const metaError = options.searchParams.get("meta_error");
  if (!connected && !metaError) return false;

  if (connected) {
    const name = options.searchParams.get("meta_user");
    const accounts = options.searchParams.get("meta_accounts");
    const accountPart =
      accounts && accounts !== "0"
        ? ` · ${accounts} ad account${accounts === "1" ? "" : "s"} synced`
        : "";
    options.toastSuccess(
      name
        ? `Facebook connected as ${name}${accountPart}`
        : `Facebook connected successfully${accountPart}`,
    );
    options.onConnected?.();
  } else if (metaError) {
    const detail =
      options.searchParams.get("meta_error_description") ||
      options.searchParams.get("meta_error_reason") ||
      metaError;
    options.toastError(`Facebook connect failed: ${detail}`);
  }

  // Strip OAuth flags so refresh doesn't re-toast.
  const next = new URLSearchParams();
  if ("forEach" in options.searchParams) {
    options.searchParams.forEach((value, key) => {
      if (
        key === "meta_connected" ||
        key === "meta_error" ||
        key === "meta_error_reason" ||
        key === "meta_error_description" ||
        key === "meta_user" ||
        key === "meta_accounts"
      ) {
        return;
      }
      next.set(key, value);
    });
  } else {
    // Next.js ReadonlyURLSearchParams still supports forEach; fallback copy known keys.
  }
  const qs = next.toString();
  options.replace(qs ? `${options.pathname}?${qs}` : options.pathname);
  return true;
}
