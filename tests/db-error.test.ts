import assert from "node:assert/strict";
import test from "node:test";
import { describeDatabaseError, isPrivilegeDenial, readDriverError } from "../src/lib/db-error";

/**
 * Shapes below are copied from a real Prisma 7.10.1 + @prisma/adapter-mariadb
 * error captured against MariaDB 11.8.8 (a denied SELECT on a table the account
 * was not granted — read-only, no data touched).
 */
function prismaDriverError(errno: number, dbMessage: string, state = "42000"): Error {
  const error = new Error(
    `\nInvalid \`prisma.$executeRawUnsafe()\` invocation:\n\nRaw query failed. Code: \`${errno}\`. Message: \`${dbMessage}\``,
  );
  error.name = "PrismaClientKnownRequestError";
  Object.assign(error, {
    code: "P2010",
    clientVersion: "7.10.1",
    meta: {
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: {
          originalCode: String(errno),
          originalMessage: dbMessage,
          kind: "mysql",
          code: errno,
          message: dbMessage,
          state,
        },
      },
    },
  });
  return error;
}

const denied = (operation: string, table: string): Error =>
  prismaDriverError(
    1142,
    `${operation} command denied to user 'aivideo_web'@'localhost' for table \`aivideo\`.\`${table}\``,
  );

test("reads the driver facts out of the Prisma adapter error", () => {
  const facts = readDriverError(denied("UPDATE", "projects"));

  assert.equal(facts.errno, 1142);
  assert.equal(facts.sqlState, "42000");
  assert.equal(facts.prismaCode, "P2010");
  assert.match(facts.dbMessage ?? "", /UPDATE command denied/);
});

test("reads a raw driver error that never passed through Prisma", () => {
  const raw = Object.assign(new Error("boom"), {
    errno: 1142,
    sqlState: "42000",
    sqlMessage: "DELETE command denied to user 'aivideo_web'@'localhost' for table `aivideo`.`assets`",
  });

  assert.equal(readDriverError(raw).errno, 1142);
  assert.equal(isPrivilegeDenial(raw, { operation: "DELETE", table: "assets" }), true);
});

test("accepts a genuine UPDATE/DELETE denial", () => {
  assert.equal(isPrivilegeDenial(denied("UPDATE", "projects"), { operation: "UPDATE", table: "projects" }), true);
  assert.equal(isPrivilegeDenial(denied("DELETE", "assets"), { operation: "DELETE", table: "assets" }), true);
});

test("rejects a syntax error even though it shares P2010 and SQLSTATE 42000", () => {
  const syntax = prismaDriverError(
    1064,
    "You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near 'SELEC 1' at line 1",
  );

  assert.equal(readDriverError(syntax).sqlState, "42000", "syntax errors are also 42000");
  assert.equal(readDriverError(syntax).errno, 1064);
  assert.equal(isPrivilegeDenial(syntax, { operation: "UPDATE", table: "projects" }), false);
});

test("rejects missing-table, unknown-database, access-denied and auth errors", () => {
  const cases: Array<[number, string]> = [
    [1146, "Table 'aivideo.nope' doesn't exist"],
    [1141, "Access denied for user 'aivideo_web'@'localhost' to database 'aivideo'"],
    [1049, "Unknown database 'nope'"],
    [1044, "Access denied for user 'aivideo_web'@'localhost' to database 'aivideo'"],
    [1045, "Access denied for user 'aivideo_web'@'localhost' (using password: YES)"],
  ];

  for (const [errno, message] of cases) {
    const error = prismaDriverError(errno, message);
    assert.equal(
      isPrivilegeDenial(error, { operation: "UPDATE", table: "projects" }),
      false,
      `errno ${errno} must not be treated as a denial`,
    );
  }
});

test("rejects a denial of a different operation or a different table", () => {
  // A SELECT denial must not satisfy an UPDATE probe.
  assert.equal(isPrivilegeDenial(denied("SELECT", "projects"), { operation: "UPDATE", table: "projects" }), false);
  // A denial on another table must not satisfy a projects probe.
  assert.equal(isPrivilegeDenial(denied("UPDATE", "assets"), { operation: "UPDATE", table: "projects" }), false);
});

test("rejects anything it cannot positively identify", () => {
  const unknown = [new Error("socket hang up"), "not an error", null, undefined, {}, { code: "P2010" }];
  for (const error of unknown) {
    assert.equal(isPrivilegeDenial(error, { operation: "UPDATE", table: "projects" }), false);
    assert.equal(isPrivilegeDenial(error), false);
  }
});

test("describeDatabaseError prefers the server message and skips Prisma's blank first line", () => {
  const description = describeDatabaseError(denied("UPDATE", "projects"));

  assert.notEqual(description, "unknown database error");
  assert.equal(description.startsWith("UPDATE command denied"), true);
  assert.equal(description.includes("Invalid `prisma"), false);
});

test("describeDatabaseError redacts credentials inside the server message", () => {
  const error = prismaDriverError(1045, "Access denied for user with mysql://aivideo_web:s3cr3t@localhost/aivideo");
  const description = describeDatabaseError(error);

  assert.equal(description.includes("s3cr3t"), false);
  assert.match(description, /mysql:\/\/<redacted>/);
});

test("describeDatabaseError falls back to the first non-empty line, then to the errno", () => {
  assert.equal(describeDatabaseError(new Error("\n\nline one\nline two")), "line one");

  const noMessage = Object.assign(new Error(""), { errno: 1142, sqlState: "42000" });
  assert.match(describeDatabaseError(noMessage), /1142/);
  assert.equal(describeDatabaseError({}), "unknown database error");
});
