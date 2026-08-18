import { describe, expect, it } from "vitest";
import {
  decryptToken,
  encryptToken,
  TokenVaultError,
} from "@/lib/security/token-vault";

const VALID_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("token vault", () => {
  it("encrypt/decrypt roundtrip", () => {
    process.env.TOKEN_ENCRYPTION_KEY = VALID_KEY;
    const plaintext = "demo_adspirer_access_token_secret";
    const ciphertext = encryptToken(plaintext);

    expect(ciphertext).toMatch(/^v1:/);
    expect(ciphertext).not.toContain(plaintext);
    expect(decryptToken(ciphertext)).toBe(plaintext);
  });

  it("fails closed on bad ciphertext", () => {
    process.env.TOKEN_ENCRYPTION_KEY = VALID_KEY;
    expect(() => decryptToken("not-a-vault-blob")).toThrow(TokenVaultError);
    expect(() => decryptToken("v1:bad:data:tag")).toThrow(TokenVaultError);
    expect(() => decryptToken("")).toThrow(TokenVaultError);
  });

  it("fails closed when decrypting with a different key", () => {
    process.env.TOKEN_ENCRYPTION_KEY = VALID_KEY;
    const ciphertext = encryptToken("sensitive-refresh-token");

    process.env.TOKEN_ENCRYPTION_KEY =
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    expect(() => decryptToken(ciphertext)).toThrow(TokenVaultError);

    // restore for other tests
    process.env.TOKEN_ENCRYPTION_KEY = VALID_KEY;
  });

  it("rejects invalid encryption key material", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "too-short";
    expect(() => encryptToken("x")).toThrow(TokenVaultError);
    process.env.TOKEN_ENCRYPTION_KEY = VALID_KEY;
  });
});
