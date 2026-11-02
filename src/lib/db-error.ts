import { redactSecrets } from "./redact";

/**
 * Error classification for database failures.
 *
 * The Prisma 7 MariaDB adapter does NOT put the driver facts on the error it
 * throws. A denied statement arrives as:
 *
 *   PrismaClientKnownRequestError {
 *     code: "P2010",                       // generic "raw query failed"
 *     message: "\nInvalid `prisma.$executeRawUnsafe()` invocation:\n\nRaw query failed. Code: `1142`. Message: `…`",
 *     meta: { driverAdapterError: { cause: {
 *       originalCode: "1142", code: 1142, state: "42000",
 *       message: "UPDATE command denied to user 'aivideo_web'@'localhost' for table `aivideo`.`projects`"
 *     } } }
 *   }
 *
 * Two traps follow from that:
 *   1. `code` is `P2010` for *every* raw-query failure, syntax errors included,
 *      so it can never be used to mean "denied".
 *   2. `SQLSTATE 42000` is likewise shared — MariaDB reports 1064 (syntax) as
 *      42000 too. Only the errno distinguishes 1142/1143 from 1064/1146.
 *
 * This module reads the errno from wherever the adapter actually put it and
 * treats anything it cannot positively identify as a privilege denial as a
 * non-denial (the caller then reports FAIL/FATAL). Classification fails closed.
 */

export type DriverErrorFacts = {
  /** MariaDB errno, e.g. 1142 (table access denied), 1064 (syntax). */
  errno?: number;
  /** SQLSTATE, e.g. "42000". */
  sqlState?: string;
  /** The server's own message. */
  dbMessage?: string;
  /** Prisma's own code, e.g. "P2010" — never used for denial decisions. */
  prismaCode?: string;
};

/** ER_TABLEACCESS_DENIED_ERROR, ER_COLUMNACCESS_DENIED_ERROR. */
const TABLE_ACCESS_DENIED_ERRNOS = new Set([1142, 1143]);

/** The SQLSTATE class MariaDB uses for privilege errors — and for syntax errors. */
const PRIVILEGE_SQLSTATE = "42000";

/** SQLSTATE never grants a PASS on its own; only the errno does. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Extracts `{ errno, sqlState, dbMessage }` from a Prisma error, a raw driver
 * error, or anything nested under `cause` / `meta.driverAdapterError.cause`.
 */
export function readDriverError(error: unknown, depth = 0): DriverErrorFacts {
  const record = asRecord(error);
  if (!record || depth > 4) return {};

  const facts: DriverErrorFacts = {
    prismaCode: asString(record.code)?.startsWith("P") ? asString(record.code) : undefined,
  };

  // The adapter wraps the driver error here.
  const meta = asRecord(record.meta);
  const adapter = meta ? asRecord(meta.driverAdapterError) : null;
  const driver = (adapter ? asRecord(adapter.cause) : null) ?? record;

  const driverErrno = asNumber(driver.errno) ?? asNumber(driver.code) ?? asNumber(driver.originalCode);
  const driverState = asString(driver.sqlState) ?? asString(driver.state);
  const looksLikeDriverError = Boolean(adapter) || driverErrno !== undefined || driverState !== undefined;

  facts.errno = driverErrno;
  facts.sqlState = driverState;
  // `message` on a plain Error is not a database message — only trust it when
  // this really is, or wraps, a driver error.
  facts.dbMessage =
    asString(driver.sqlMessage) ??
    asString(driver.originalMessage) ??
    (looksLikeDriverError ? asString(driver.message) : undefined);

  if ((facts.errno === undefined || facts.dbMessage === undefined) && record.cause) {
    const nested = readDriverError(record.cause, depth + 1);
    facts.errno ??= nested.errno;
    facts.sqlState ??= nested.sqlState;
    facts.dbMessage ??= nested.dbMessage;
    facts.prismaCode ??= nested.prismaCode;
  }

  return facts;
}

export type DenialQuery = {
  /** Statement verb that must appear in the server's denial, e.g. "UPDATE". */
  operation?: string;
  /** Table the statement targets; the server's denial must name it. */
  table?: string;
};

/**
 * True only for a genuine MariaDB privilege denial of `operation` on `table`.
 *
 * Accepted shapes:
 *   - Prisma adapter error: `meta.driverAdapterError.cause.code === 1142/1143`
 *   - raw driver error: `errno === 1142/1143` (+ `sqlState`)
 *   - a `"<OPERATION> command denied to user … for table `<db>`.`<table>`"` message
 *
 * Rejected on purpose: 1064 syntax, 1146/1141 missing table, 1049 unknown
 * database, 1044 database access denied, 1045 authentication failure, and any
 * message that does not name the expected operation and table. A rejection is
 * reported as FAIL, never PASS.
 */
export function isPrivilegeDenial(error: unknown, query: DenialQuery = {}): boolean {
  const { errno, sqlState, dbMessage } = readDriverError(error);
  const message = dbMessage ?? "";

  if (errno !== undefined) {
    if (!TABLE_ACCESS_DENIED_ERRNOS.has(errno)) return false;
  } else if (sqlState !== PRIVILEGE_SQLSTATE) {
    // No errno: only trust an explicit SQLSTATE-42000 denial message.
    return false;
  }

  const denial = query.operation
    ? new RegExp(`\\b${query.operation}\\b\\s+command denied`, "i")
    : /command denied/i;
  if (!denial.test(message)) return false;

  if (query.table && !new RegExp(`\\b${query.table}\\b`, "i").test(message)) return false;

  return true;
}

/**
 * Short, redacted, human-readable description of a database error.
 *
 * Prefers the server's own message (the useful part) over Prisma's wrapper
 * text, and skips blank leading lines — Prisma messages begin with `\n`, which
 * is exactly why the previous implementation printed "unknown database error".
 */
export function describeDatabaseError(error: unknown): string {
  const { errno, sqlState, dbMessage } = readDriverError(error);
  if (dbMessage) return redactSecrets(dbMessage.replace(/\s*\n\s*/g, " "));

  // Never stringify an arbitrary object: `String({})` is "[object Object]",
  // which would masquerade as a real message.
  const raw =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const firstLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (firstLine) return redactSecrets(firstLine);
  if (errno !== undefined) {
    return redactSecrets(`MySQL error ${errno}${sqlState ? ` (SQLSTATE ${sqlState})` : ""}`);
  }
  return "unknown database error";
}
