# PHASE 1 — DB ACCESS ERROR CLASSIFICATION AUDIT

Date: 2026-11-02
Scope: why the four `deny:*` checks reported PASS while printing `unknown database error`, and how privilege denials are now classified.
**Read-only.** No UPDATE or DELETE was executed against real data, no GRANT/REVOKE, no schema/migration/environment change, no deployment, no commit. Phase 2 not started.

Status vocabulary: PASS / FAIL / BLOCKED / NOT TESTED.

---

## 1. Symptom

`npm run verify:db-access` reported:

```
PASS  deny:update:projects   UPDATE projects denied — unknown database error
PASS  deny:update:assets     UPDATE assets denied — unknown database error
PASS  deny:delete:projects   DELETE projects denied — unknown database error
PASS  deny:delete:assets     DELETE assets denied — unknown database error
```

Two independent defects were hidden behind that single line:

1. **The description was empty** — `describeDatabaseError()` returned its fallback string.
2. **The classification was accidental** — PASS came from a loose regex over Prisma's wrapper text, not from the MariaDB error code.

Neither defect was visible from the summary line, which is exactly why the checks looked healthy but unverifiable.

---

## 2. Root cause

### 2.1 `describeDatabaseError()` read the wrong line

```ts
const raw = error instanceof Error ? error.message : String(error);
const first = raw.split("\n")[0]?.trim();
return redactSecrets(first || "unknown database error");
```

Prisma's error message **starts with a newline**:

```
\nInvalid `prisma.$executeRawUnsafe()` invocation:\n\nRaw query failed. Code: `1142`. Message: `UPDATE command denied …`
```

`split("\n")[0]` is therefore `""`, the `||` fallback fires, and every denial prints `unknown database error`. The information was present in the error object the whole time.

### 2.2 `isPermissionDenied()` never read the errno

```ts
const errno = (error as { errno?: unknown } | null)?.errno;   // always undefined for Prisma errors
if (errno === 1044 || errno === 1142) return true;
return /command denied|access denied/i.test(message);         // the branch that actually ran
```

The Prisma adapter does not expose `errno` on the error it throws, so the first branch never fired. PASS was decided purely by matching `command denied|access denied` anywhere in Prisma's message — which happens to work for 1142, but is not tied to a code, an operation, or a table. Any error whose text contained those words would have been scored as a clean denial.

---

## 3. Actual error shape (evidence)

The adapter's mapping is in `node_modules/@prisma/adapter-mariadb/dist/index.mjs`: `convertDriverError()` receives the driver error and returns `{ originalCode, originalMessage, ...mapDriverError(error) }`; `mapDriverError()` has no `case 1142`, so it falls through to the `default: { kind: "mysql", code, message, state }` branch. Prisma then wraps that as `PrismaClientKnownRequestError` with `code: "P2010"` and the payload under `meta.driverAdapterError.cause`.

Captured from a real denial (JSON, attributes reordered for readability):

```jsonc
{
  "ctor": "PrismaClientKnownRequestError",
  "code": "P2010",                       // generic "raw query failed" — NOT privilege-specific
  "clientVersion": "7.10.1",
  "meta": {
    "driverAdapterError": {
      "name": "DriverAdapterError",
      "cause": {
        "originalCode": "1142",
        "originalMessage": "SELECT command denied to user 'aivideo_web'@'localhost' for table `aivideo`.`_prisma_migrations`",
        "kind": "mysql",
        "code": 1142,
        "message": "SELECT command denied to user 'aivideo_web'@'localhost' for table `aivideo`.`_prisma_migrations`",
        "state": "42000"
      }
    }
  },
  "ownKeys": ["code", "meta", "clientVersion", "name"]
}
```

Two consequences drive the new rules:

| Field | Why it cannot be used alone |
| --- | --- |
| `code: "P2010"` | Shared by **every** raw-query failure, including syntax errors |
| `sqlState: "42000"` | MariaDB reports errno **1064 (syntax)** with SQLSTATE 42000 as well |
| `meta.driverAdapterError.cause.code` | The only reliable signal — 1142/1143 for denied tables/columns |

A syntax error captured the same way, differing **only** in the errno:

```jsonc
{ "code": "P2010",
  "meta": { "driverAdapterError": { "cause": {
    "originalCode": "1064", "code": 1064, "state": "42000",
    "message": "You have an error in your SQL syntax; … near 'SELEC 1' at line 1" } } } }
```

