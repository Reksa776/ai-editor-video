import Link from "next/link";
import { ArrowRight, HardDrive, Layers, Video } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { CreateProjectDialog } from "@/features/projects/create-project-dialog";
import { EmptyState } from "@/features/projects/empty-state";
import { ProjectList } from "@/features/projects/project-list";
import { databaseStatus, getDashboardSummary } from "@/features/projects/queries";
import { formatBytes } from "@/lib/utils";

export const dynamic = "force-dynamic";

function StatTile({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Video;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center gap-2 text-dim">
        <Icon className="h-3.5 w-3.5" />
        <span className="label">{label}</span>
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-ink">{value}</p>
      <p className="mt-1 text-[11px] text-dim/80">{hint}</p>
    </div>
  );
}

export default async function DashboardPage() {
  const status = databaseStatus();
  const summary = await getDashboardSummary();

  return (
    <>
      <AppHeader
        title="Dashboard"
        description="Projects, source footage, and storage for this workspace."
        database={status}
        action={<CreateProjectDialog disabled={status !== "configured"} />}
      />

      <div className="space-y-8 px-8 py-8">
        {!summary.ok ? (
          <div className="rounded-lg border border-warn/30 bg-warn/[0.06] px-4 py-3">
            <p className="text-sm font-medium text-warn">Database unavailable</p>
            <p className="mt-1 text-xs leading-relaxed text-dim">
              {summary.code === "NOT_CONFIGURED"
                ? summary.reason
                : `Could not reach MySQL: ${summary.reason}`}
            </p>
            <p className="mt-2 font-mono text-[11px] text-dim/70">
              cp .env.example .env.local · npm run db:migrate:deploy
            </p>
          </div>
        ) : null}

        <section className="grid gap-4 sm:grid-cols-3">
          <StatTile
            icon={Layers}
            label="Projects"
            value={summary.ok ? String(summary.data.projectCount) : "—"}
            hint={summary.ok ? "Persisted in MySQL" : "Waiting for database"}
          />
          <StatTile
            icon={Video}
            label="Source assets"
            value={summary.ok ? String(summary.data.assetCount) : "—"}
            hint={summary.ok ? "Originals on local disk" : "Waiting for database"}
          />
          <StatTile
            icon={HardDrive}
            label="Storage used"
            value={summary.ok ? formatBytes(summary.data.storageBytes) : "—"}
            hint="data/projects on /home (never /tmp)"
          />
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Recent projects</h2>
            <Button asChild variant="ghost" size="sm">
              <Link href="/projects">
                All projects
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>

          {summary.ok && summary.data.recent.length > 0 ? (
            <ProjectList projects={summary.data.recent} />
          ) : (
            <EmptyState
              title={summary.ok ? "No projects yet" : "Projects unavailable"}
              description={
                summary.ok
                  ? "Create a project to start uploading footage. Transcription and AI editing arrive in later phases."
                  : "Once MySQL credentials are in .env.local, your projects will appear here."
              }
              action={status === "configured" ? <CreateProjectDialog /> : undefined}
            />
          )}
        </section>
      </div>
    </>
  );
}
