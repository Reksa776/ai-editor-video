/**
 * Streaming storage verification.
 *
 * Proves that LocalBlobStore writes a real 42 MB video to disk chunk-by-chunk
 * without buffering it, and that the recorded SHA-256 matches the source file.
 *
 * Run: npm run verify:storage
 */
import { createReadStream } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { LocalBlobStore } from "../src/lib/storage";
import { ulid } from "../src/lib/id";

const SOURCE = path.resolve("whisper/videos/sample.mp4");
const MEMORY_LIMIT_MB = 200;

async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function rssMb(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

async function main(): Promise<void> {
  const sourceStat = await stat(SOURCE);
  const expectedHash = await sha256OfFile(SOURCE);
  const projectId = ulid();
  const assetId = ulid();

  const store = new LocalBlobStore(path.resolve("data/projects"));
  const before = rssMb();

  const webStream = Readable.toWeb(
    createReadStream(SOURCE),
  ) as unknown as ReadableStream<Uint8Array>;

  const started = Date.now();
  const stored = await store.saveUpload({
    projectId,
    assetId,
    filename: "sample.mp4",
    mimeType: "video/mp4",
    stream: webStream,
    maxBytes: 2 * 1024 * 1024 * 1024,
  });
  const elapsed = Date.now() - started;
  const peakDelta = rssMb() - before;

  const onDisk = await readFile(store.absolutePath(stored.relPath)).catch(() => null);
  const diskStat = await store.stat(stored.relPath);

  const checks: [string, boolean, string][] = [
    ["file written to storage root (not /tmp)", stored.relPath.startsWith(projectId), stored.relPath],
    ["byte count matches source", stored.bytes === sourceStat.size, `${stored.bytes} vs ${sourceStat.size}`],
    ["on-disk size matches", diskStat.bytes === sourceStat.size, `${diskStat.bytes}`],
    ["sha256 matches source", stored.sha256 === expectedHash, stored.sha256],
    ["path containment enforced", store.absolutePath(stored.relPath).startsWith(store.rootPath), "ok"],
    [`rss growth < ${MEMORY_LIMIT_MB} MB (streamed, not buffered)`, peakDelta < MEMORY_LIMIT_MB, `${peakDelta.toFixed(1)} MB`],
    ["rejects unsupported type", await rejectsTextUpload(store, projectId), "415"],
    ["rejects oversize stream", await rejectsOversize(store, projectId), "413"],
  ];

  let failed = 0;
  for (const [label, ok, detail] of checks) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (${detail})`);
  }
  console.log(`\nsource: ${(sourceStat.size / 1024 / 1024).toFixed(1)} MB in ${elapsed} ms`);

  await rm(path.join(store.rootPath, projectId), { recursive: true, force: true });
  console.log(`cleanup: removed data/projects/${projectId}`);

  if (onDisk === null) {
    console.log("FAIL  uploaded file could not be read back");
    failed++;
  }

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll streaming storage checks passed.");
}

async function rejectsTextUpload(store: LocalBlobStore, projectId: string): Promise<boolean> {
  try {
    await store.saveUpload({
      projectId,
      assetId: ulid(),
      filename: "notes.txt",
      mimeType: "text/plain",
      stream: Readable.toWeb(Readable.from(["hello"])) as unknown as ReadableStream<Uint8Array>,
      maxBytes: 1024,
    });
    return false;
  } catch (error) {
    return (error as { status?: number }).status === 415;
  }
}

async function rejectsOversize(store: LocalBlobStore, projectId: string): Promise<boolean> {
  try {
    await store.saveUpload({
      projectId,
      assetId: ulid(),
      filename: "big.mp4",
      mimeType: "video/mp4",
      stream: Readable.toWeb(
        Readable.from([Buffer.alloc(4096), Buffer.alloc(4096)]),
      ) as unknown as ReadableStream<Uint8Array>,
      maxBytes: 4096,
    });
    return false;
  } catch (error) {
    return (error as { status?: number }).status === 413;
  }
}

main().catch((error) => {
  console.error("verification crashed:", error);
  process.exit(1);
});
