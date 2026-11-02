import { Film } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line px-6 py-16 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-full border border-line bg-raised text-dim">
        <Film className="h-5 w-5" />
      </div>
      <p className="mt-4 text-sm font-medium text-ink">{title}</p>
      <p className="mt-1 max-w-sm text-sm leading-relaxed text-dim">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