### 3.1 How the evidence was obtained without touching data

The account holds `SELECT, INSERT` on `projects`/`assets` only. Running `SELECT COUNT(*) FROM \`_prisma_migrations\`` — a **read-only** statement on a table it is not granted — returns exactly ER_TABLEACCESS_DENIED (1142), the same errno an UPDATE/DELETE denial produces. Sibling probes produced 1064 (syntax), and the same 1142 for a nonexistent table and an unknown database (MariaDB hides existence behind access-denied).

**No INSERT, UPDATE or DELETE was issued for this audit**, so nothing could be written even transiently. A live 1142 from an actual UPDATE/DELETE statement was deliberately not produced; it is the same `default` branch of `mapDriverError()` with the same errno, and the guarded statement (`WHERE 1 = 0`) remains the only safe way to confirm it once approved.

### 3.2 A trap this exposed

MariaDB answers a denied statement against a **nonexistent** table with 1142 as well (`… for table \`aivideo\`.\`definitely_missing_table\``). A pure errno check would therefore score "table is missing" as "privilege denied" — a false PASS. The verifier now gates on table visibility first (see §5.3).

---

## 4. Changes

| File | Change |
| --- | --- |
| `src/lib/db-error.ts` | **New.** `readDriverError()` extracts `{ errno, sqlState, dbMessage, prismaCode }` from the adapter envelope, a raw driver error, or a nested `cause`. `isPrivilegeDenial()` implements strict, fail-closed classification. `describeDatabaseError()` prefers the server message, skips blank leading lines, collapses newlines and redacts credentials. |
| `src/lib/redact.ts` | Now contains only `redactSecrets()`; error description moved to `db-error.ts` (single responsibility, no circular import). |
| `src/lib/db-access-verify.ts` | Uses strict classification; `expectDenied()` receives `{ operation, table }`, adds a table-visibility gate, and reports `errno=…, sqlstate=…` in FAIL details. INSERT denial now requires an INSERT-specific denial. |
| `scripts/verify-db-access.ts` | Imports `describeDatabaseError` from `db-error`; behaviour otherwise unchanged. |
| `tests/db-error.test.ts` | **New** — 10 tests over real captured shapes. |
| `tests/db-access-verify.test.ts` | Rewritten fakes to throw the genuine Prisma envelope; added unknown-error, syntax-error and missing-table cases. |
| `tests/redact.test.ts` | Drops the moved `describeDatabaseError` assertions. |

Unchanged: schema, migrations, grants, `.env*`, application features, `src/lib/env.ts`, `src/lib/prisma.ts`.

---

## 5. Classification rules

### 5.1 Accepted as a privilege denial → PASS

- Adapter/raw driver errno **1142** (table access) or **1143** (column access), **and**
- the server message contains `"<OPERATION> command denied"` for the operation being probed (UPDATE or DELETE), **and**
- the message names the table being probed.

Fallback when no errno is recoverable (e.g. a hand-built error): SQLSTATE `42000` **and** the same operation/table wording. This is fail-closed — a missing errno alone can never PASS.

### 5.2 Rejected → FAIL (never PASS)

| Case | errno | Old behaviour | New behaviour |
| --- | --- | --- | --- |
| Syntax error | 1064 | FAIL (no "denied" text) | FAIL, detail names `errno=1064` |
| Missing table | 1146 / 1142 when hidden | **PASS** (1142) | FAIL — table-visibility gate |
| Unknown database | 1049 / 1142 when hidden | **PASS** (1142) | FAIL — gate / errno not in allow-list |
| Database access denied | 1044 | **PASS** | FAIL — not a statement-level denial |
| Authentication failed | 1045 | **PASS** ("access denied") | FAIL |
| Denial of the wrong operation | 1142 | **PASS** (regex ignores the verb) | FAIL |
| Denial on the wrong table | 1142 | **PASS** | FAIL |
| Connection lost / socket hang up | — | FAIL | FAIL |
| `P2010` with no driver facts | — | **PASS** (message text) | FAIL |
| Non-error value (`{}`, `null`, string) | — | PASS on `"[object Object]"` text | FAIL |

### 5.3 Missing-table gate

