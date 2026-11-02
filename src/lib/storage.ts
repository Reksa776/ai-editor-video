import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { isUlid } from "./id";
import { storageRoot } from "./env";

export type StoredBlob = {
  /** Path relative to the storage root, e.g. `01J.../source/01J....mp4`. */
  relPath: string;
  filename: string;
  mimeType: string;
  sha256: string;
  bytes: number;
};

export type SaveUploadInput = {
  projectId: string;
  assetId: string;
  filename: string;
  mimeType: string;
  /** Web ReadableStream straight from the request body — never buffered. */
  stream: ReadableStream<Uint8Array>;
  maxBytes: number;
};

export interface BlobStore {
  saveUpload(input: SaveUploadInput): Promise<StoredBlob>;
  absolutePath(relPath: string): string;
  stat(relPath: string): Promise<{ bytes: number }>;
  remove(relPath: string): Promise<void>;
}

const VIDEO_EXTENSIONS = new Map<string, string>([
  ["video/mp4", ".mp4"],
  ["video/quicktime", ".mov"],
  ["video/x-matroska", ".mkv"],
  ["video/webm", ".webm"],
]);

export class StorageError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

function normalizeExtension(filename: string, mimeType: string): string {
  const fromMime = VIDEO_EXTENSIONS.get(mimeType);
  if (fromMime) return fromMime;

  const fromName = path.extname(filename).toLowerCase();
  const allowed = new Set(VIDEO_EXTENSIONS.values());
  if (allowed.has(fromName)) return fromName;

  throw new StorageError(
    `Unsupported video type "${mimeType || fromName || "unknown"}". Allowed: mp4, mov, mkv, webm.`,
    415,
  );
}

function safeFilename(filename: string): string {
  const base = path.basename(filename).replace(/[^\w.\- ]+/g, "_").trim();
  if (!base) return "upload";
  return base.slice(0, 200);
}

/**
 * Filesystem-backed blob store.
 *
 * Layout: <root>/<projectId>/<kind>/<assetId><ext>
 * - Keys are generated server-side; user filenames never become paths.
 * - Uploads stream chunk-by-chunk, so a 2 GB file costs constant memory.
 * - Originals are never modified or auto-deleted.
 */
export class LocalBlobStore implements BlobStore {
  private readonly root: string;

  constructor(root: string = storageRoot()) {
    this.root = path.resolve(root);
  }

  get rootPath(): string {
    return this.root;
  }

  absolutePath(relPath: string): string {
    const resolved = path.resolve(this.root, relPath);
    const withSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (resolved !== this.root && !resolved.startsWith(withSep)) {
      throw new StorageError("Resolved path escapes the storage root", 400);
    }
    return resolved;
  }

  async saveUpload(input: SaveUploadInput): Promise<StoredBlob> {
    if (!isUlid(input.projectId)) {
      throw new StorageError("Invalid project id", 400);
    }
    if (!isUlid(input.assetId)) {
      throw new StorageError("Invalid asset id", 400);
    }

    const extension = normalizeExtension(input.filename, input.mimeType);
    const filename = safeFilename(input.filename);
    const relPath = path.posix.join(input.projectId, "source", `${input.assetId}${extension}`);
    const target = this.absolutePath(relPath);
    const partial = `${target}.part`;

    await mkdir(path.dirname(target), { recursive: true });

    const hash = createHash("sha256");
    let bytes = 0;
    const handle = await open(partial, "wx");

    try {
      // Node's web ReadableStream is async-iterable (the DOM lib type does not
      // declare Symbol.asyncIterator, hence the cast). Chunk-by-chunk, so a
      // multi-gigabyte upload still costs constant memory.
      const chunks = input.stream as unknown as AsyncIterable<Uint8Array>;
      for await (const chunk of chunks) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > input.maxBytes) {
          throw new StorageError(
            `File exceeds the ${Math.round(input.maxBytes / (1024 * 1024))} MB limit`,
            413,
          );
        }
        hash.update(buffer);
        await handle.write(buffer);
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(partial).catch(() => undefined);
      throw error;
    }

    await handle.close();

    if (bytes === 0) {
      await unlink(partial).catch(() => undefined);
      throw new StorageError("Uploaded file is empty", 400);
    }

    await rename(partial, target);

    return {
      relPath,
      filename,
      mimeType: input.mimeType || "application/octet-stream",
      sha256: hash.digest("hex"),
      bytes,
    };
  }

  async stat(relPath: string): Promise<{ bytes: number }> {
    const info = await stat(this.absolutePath(relPath));
    return { bytes: info.size };
  }

  async remove(relPath: string): Promise<void> {
    await rm(this.absolutePath(relPath), { force: true });
  }

  /** Test helper: hash a file on disk the same way an upload is hashed. */
  async hashFile(absolutePath: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(absolutePath)) {
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  }
}
