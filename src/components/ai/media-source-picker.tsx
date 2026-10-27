"use client";

import { useRef, useState } from "react";
import { Check, Copy, Link2, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { uploadMediaFile, validateMediaFile } from "@/lib/media/client-upload";

type Props = {
  kind: "image" | "video";
  clientId?: string;
  disabled?: boolean;
  /** Called with the public HTTPS URL once it is ready (pasted or uploaded). */
  onReady: (url: string) => void;
};

/** Link-or-upload chooser. A computer upload ends as a Cloudinary public URL. */
export function MediaSourcePicker({ kind, clientId, disabled, onReady }: Props) {
  const [mode, setMode] = useState<"choose" | "link" | "upload">("choose");
  const [link, setLink] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const label = kind === "image" ? "image" : "video";

  async function handleFile(file: File) {
    const invalid = validateMediaFile(file, kind);
    if (invalid) {
      toast.error(invalid);
      return;
    }
    if (!clientId) {
      toast.error("Pick a client before uploading.");
      return;
    }
    setFileName(file.name);
    setUploading(true);
    setProgress(0);
    setPublicUrl(null);
    try {
      const uploaded = await uploadMediaFile({
        clientId,
        file,
        kind,
        onProgress: setProgress,
      });
      setPublicUrl(uploaded.url);
      toast.success(`${kind === "image" ? "Image" : "Video"} uploaded`);
      onReady(uploaded.url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function submitLink() {
    const value = link.trim();
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:") throw new Error("not https");
    } catch {
      toast.error(`Enter a public https:// link to the ${label}.`);
      return;
    }
    setPublicUrl(value);
    onReady(value);
  }

  async function copyUrl() {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy — select the link instead");
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant={mode === "link" ? "default" : "secondary"}
          className="h-8"
          disabled={disabled || uploading}
          onClick={() => setMode("link")}
        >
          <Link2 className="mr-1 h-3.5 w-3.5" />
          Paste a link
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === "upload" ? "default" : "secondary"}
          className="h-8"
          disabled={disabled || uploading}
          onClick={() => {
            setMode("upload");
            fileRef.current?.click();
          }}
        >
          <Upload className="mr-1 h-3.5 w-3.5" />
          Upload from computer
        </Button>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept={kind === "image" ? "image/png,image/jpeg,image/webp" : "video/mp4,video/quicktime"}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void handleFile(file);
          }}
        />
      </div>

      {mode === "link" && !publicUrl ? (
        <div className="flex gap-2">
          <Input
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder={`https://… public ${label} link`}
            className="h-8 text-xs"
            disabled={disabled}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitLink();
            }}
          />
          <Button type="button" size="sm" className="h-8" disabled={disabled || !link.trim()} onClick={submitLink}>
            Use link
          </Button>
        </div>
      ) : null}

      {uploading ? (
        <div className="space-y-1" role="status" aria-live="polite">
          <p className="flex items-center gap-1.5 text-[11px] text-muted">
            <Loader2 className="h-3 w-3 animate-spin" />
            {progress !== null && progress >= 100
              ? `Finishing ${fileName ?? label} — creating a public link…`
              : `Uploading ${fileName ?? label}… ${progress ?? 0}%`}
          </p>
          <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${progress ?? 0}%` }}
            />
          </div>
        </div>
      ) : null}

      {publicUrl ? (
        <div className="space-y-1 rounded-md border border-border/60 bg-secondary/40 p-2">
          <p className="text-[11px] font-medium text-foreground">
            Public {label} URL
          </p>
          <div className="flex items-center gap-2">
            <a
              href={publicUrl}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1 truncate text-[11px] text-accent underline"
            >
              {publicUrl}
            </a>
            <button
              type="button"
              aria-label="Copy URL"
              onClick={() => void copyUrl()}
              className="rounded-md p-1 text-muted hover:bg-secondary hover:text-foreground"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
