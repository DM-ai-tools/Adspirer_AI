import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/observability/logger";

export type StoredObject = {
  key: string;
  contentType: string;
  size: number;
  url: string;
};

export interface ObjectStorage {
  readonly name: string;
  put(
    key: string,
    data: Buffer | Uint8Array | string,
    contentType?: string,
  ): Promise<StoredObject>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  getPublicUrl(key: string): string;
}

/**
 * Local filesystem mock for creatives / exports when R2 is not configured.
 */
export class LocalMockStorage implements ObjectStorage {
  readonly name = "LocalMockStorage";
  private readonly root: string;

  constructor(rootDir?: string) {
    this.root = rootDir ?? path.join(process.cwd(), ".data", "storage");
  }

  private resolve(key: string): string {
    const safe = key.replace(/\.\./g, "").replace(/^\/+/, "");
    return path.join(this.root, safe);
  }

  async put(
    key: string,
    data: Buffer | Uint8Array | string,
    contentType = "application/octet-stream",
  ): Promise<StoredObject> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    await writeFile(full, buf);
    logger.debug("Stored object in local mock storage", {
      key,
      size: buf.length,
      contentType,
    });
    return {
      key,
      contentType,
      size: buf.length,
      url: this.getPublicUrl(key),
    };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(key));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolve(key));
    } catch {
      // idempotent
    }
  }

  getPublicUrl(key: string): string {
    return `/local-storage/${key.replace(/^\/+/, "")}`;
  }
}

/** Each path segment made safe for a bucket key, deterministically (the same key always maps to the same object). */
export function bucketPath(key: string): string {
  return key
    .replace(/\.\./g, "")
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[^A-Za-z0-9._-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`))
    .join("/");
}

/** The slice of the Supabase Storage client this adapter needs (so a test can stand in for it). */
export type BucketApi = {
  upload(path: string, data: Buffer, options: { contentType: string; upsert: boolean }): Promise<{ error: { message: string } | null }>;
  download(path: string): Promise<{ data: Blob | null; error: { message: string; status?: number; statusCode?: string | number } | null }>;
  remove(paths: string[]): Promise<{ error: { message: string } | null }>;
};

export const STORAGE_BUCKET = "app-files";

/** A failure of the connection, as opposed to an answer from the store. */
const TRANSIENT = /fetch failed|timeout|timed out|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|bad gateway|service unavailable|gateway time/i;

/**
 * Durable storage in a private Supabase Storage bucket. Files outlive a restart or a redeploy of the
 * app server and are the same for every instance, which a folder on the server's own disk is not.
 * A read that finds nothing in the bucket looks in the old local folder, so files saved before this
 * existed on a machine that still has them keep working.
 */
export class SupabaseBucketStorage implements ObjectStorage {
  readonly name = "SupabaseBucketStorage";
  private ready: Promise<void> | null = null;

  constructor(
    private readonly bucket: () => Promise<BucketApi>,
    private readonly ensureBucket: () => Promise<void> = async () => undefined,
    private readonly fallback: ObjectStorage | null = null,
    /** A connection that drops is tried again a few times before it counts as a failure. */
    private readonly retry: { attempts: number; backoffMs: number } = { attempts: 6, backoffMs: 400 },
  ) {}

  private async api(): Promise<BucketApi> {
    this.ready ??= this.ensureBucket().catch((error) => {
      this.ready = null;
      throw error;
    });
    await this.ready;
    return this.bucket();
  }

  /** Run one call against the bucket, again after a short wait when the connection itself failed (never for an answer such as "not found"). */
  private async call<T extends { error: { message: string } | null }>(run: (api: BucketApi) => Promise<T>): Promise<T> {
    let last: T | null = null;
    for (let i = 0; i < this.retry.attempts; i += 1) {
      try {
        last = await run(await this.api());
      } catch (error) {
        last = { error: { message: error instanceof Error ? error.message : String(error) } } as T;
      }
      if (!last.error || !TRANSIENT.test(last.error.message)) return last;
      if (i < this.retry.attempts - 1) await new Promise((r) => setTimeout(r, this.retry.backoffMs * (i + 1)));
    }
    return last!;
  }

  async put(key: string, data: Buffer | Uint8Array | string, contentType = "application/octet-stream"): Promise<StoredObject> {
    const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    const { error } = await this.call((api) => api.upload(bucketPath(key), buf, { contentType, upsert: true }));
    if (error) throw new Error(`Could not save ${key}: ${error.message}`);
    return { key, contentType, size: buf.length, url: this.getPublicUrl(key) };
  }

  async get(key: string): Promise<Buffer | null> {
    const { data, error } = await this.call((api) => api.download(bucketPath(key)));
    if (data && !error) return Buffer.from(await data.arrayBuffer());
    const missing = !error || /not.?found|does not exist|404|400/i.test(`${error.message} ${error.status ?? ""} ${error.statusCode ?? ""}`);
    // A file that is not there is an answer (null); a store that could not be reached is an error, never "missing".
    if (!missing) throw new Error(`Could not read ${key}: ${error!.message}`);
    return this.fallback ? this.fallback.get(key) : null;
  }

  async delete(key: string): Promise<void> {
    await this.call((api) => api.remove([bucketPath(key)])).catch(() => undefined);
    if (this.fallback) await this.fallback.delete(key);
  }

  /** The bucket is private: files are served through the app's own authorised routes, never by a public or expiring address. */
  getPublicUrl(key: string): string {
    return `/local-storage/${key.replace(/^\/+/, "")}`;
  }
}

let storage: ObjectStorage | null = null;

function supabaseStorage(): ObjectStorage {
  const client = async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    return createAdminClient();
  };
  return new SupabaseBucketStorage(
    async () => (await client()).storage.from(STORAGE_BUCKET) as unknown as BucketApi,
    async () => {
      const { error } = await (await client()).storage.createBucket(STORAGE_BUCKET, { public: false });
      if (error && !/exist|duplicate/i.test(error.message)) throw new Error(`The storage bucket could not be prepared: ${error.message}`);
    },
    new LocalMockStorage(),
  );
}

/** True when files are kept somewhere that survives a restart or redeploy of this server. */
export function storageIsDurable(): boolean {
  return getObjectStorage().name !== "LocalMockStorage";
}

export function getObjectStorage(): ObjectStorage {
  if (!storage) {
    const config = getConfig();
    if (config.hasSupabase && config.SUPABASE_SERVICE_ROLE_KEY && !config.isDemoMode) {
      storage = supabaseStorage();
    } else {
      storage = new LocalMockStorage();
      if (config.NODE_ENV === "production") logger.error("Files are being stored on this server's own disk and will be lost on a restart or redeploy. Configure Supabase so they are kept in the storage bucket.");
    }
  }
  return storage;
}

/** For tests: forget the chosen store so the next call picks again. */
export function resetObjectStorage(next: ObjectStorage | null = null): void {
  storage = next;
}
