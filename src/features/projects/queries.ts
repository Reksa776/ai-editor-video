import { ConfigurationError, isDatabaseConfigured } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";

export type DbResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string; code: "NOT_CONFIGURED" | "UNREACHABLE" };

export type ProjectSummary = {
  id: string;
  name: string;
  status: "ACTIVE" | "ARCHIVED";
  createdAt: Date;
  assetCount: number;
};

export type DashboardSummary = {
  projectCount: number;
  assetCount: number;
  storageBytes: number;
  recent: ProjectSummary[];
};

function describeError(error: unknown): { reason: string; code: "NOT_CONFIGURED" | "UNREACHABLE" } {
  if (error instanceof ConfigurationError) {
    return { reason: error.message, code: "NOT_CONFIGURED" };
  }
  if (error instanceof Error) {
    const firstLine = error.message.split("\n")[0]?.trim() ?? error.name;
    return { reason: firstLine, code: "UNREACHABLE" };
  }
  return { reason: String(error), code: "UNREACHABLE" };
}

/** Configuration status for the UI banner, without touching the network. */
export function databaseStatus(): "configured" | "not_configured" {
  return isDatabaseConfigured() ? "configured" : "not_configured";
}

export async function listProjects(limit = 50): Promise<DbResult<ProjectSummary[]>> {
  try {
    const prisma = getPrisma();
    const rows = await prisma.project.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { _count: { select: { assets: true } } },
    });
    return {
      ok: true,
      data: rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        createdAt: row.createdAt,
        assetCount: row._count.assets,
      })),
    };
  } catch (error) {
    return { ok: false, ...describeError(error) };
  }
}

export async function getDashboardSummary(): Promise<DbResult<DashboardSummary>> {
  try {
    const prisma = getPrisma();
    const [projectCount, assetAggregate, recentRows] = await Promise.all([
      prisma.project.count(),
      prisma.asset.aggregate({ _count: { _all: true }, _sum: { bytes: true } }),
      prisma.project.findMany({
        orderBy: { createdAt: "desc" },
        take: 5,
        include: { _count: { select: { assets: true } } },
      }),
    ]);

    return {
      ok: true,
      data: {
        projectCount,
        assetCount: assetAggregate._count._all,
        storageBytes: Number(assetAggregate._sum.bytes ?? 0n),
        recent: recentRows.map((row) => ({
          id: row.id,
          name: row.name,
          status: row.status,
          createdAt: row.createdAt,
          assetCount: row._count.assets,
        })),
      },
    };
  } catch (error) {
    return { ok: false, ...describeError(error) };
  }
}

export async function getProject(projectId: string): Promise<DbResult<ProjectSummary & { assets: { id: string; filename: string; relPath: string; bytes: bigint; sha256: string; createdAt: Date }[] }>> {
  try {
    const prisma = getPrisma();
    const row = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        _count: { select: { assets: true } },
        assets: {
          orderBy: { createdAt: "desc" },
          select: { id: true, filename: true, relPath: true, bytes: true, sha256: true, createdAt: true },
        },
      },
    });
    if (!row) {
      return { ok: false, reason: "Project not found", code: "UNREACHABLE" };
    }
    return {
      ok: true,
      data: {
        id: row.id,
        name: row.name,
        status: row.status,
        createdAt: row.createdAt,
        assetCount: row._count.assets,
        assets: row.assets,
      },
    };
  } catch (error) {
    return { ok: false, ...describeError(error) };
  }
}
