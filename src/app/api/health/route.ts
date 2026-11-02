import { NextResponse } from "next/server";
import { isDatabaseConfigured, storageRoot } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness plus configuration readiness. Does not touch the database. */
export async function GET(): Promise<Response> {
  return NextResponse.json({
    status: "ok",
    service: "web",
    database: isDatabaseConfigured() ? "configured" : "not_configured",
    storageRoot: storageRoot(),
    timestamp: new Date().toISOString(),
  });
}
