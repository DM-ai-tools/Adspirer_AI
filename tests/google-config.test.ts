import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig, resetConfigCache } from "@/lib/config";

const GOOGLE_VARS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  "GOOGLE_ADS_API_VERSION",
];

function clearGoogleEnv() {
  for (const name of GOOGLE_VARS) vi.stubEnv(name, "");
}

describe("google config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigCache();
  });

  it("is off without any Google variables", () => {
    clearGoogleEnv();
    resetConfigCache();
    const config = getConfig();
    expect(config.hasGoogle).toBe(false);
  });

  it("enables Google, Google Ads included, with just a client id and secret", () => {
    // Google retired developer tokens on 9 Sep 2026: access now comes from the
    // Cloud project that owns the OAuth client, so nothing else is needed.
    clearGoogleEnv();
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "id");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "secret");
    resetConfigCache();
    const config = getConfig();
    expect(config.hasGoogle).toBe(true);
    expect(config).not.toHaveProperty("hasGoogleAds");
    expect(config).not.toHaveProperty("GOOGLE_ADS_DEVELOPER_TOKEN");
  });

  it("strips non-digits from the login customer id", () => {
    clearGoogleEnv();
    vi.stubEnv("GOOGLE_ADS_LOGIN_CUSTOMER_ID", "123-456-7890");
    resetConfigCache();
    expect(getConfig().GOOGLE_ADS_LOGIN_CUSTOMER_ID).toBe("1234567890");
  });
});
