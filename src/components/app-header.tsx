import type { ReactNode } from "react";
import { Database, DatabaseZap } from "lucide-react";

type Props = {
  title: string;
  description?: string;
  database: "configured" | "not_configured";
  action?: ReactNode;
};

export function AppHeader({ title, description, database, action }: Props) {
  const configured = database === "configured";
  const Icon = configured ? Database : DatabaseZap;

  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-8 py-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {description ? <p className="mt-1 text-sm text-dim">{description}</p> : null}
      </div>

      <div className="flex items-center gap-3">
        <span
          className={
            configured
              ? "inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent"
              : "inline-flex items-center gap-1.5 rounded-full border border-warn/30 bg-warn/10 px-2.5 py-1 text-[11px] font-medium text-warn"
          }
          title={configured ? "WEB_DATABASE_URL is set" : "WEB_DATABASE_URL is not set"}
        >
          <Icon className="h-3 w-3" />
          {configured ? "Database configured" : "Database not configured"}
        </span>
        {action}
      </div>
    </header>
  );
}
