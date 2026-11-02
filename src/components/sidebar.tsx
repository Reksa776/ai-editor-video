"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Clapperboard, FolderOpen, LayoutDashboard, Settings, Upload } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, enabled: true },
  { href: "/projects", label: "Projects", icon: FolderOpen, enabled: true },
  { href: "/exports", label: "Exports", icon: Upload, enabled: false },
  { href: "/settings", label: "Settings", icon: Settings, enabled: false },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex items-center gap-2.5 border-b border-line px-5 py-4">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-accent/12 text-accent">
          <Clapperboard className="h-4 w-4" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold tracking-tight">AI Video Editor</p>
          <p className="text-[11px] text-dim">Phase 1 · foundation</p>
        </div>
      </div>

      <nav className="flex-1 space-y-1 p-3">
        {NAV.map((item) => {
          const active =
            item.enabled && (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href));
          const Icon = item.icon;

          if (!item.enabled) {
            return (
              <div
                key={item.href}
                aria-disabled="true"
                title="Available in a later phase"
                className="flex cursor-not-allowed items-center gap-2.5 rounded-md px-3 py-2 text-sm text-dim/50"
              >
                <Icon className="h-4 w-4" />
                <span>{item.label}</span>
                <span className="ml-auto text-[10px] uppercase tracking-wider text-dim/40">soon</span>
              </div>
            );
          }

          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                active ? "bg-raised text-ink" : "text-dim hover:bg-raised/60 hover:text-ink",
              )}
            >
              <Icon className={cn("h-4 w-4", active && "text-accent")} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-line p-3">
        <p className="px-2 text-[11px] leading-relaxed text-dim/70">
          Local workspace · CPU rendering
          <br />
          One job at a time
        </p>
      </div>
    </aside>
  );
}
