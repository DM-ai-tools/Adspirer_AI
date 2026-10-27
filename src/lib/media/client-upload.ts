import { apiFetch } from "@/lib/api-client";

export type UploadedMedia = {
  url: string;
  resourceType: "image" | "video";
  bytes: number;
  filename: string;
};

export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

export function validateMediaFile(
  file: File,
  kind: "image" | "video",
): string | null {
  if (!file.type.startsWith(`${kind}/`)) {
    return `Choose ${kind === "image" ? "an image (PNG, JPG, WebP)" : "a video (MP4, MOV)"} file.`;
  }
  const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (file.size > limit) {
    return `That file is ${(file.size / 1048576).toFixed(0)} MB; the limit is ${limit / 1048576} MB.`;
  }
  return null;
}

/**
 * Upload from the computer straight to Cloudinary (signed by our server) and
 * resolve with the public HTTPS URL. `onProgress` receives 0–100.
 */
export async function uploadMediaFile(input: {
  clientId: string;
  file: File;
  kind: "image" | "video";
  onProgress?: (percent: number) => void;
}): Promise<UploadedMedia> {
  const invalid = validateMediaFile(input.file, input.kind);
  if (invalid) throw new Error(invalid);

  const { upload } = await apiFetch<{
    upload: {
      uploadUrl: string;
      apiKey: string;
      timestamp: number;
      signature: string;
      folder: string;
      tags: string;
    };
  }>("/api/media/upload-signature", {
    method: "POST",
    body: JSON.stringify({ clientId: input.clientId, resourceType: input.kind }),
  });

  const form = new FormData();
  form.set("file", input.file);
  form.set("api_key", upload.apiKey);
  form.set("timestamp", String(upload.timestamp));
  form.set("signature", upload.signature);
  form.set("folder", upload.folder);
  form.set("tags", upload.tags);

  return new Promise<UploadedMedia>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", upload.uploadUrl);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        input.onProgress?.(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed: network error."));
    xhr.onload = () => {
      let payload: { secure_url?: string; error?: { message?: string } } = {};
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        /* handled below */
      }
      if (xhr.status >= 200 && xhr.status < 300 && payload.secure_url) {
        resolve({
          url: payload.secure_url,
          resourceType: input.kind,
          bytes: input.file.size,
          filename: input.file.name,
        });
        return;
      }
      reject(
        new Error(
          `Upload failed: ${payload.error?.message ?? `Cloudinary returned ${xhr.status}`}`,
        ),
      );
    };
    xhr.send(form);
  });
}
