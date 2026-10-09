#!/usr/bin/env node
/**
 * Move creative stills stored as base64 in Postgres (creative_drafts.image_b64)
 * to Cloudinary, keep only the URL, and free the database space.
 *
 *   Dry run:  node --env-file=.env.local scripts/migrate-creatives-to-cloudinary.mjs
 *   Apply:    node --env-file=.env.local scripts/migrate-creatives-to-cloudinary.mjs --apply
 *
 * A row's base64 is cleared only after its Cloudinary URL answers HTTP 200.
 * Safe to re-run: rows already moved have no base64 left and are skipped.
 */
import { v2 as cloudinary } from "cloudinary";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const env = process.env;

for (const key of [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
]) {
  if (!env[key]) {
    console.error(`${key} is required (run with --env-file=.env.local).`);
    process.exit(1);
  }
}

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
});

// List ids first; pull each row's bytes one at a time to keep memory flat.
const { data: ids, error: listError } = await supabase
  .from("creative_drafts")
  .select("id")
  .not("image_b64", "is", null);
if (listError) {
  console.error(`Could not list drafts: ${listError.message}`);
  process.exit(1);
}

let moved = 0;
let failed = 0;
let bytes = 0;
for (const { id } of ids ?? []) {
  const { data: row, error } = await supabase
    .from("creative_drafts")
    .select("id, client_id, headline, image_mime, image_b64")
    .eq("id", id)
    .maybeSingle();
  if (error || !row?.image_b64) continue;
  const size = Math.round((row.image_b64.length * 3) / 4);
  bytes += size;

  if (!APPLY) {
    console.log(`  would move ${row.id} (${(size / 1048576).toFixed(2)} MB)`);
    continue;
  }

  try {
    const result = await cloudinary.uploader.upload(
      `data:${row.image_mime || "image/png"};base64,${row.image_b64}`,
      {
        resource_type: "image",
        folder: `spendsmith/clients/${row.client_id}`,
        public_id: row.id,
        overwrite: true,
        unique_filename: false,
        tags: ["spendsmith", "meta-creative", "backfill"],
        context: { client_id: row.client_id, draft_id: row.id },
      },
    );
    const url = result.secure_url;
    const check = url ? await fetch(url, { method: "HEAD" }) : null;
    if (!check?.ok) throw new Error(`uploaded URL not reachable (${check?.status ?? "no url"})`);

    const { error: updateError } = await supabase
      .from("creative_drafts")
      .update({
        image_url: url,
        image_b64: null,
        image_mime: result.format ? `image/${result.format}` : row.image_mime,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (updateError) throw new Error(updateError.message);
    moved += 1;
    console.log(`  moved ${row.id}`);
  } catch (err) {
    failed += 1;
    console.warn(`  failed ${row.id}: ${err instanceof Error ? err.message : err}`);
  }
}

const total = (ids ?? []).length;
console.log(
  APPLY
    ? `Moved ${moved} of ${total} draft(s) to Cloudinary; ${failed} failed; ${(bytes / 1048576).toFixed(1)} MB of base64 processed.`
    : `${total} draft(s) still store images in Postgres (${(bytes / 1048576).toFixed(1)} MB). Re-run with --apply to move them.`,
);
process.exitCode = failed ? 1 : 0;
