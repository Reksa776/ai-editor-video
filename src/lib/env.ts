export type DatabaseConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

/**
 * Raised when a required environment variable is missing or malformed.
 * Callers catch this and surface a clear "database not configured" state
 * instead of crashing the UI.
 */
export class ConfigurationError extends Error {
  constructor(
    message: string,
    readonly missing: string[] = [],
  ) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function parseMysqlUrl(raw: string, variable: string): DatabaseConfig {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError(`${variable} is not a valid URL`, [variable]);
  }

  const database = url.pathname.replace(/^\//, "");
  if (!url.hostname || !url.username || !database) {
    throw new ConfigurationError(
      `${variable} must look like mysql://user:pass@host:3306/database`,
      [variable],
    );
  }

  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

/** Next.js runtime credentials: DML only (projects + assets). */
export function readWebDatabaseConfig(): DatabaseConfig {
  const raw = process.env.WEB_DATABASE_URL;
  if (!raw) {
    throw new ConfigurationError(
      "WEB_DATABASE_URL is not set — copy .env.example to .env.local and add the aivideo_web credentials",
      ["WEB_DATABASE_URL"],
    );
  }
  return parseMysqlUrl(raw, "WEB_DATABASE_URL");
}

/** True when the runtime has enough configuration to attempt a connection. */
export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.WEB_DATABASE_URL);
}

/**
 * Root for all runtime media. Resolved to an absolute path so the storage
 * layer can verify containment. Never points at /tmp (RAM-backed on Fedora).
 */
export function storageRoot(): string {
  return process.env.PROJECT_STORAGE_PATH ?? "./data/projects";
}

export function maxUploadBytes(): number {
  const raw = process.env.MAX_UPLOAD_BYTES;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2 * 1024 * 1024 * 1024;
}
