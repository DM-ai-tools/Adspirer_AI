import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
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

let storage: ObjectStorage | null = null;

export function getObjectStorage(): ObjectStorage {
  if (!storage) {
    // TODO: Cloudflare R2 adapter when R2_* env vars are present.
    storage = new LocalMockStorage();
  }
  return storage;
}
