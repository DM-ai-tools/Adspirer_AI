import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const VERSION_PREFIX = "v1";

export class TokenVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenVaultError";
  }
}

function decodeEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();

  // 64-char hex → 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  // base64 (standard or url-safe)
  try {
    const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
    const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    const buf = Buffer.from(normalized + pad, "base64");
    if (buf.length === 32) return buf;
  } catch {
    // fall through
  }

  throw new TokenVaultError(
    "TOKEN_ENCRYPTION_KEY must be a 32-byte key encoded as 64-char hex or base64",
  );
}

function getKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    // Deterministic demo key only when DEMO_MODE is enabled — never for production ads.
    if (process.env.DEMO_MODE === "true" || process.env.ADS_EXECUTION_MODE === "mock") {
      return Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");
    }
    throw new TokenVaultError("TOKEN_ENCRYPTION_KEY is required");
  }
  return decodeEncryptionKey(raw);
}

/**
 * Encrypt a secret with AES-256-GCM.
 * Output format: `v1:<iv_b64>:<ciphertext_b64>:<tag_b64>`
 * Never log plaintext tokens.
 */
export function encryptToken(plaintext: string): string {
  if (!plaintext) {
    throw new TokenVaultError("Cannot encrypt empty token");
  }

  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    VERSION_PREFIX,
    iv.toString("base64"),
    encrypted.toString("base64"),
    tag.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a vault ciphertext. Fail closed on any parse/auth failure.
 * Never log plaintext tokens or intermediate buffers.
 */
export function decryptToken(ciphertext: string): string {
  if (!ciphertext) {
    throw new TokenVaultError("Cannot decrypt empty ciphertext");
  }

  try {
    const parts = ciphertext.split(":");
    if (parts.length !== 4 || parts[0] !== VERSION_PREFIX) {
      throw new TokenVaultError("Invalid ciphertext format");
    }

    const [, ivB64, dataB64, tagB64] = parts;
    const key = getKey();
    const iv = Buffer.from(ivB64, "base64");
    const data = Buffer.from(dataB64, "base64");
    const tag = Buffer.from(tagB64, "base64");

    if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH) {
      throw new TokenVaultError("Invalid ciphertext components");
    }

    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (error) {
    if (error instanceof TokenVaultError) throw error;
    // Fail closed — do not include underlying crypto details that might leak material.
    throw new TokenVaultError("Token decryption failed");
  }
}

export function isEncryptedToken(value: string): boolean {
  return value.startsWith(`${VERSION_PREFIX}:`) && value.split(":").length === 4;
}
