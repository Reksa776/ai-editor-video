import Link from "next/link";
import { ArrowUpRight, Film } from "lucide-react";
import type { ProjectSummary } from "./queries";
import { formatDate } from "@/lib/utils";

export function ProjectList({ projects }: { projects: ProjectSummary[] }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {projects.map((project) => (
        <li key={project.id}>
          <Link
            href={`/projects/${project.id}`}
            className="group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-raised/60"
          >
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-line bg-canvas text-dim">
              <Film className="h-4 w-4" />
            </div>

            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink">{project.name}</p>
              <p className="mt-0.5 font-mono text-[11px] text-dim">{project.id}</p>
            </div>

            <div className="hidden text-right sm:block">
              <p className="text-xs text-dim">{project.assetCount} asset{project.assetCount === 1 ? "" : "s"}</p>
              <p className="mt-0.5 text-[11px] text-dim/70">{formatDate(project.createdAt)}</p>
            </div>

            {project.status === "ARCHIVED" ? (
              <span className="rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-dim">
                archived
              </span>
            ) : null}

            <ArrowUpRight className="h-4 w-4 text-dim transition-colors group-hover:text-accent" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
