/**
 * Browser-only: shrink a picked image to a JPEG data URI small enough to send in a JSON request
 * (about 100-400 KB). The server checks and re-encodes it again, so this only has to be good enough
 * to keep the upload light.
 */
const MAX_CHARS = 900_000;

export async function shrinkImageToDataUri(file: File): Promise<string> {
  if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) throw new Error("Use a JPG, PNG or WebP image.");
  const bitmap = await createImageBitmap(file);
  try {
    for (const [side, quality] of [
      [1280, 0.82],
      [1024, 0.72],
      [800, 0.62],
    ] as const) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("This browser could not prepare the image.");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const uri = canvas.toDataURL("image/jpeg", quality);
      if (uri.length <= MAX_CHARS) return uri;
    }
    throw new Error("That image is too detailed to upload. Try a smaller one.");
  } finally {
    bitmap.close();
  }
}
