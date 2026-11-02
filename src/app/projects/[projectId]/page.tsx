import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileVideo } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { UploadPanel } from "@/features/projects/upload-panel";
import { databaseStatus, getProject } from "@/features/projects/queries";
import { formatBytes, formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const status = databaseStatus();
  const project = await getProject(projectId);

  if (!project.ok && project.reason === "Project not found") {
    notFound();
  }

  if (!project.ok) {
    return (
      <>
        <AppHeader title="Project" database={status} />
        <div className="px-8 py-8">
          <div className="rounded-lg border border-warn/30 bg-warn/[0.06] px-4 py-3">
            <p className="text-sm font-medium text-warn">Cannot load project</p>
            <p className="mt-1 text-xs leading-relaxed text-dim">{project.reason}</p>
          </div>
          <Button asChild variant="ghost" size="sm" className="mt-4 -ml-2">
            <Link href="/projects">
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to projects
            </Link>
          </Button>
        </div>
      </>
    );
  }

  const { data } = project;

  return (
    <>
      <AppHeader
        title={data.name}
        description={`Project workspace · ${data.assetCount} asset${data.assetCount === 1 ? "" : "s"}`}
        database={status}
        action={
          <Button asChild variant="ghost" size="sm">
            <Link href="/projects">
              <ArrowLeft className="h-3.5 w-3.5" />
              Projects
            </Link>
          </Button>
        }
      />

      <div className="grid gap-6 px-8 py-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <UploadPanel projectId={data.id} disabled={status !== "configured"} />

          <section>
            <h2 className="mb-3 text-sm font-semibold text-ink">Assets</h2>
            {data.assets.length === 0 ? (
              <div className="rounded-lg border border-dashed border-line px-5 py-10 text-center">
                <FileVideo className="mx-auto h-5 w-5 text-dim" />
                <p className="mt-3 text-sm text-ink">No source footage yet</p>
                <p className="mt-1 text-xs text-dim">Upload an MP4, MOV, MKV, or WebM file above.</p>
              </div>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
                {data.assets.map((asset) => (
                  <li key={asset.id} className="flex items-center gap-4 px-5 py-3.5">
                    <FileVideo className="h-4 w-4 shrink-0 text-dim" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-ink">{asset.filename}</p>
                      <p className="truncate font-mono text-[11px] text-dim">{asset.relPath}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-dim">{formatBytes(Number(asset.bytes))}</p>
                      <p className="text-[11px] text-dim/70">{formatDate(asset.createdAt)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="space-y-4">
          <div className="rounded-lg border border-line bg-surface p-4">
            <p className="label">Project</p>
            <dl className="mt-3 space-y-2.5 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-dim">ID</dt>
                <dd className="truncate font-mono text-ink">{data.id}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-dim">Status</dt>
                <dd className="text-ink">{data.status.toLowerCase()}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-dim">Created</dt>
                <dd className="text-ink">{formatDate(data.createdAt)}</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-lg border border-line bg-surface p-4">
            <p className="label">Not in this phase</p>
            <p className="mt-2 text-xs leading-relaxed text-dim">
              Transcription, AI planning, timeline editing, and export are intentionally absent.
              This page only uploads and records source footage.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
