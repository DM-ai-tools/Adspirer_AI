#!/usr/bin/env node
/**
 * Re-encrypt every stored OAuth token under a new TOKEN_ENCRYPTION_KEY.
 *
 * 1. Generate a key:   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * 2. Dry run:          OLD_TOKEN_ENCRYPTION_KEY=<current> NEW_TOKEN_ENCRYPTION_KEY=<new> \
 *                        node --env-file=.env.local scripts/rotate-token-key.mjs
 * 3. Apply:            same command with --apply
 * 4. Set TOKEN_ENCRYPTION_KEY=<new> in .env.local / your host, then restart.
 *
 * Handles both ciphertext formats in the codebase:
 *   v1:<iv>:<data>:<tag>   (src/lib/security/token-vault.ts)
 *   <iv>:<tag>:<data>      (src/lib/meta/token-crypto.ts)
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");

function decodeKey(name) {
  const raw = (process.env[name] ?? "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  const buf = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (buf.length === 32) return buf;
  console.error(`${name} must be a 32-byte key (64 hex chars or base64).`);
  process.exit(1);
}

const oldKey = decodeKey("OLD_TOKEN_ENCRYPTION_KEY");
const newKey = decodeKey("NEW_TOKEN_ENCRYPTION_KEY");
if (oldKey.equals(newKey)) {
  console.error("OLD and NEW keys are identical — nothing to rotate.");
  process.exit(1);
}

function decrypt(value, key) {
  const parts = value.split(":");
  let iv, tag, data, format;
  if (parts.length === 4 && parts[0] === "v1") {
    [, iv, data, tag] = parts;
    format = "v1";
  } else if (parts.length === 3) {
    [iv, tag, data] = parts;
    format = "meta";
  } else {
    throw new Error("unrecognised ciphertext format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"), {
    authTagLength: 16,
  });
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(data, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return { plain, format };
}

function encrypt(plain, key, format) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return format === "v1"
    ? ["v1", iv.toString("base64"), data.toString("base64"), tag.toString("base64")].join(":")
    : [iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(":");
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (use --env-file=.env.local).");
  process.exit(1);
}
const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

const TARGETS = [
  { table: "meta_oauth_tokens", columns: ["access_token_encrypted"] },
  {
    table: "adspirer_service_account",
    columns: ["access_token_encrypted", "refresh_token_encrypted"],
  },
];

let rotated = 0;
let failed = 0;
for (const { table, columns } of TARGETS) {
  const { data, error } = await supabase.from(table).select(["id", ...columns].join(", "));
  if (error) {
    console.warn(`skip ${table}: ${error.message}`);
    continue;
  }
  for (const row of data ?? []) {
    const update = {};
    for (const column of columns) {
      const value = row[column];
      if (!value) continue;
      try {
        const { plain, format } = decrypt(value, oldKey);
        update[column] = encrypt(plain, newKey, format);
      } catch (err) {
        failed += 1;
        console.warn(`  ${table}.${column} id=${row.id}: cannot decrypt with OLD key (${err.message})`);
      }
    }
    if (!Object.keys(update).length) continue;
    rotated += 1;
    if (APPLY) {
      const { error: updateError } = await supabase.from(table).update(update).eq("id", row.id);
      if (updateError) {
        failed += 1;
        console.warn(`  ${table} id=${row.id}: update failed (${updateError.message})`);
      }
    }
  }
}

console.log(
  `${APPLY ? "Rotated" : "Would rotate"} ${rotated} row(s); ${failed} problem(s).` +
    (APPLY ? "" : " Re-run with --apply to write changes."),
);
process.exitCode = failed ? 1 : 0;
