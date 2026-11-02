"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/utils";

type UploadState =
  | { phase: "idle" }
  | { phase: "uploading"; percent: number; filename: string }
  | { phase: "done"; filename: string; sha256: string; bytes: number }
  | { phase: "error"; message: string };

const ACCEPTED = "video/mp4,video/quicktime,video/x-matroska,video/webm";

export function UploadPanel({ projectId, disabled = false }: { projectId: string; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>({ phase: "idle" });
  const router = useRouter();

  function upload(file: File) {
    setState({ phase: "uploading", percent: 0, filename: file.name });

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/upload?projectId=${encodeURIComponent(projectId)}`);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setState({
          phase: "uploading",
          percent: Math.round((event.loaded / event.total) * 100),
          filename: file.name,
        });
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const body = JSON.parse(xhr.responseText) as { asset: { sha256: string; bytes: number } };
        setState({
          phase: "done",
          filename: file.name,
          sha256: body.asset.sha256,
          bytes: body.asset.bytes,
        });
        router.refresh();
      } else {
        let message = `Upload failed (${xhr.status})`;
        try {
          const parsed = JSON.parse(xhr.responseText) as { error?: string };
          if (parsed.error) message = parsed.error;
        } catch {
          /* keep the status-based message */
        }
        setState({ phase: "error", message });
      }
    };

    xhr.onerror = () => setState({ phase: "error", message: "Network error during upload" });
    xhr.send(file);
  }

  const busy = state.phase === "uploading";

  return (
    <div className="rounded-lg border border-line bg-surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Source video</h2>
          <p className="mt-1 text-xs leading-relaxed text-dim">
            Streamed to <span className="font-mono">data/projects/{projectId}/source/</span>. The
            original is never modified.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
          {busy ? "Uploading…" : "Select video"}
        </Button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) upload(file);
          event.target.value = "";
        }}
      />

      {disabled ? (
        <p className="mt-4 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          Uploads are disabled until the database is configured — the asset record cannot be
          written without it.
        </p>
      ) : null}

      {state.phase === "uploading" ? (
        <div className="mt-4">
          <div className="flex items-center justify-between text-xs text-dim">
            <span className="truncate">{state.filename}</span>
            <span className="font-mono">{state.percent}%</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-150"
              style={{ width: `${state.percent}%` }}
            />
          </div>
        </div>
      ) : null}

      {state.phase === "done" ? (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-accent/30 bg-accent/5 px-3 py-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <div className="min-w-0 text-xs">
            <p className="text-ink">
              {state.filename} · {formatBytes(state.bytes)}
            </p>
            <p className="mt-0.5 truncate font-mono text-[11px] text-dim">sha256 {state.sha256}</p>
          </div>
        </div>
      ) : null}

      {state.phase === "error" ? (
        <p role="alert" className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
