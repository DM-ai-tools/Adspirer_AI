import { v2 as cloudinary } from "cloudinary";
import { getConfig } from "@/lib/config";
import { isCloudinaryConfigured } from "@/lib/creatives/cloudinary";

export type UploadResourceType = "image" | "video";

export type SignedUpload = {
  uploadUrl: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
  tags: string;
  resourceType: UploadResourceType;
};

/**
 * Sign a direct browser → Cloudinary upload. The file never passes through our
 * server, so serverless body limits don't apply to videos, and the browser can
 * report real upload progress. The API secret stays here.
 */
export function signClientUpload(input: {
  clientId: string;
  resourceType: UploadResourceType;
}): SignedUpload {
  if (!isCloudinaryConfigured()) {
    throw new Error(
      "Cloudinary is not configured. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET to .env.local, then restart the dev server.",
    );
  }
  const config = getConfig();
  const timestamp = Math.round(Date.now() / 1000);
  const folder = `spendsmith/clients/${input.clientId}/uploads`;
  const tags = "spendsmith,operator-upload";
  const signature = cloudinary.utils.api_sign_request(
    { folder, tags, timestamp },
    config.CLOUDINARY_API_SECRET!,
  );
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${config.CLOUDINARY_CLOUD_NAME}/${input.resourceType}/upload`,
    apiKey: config.CLOUDINARY_API_KEY!,
    timestamp,
    signature,
    folder,
    tags,
    resourceType: input.resourceType,
  };
}
