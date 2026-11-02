import { NextResponse } from "next/server";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { maxUploadBytes } from "@/lib/env";
import { ulid } from "@/lib/id";
import { getPrisma } from "@/lib/prisma";
import { LocalBlobStore, StorageError } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Streaming video upload.
 *
 * The request body is piped straight to disk in chunks — the file is never
 * held in memory. Headers:
 *   content-type   : the video MIME type
 *   x-file-name    : original filename (used only for display / extension)
 *   content-length : optional, checked against MAX_UPLOAD_BYTES early
 * Query:
 *   projectId      : must reference an existing project
 *
 * Requires the database (it verifies the project and records the asset). When
 * MySQL is not configured this route returns 503 rather than silently storing
 * orphaned files.
 */
export async function POST(request: Request): Promise<Response> {
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId query parameter is required" }, { status: 400 });
  }

  const limit = maxUploadBytes();
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > limit) {
    return NextResponse.json(
      { error: `File exceeds the ${Math.round(limit / (1024 * 1024))} MB limit` },
      { status: 413 },
    );
  }
  if (!request.body) {
    return NextResponse.json({ error: "Request body is empty" }, { status: 400 });
  }

  let prisma;
  try {
    prisma = getPrisma();
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : "Database unavailable";
    return NextResponse.json(
      { error: `Database is not available: ${message}`, code: "DB_UNAVAILABLE" },
      { status: 503 },
    );
  }

  const store = new LocalBlobStore();
  await mkdir(path.join(store.rootPath, projectId, "source"), { recursive: true });

  const assetId = ulid();
  const filename = decodeURIComponent(request.headers.get("x-file-name") ?? "upload.mp4");
  const mimeType = request.headers.get("content-type") ?? "application/octet-stream";

  let stored;
  try {
    stored = await store.saveUpload({
      projectId,
      assetId,
      filename,
      mimeType,
      stream: request.body,
      maxBytes: limit,
    });
  } catch (error) {
    if (error instanceof StorageError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  try {
    const asset = await prisma.asset.create({
      data: {
        id: assetId,
        projectId,
        kind: "SOURCE",
        relPath: stored.relPath,
        filename: stored.filename,
        mimeType: stored.mimeType,
        sha256: stored.sha256,
        bytes: BigInt(stored.bytes),
      },
      select: { id: true, relPath: true, sha256: true, bytes: true },
    });

    return NextResponse.json(
      {
        asset: {
          id: asset.id,
          relPath: asset.relPath,
          sha256: asset.sha256,
          bytes: Number(asset.bytes),
        },
      },
      { status: 201 },
    );
  } catch (error) {
    // Never leave an orphaned file behind if the record could not be written.
    await store.remove(stored.relPath).catch(() => undefined);
    const message = error instanceof Error ? error.message.split("\n")[0] : "Failed to record asset";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