Before the deny probes, the verifier reads `information_schema.tables` for the current database. Only granted tables are listed, so "visible" is exactly the set the account can act on. If a target table is not visible, the probe reports:

```
FAIL  deny:update:projects  table `projects` is not visible to this account (missing, or no grant)
                            — a denial cannot be attributed to UPDATE privileges
```

This converts the MariaDB 1142-on-missing-table ambiguity into an honest FAIL instead of a clean PASS.

---

## 6. Tests and results

`npm run test:unit` → **33 tests, 33 pass, 0 fail**, 369 ms. `npx tsc --noEmit` → exit 0.

New/changed coverage:

| Area | Test | Status |
| --- | --- | --- |
| Parse | driver facts read from the real Prisma envelope (`errno 1142`, `42000`, `P2010`) | PASS |
| Parse | facts read from a raw driver error with no Prisma wrapper | PASS |
| Accept | genuine UPDATE and DELETE denials | PASS |
| Reject | 1064 syntax that shares `P2010` **and** SQLSTATE 42000 | PASS |
| Reject | 1146, 1141, 1049, 1044, 1045 | PASS |
| Reject | 1142 for a different operation or a different table | PASS |
| Reject | plain `Error`, string, `null`, `{}`, `{code:"P2010"}` | PASS |
| Describe | server message wins, no `unknown database error`, no `Invalid \`prisma` wrapper | PASS |
| Describe | credentials redacted inside the server message | PASS |
| Describe | falls back to first non-empty line, then to `MySQL error 1142 (SQLSTATE 42000)`, then `unknown database error` | PASS |
| Verify | four deny checks PASS **with the server's message** (regression for the reported symptom) | PASS |
| Verify | unknown error on a deny probe → FAIL with `not a UPDATE privilege denial (errno=n/a…)` | PASS |
| Verify | syntax error on a deny probe → FAIL with `errno=1064` | PASS |
| Verify | missing table → FAIL `not visible to this account` | PASS |
| Verify | over-privileged account → FAIL `must not be granted` | PASS |
| Verify | INSERT denied → FAIL + `cleanup` SKIP; non-denial during INSERT → rejection | PASS |
| Verify | rollback residue → FAIL; rollback failure → rejection | PASS |

Two real failures were found and fixed while writing these tests: a plain `Error.message` was being mistaken for a server message, and `String({})` was leaking `[object Object]` into the description.

---

## 7. Remaining limitations

1. **The script was not re-run against MariaDB.** Per instruction it stops after the audit and tests; the four checks are proven correct against captured error shapes and fakes, not against a live UPDATE/DELETE denial.
2. **A live 1142 from UPDATE/DELETE was not captured.** It is the same `default` branch with the same errno as the SELECT denial that *was* captured read-only, but the last mile is unproven. A single approved `npm run verify:db-access` closes it.
3. **The table-visibility gate depends on `information_schema` listing granted tables.** If a table exists but the account has no grant on it, the probe reports "not visible" rather than "denied" — deliberately conservative (FAIL, never PASS), but the wording conflates the two cases.
4. **Errno allow-list is MariaDB-specific** (1142/1143). A different backend would need its own mapping; the code fails closed rather than guessing.
5. **Message wording is part of the contract.** If a future MariaDB version rewords `"… command denied to user …"`, genuine denials become FAIL. That is the safe direction, and it is covered by tests that would need updating alongside.
6. **`scripts/verify-db-access.ts` remains outside `tsc`** (the repo excludes `scripts/`), so only its imported modules are typechecked.

---

## 8. GO / NO-GO

| Item | Decision |
| --- | --- |
| Error classification (`db-error.ts`) | **GO** — 10 tests, fail-closed, driven by errno rather than text |
| Verifier changes (`db-access-verify.ts`) | **GO for review** — deny PASS now requires operation + table + errno; missing table can no longer PASS |
| Description fix (`describeDatabaseError`) | **GO** — server message shown, credentials redacted |
| Running `npm run verify:db-access` | **NO-GO in this task.** When it is approved, expect `deny:*` PASS lines to read e.g. `UPDATE command denied to user 'aivideo_web'@'localhost' for table \`aivideo\`.\`projects\`` |
| Phase 1 functional sign-off | Still gated on the earlier grant/runtime work; **not** affected by this audit |
| Phase 2 | **Not started.** |
