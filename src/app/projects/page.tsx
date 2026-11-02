import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { CreateProjectDialog } from "@/features/projects/create-project-dialog";
import { EmptyState } from "@/features/projects/empty-state";
import { ProjectList } from "@/features/projects/project-list";
import { databaseStatus, listProjects } from "@/features/projects/queries";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const status = databaseStatus();
  const projects = await listProjects();

  return (
    <>
      <AppHeader
        title="Projects"
        description="Each project owns one or more source videos stored on local disk."
        database={status}
        action={<CreateProjectDialog disabled={status !== "configured"} />}
      />

      <div className="px-8 py-8">
        {!projects.ok ? (
          <div className="rounded-lg border border-warn/30 bg-warn/[0.06] px-4 py-3">
            <p className="text-sm font-medium text-warn">Database unavailable</p>
            <p className="mt-1 text-xs leading-relaxed text-dim">
              {projects.code === "NOT_CONFIGURED"
                ? projects.reason
                : `Could not reach MySQL: ${projects.reason}`}
            </p>
          </div>
        ) : projects.data.length > 0 ? (
          <ProjectList projects={projects.data} />
        ) : (
          <EmptyState
            title="No projects yet"
            description="Create your first project, then upload a source video to the project workspace."
            action={status === "configured" ? <CreateProjectDialog /> : undefined}
          />
        )}

        <p className="mt-6 text-xs text-dim/70">
          Looking for export history or settings? Those arrive with the phases that implement them.
        </p>
        <Button asChild variant="ghost" size="sm" className="mt-2 -ml-2">
          <Link href="/">Back to dashboard</Link>
        </Button>
      </div>
    </>
  );
}
