# PHASE 1 — DATABASE ACCESS VERIFICATION FIX

Date: 2026-11-02
Scope: environment loading for non-Next entry points, rewrite of `scripts/verify-db-access.ts`, unit tests.
**No migration, no DDL, no DML, no GRANT/REVOKE, no schema change, no deployment, no commit. Phase 2 not started.**

Status vocabulary: PASS / FAIL / BLOCKED / NOT TESTED.

---

## 1. Root cause

Three independent defects, all of which had to be fixed for the probe to be meaningful:

1. **No environment loading outside Next.js.** `scripts/verify-db-access.ts` runs through `tsx`, which does not read `.env*` files, and `prisma.config.ts` is only evaluated by the Prisma CLI — never by a standalone script. `src/lib/env.ts` reads `process.env.WEB_DATABASE_URL` directly and correctly, so `readWebDatabaseConfig()` threw `ConfigurationError` on every run even though `WEB_DATABASE_URL` is present in `.env.local`. The script therefore always printed `BLOCKED` and exited 2.
2. **The probe targeted a Phase 2 table.** It tried `INSERT INTO jobs (...)`, a table that belongs to Phase 2 and does not exist. Even with credentials, "rejected" was being inferred from *"table doesn't exist"* rather than from a privilege check — a test that passes for the wrong reason.
3. **Cleanup required DELETE.** It created a real `projects` row and deleted it afterwards (`prisma.project.delete`), and swallowed cleanup failures with `.catch(() => undefined)`. The web account is not supposed to have `DELETE`, so the probe both demanded a privilege that must not exist and could silently leave a row behind.

A fourth, structural point: there were two env-loading implementations already diverging (`prisma.config.ts` with `override: true` on `.env.local`, and nothing elsewhere). Adding a third in the script would have guaranteed drift, so Task A consolidated them.

---

## 2. Files changed

| File | Change |
| --- | --- |
| `src/lib/env-loader.ts` | **New.** The single env-loading implementation: root resolved from the module, `.env` → `.env.local`, shell wins, missing files silent. |
| `src/lib/redact.ts` | **New.** `redactSecrets()` / `describeDatabaseError()` — strips DSNs and `password=…` from anything printed. |
| `src/lib/db-access-verify.ts` | **New.** Database-agnostic verification core (identity, isolation, SELECT, rolled-back INSERT, denied UPDATE/DELETE). Depends only on a small `ProbeClient` interface, so it is unit-testable. |
| `scripts/verify-db-access.ts` | **Rewritten.** Loads env through the shared loader, adapts Prisma Client to `ProbeClient`, probes only `projects`/`assets`, never requires DELETE, never swallows a rollback failure, redacts all output. |
| `prisma.config.ts` | Now calls `loadEnvironment()` instead of its own dotenv setup. See §3.2 for the one behaviour change. |
| `tests/env-loader.test.ts` | **New.** 5 tests: `.env.local` wins, `.env` fallback, shell precedence, missing URL, root resolution. |
| `tests/redact.test.ts` | **New.** 4 tests: DSN redaction, encoded passwords, key/value forms, message truncation. |
| `tests/db-access-verify.test.ts` | **New.** 9 tests against an in-memory fake — no database is contacted. |
| `package.json` | Added `"test:unit": "node --import tsx --test tests/*.test.ts"`. No new dependency (tsx was already there). |
| `tsconfig.json` | Added `tests/**/*.ts` to `include` so the tests are typechecked. |

Untouched: `src/lib/env.ts`, `src/lib/prisma.ts`, `src/lib/storage.ts`, all application features, `prisma/schema.prisma`, `prisma/migrations/`, `media-service/`, and every database object.

---

## 3. Environment-loading strategy

### 3.1 One loader, one precedence

```
shell / CI / container   ← always wins, never overridden
.env.local               ← overrides .env
.env
```

- Files are read with `dotenv.parse()` and merged into a target map, so precedence is explicit and the loader is testable without mutating the real `process.env`.
- The ambient environment is snapshotted **before** the first file, which is what makes "shell wins, but `.env.local` still beats `.env`" correct: a key that was already set is skipped for every file, while a key set only by `.env` is still overridable by `.env.local`.
- `root` defaults to `PROJECT_ROOT`, derived from `import.meta.url` (`src/lib/` → up two levels). Running `node scripts/…` or `npx prisma …` from any directory finds the same files; `process.cwd()` is never consulted.
- Missing files are recorded (`missing: [".env.local"]`) but never fatal — `prisma generate` must keep working in CI with no credentials at all.
- Next.js is deliberately left alone: it performs its own `.env` loading with the same precedence, and `src/lib/env.ts` keeps reading `process.env`, so runtime behaviour is unchanged.

### 3.2 Behaviour change in `prisma.config.ts` (intentional)

Previously `.env.local` was loaded with `override: true`, i.e. a stale local file **beat** an exported `DATABASE_URL`. That was flagged as risk R1 in `docs/PHASE-1-PRE-MIGRATION-AUDIT.md`: `db:migrate:deploy` on any host with a leftover `.env.local` would silently target the wrong database.

The shared loader makes the shell authoritative, matching Next.js and eliminating R1. Consequence to know about: with `DATABASE_URL` exported in a shell, an edit to `.env.local` no longer affects Prisma CLI runs in that shell. This is the safe direction, and it is verified by the `npx prisma validate` run below.

### 3.3 Credential handling

`redactSecrets()` replaces any `scheme://…` with `scheme://<redacted>` and any `password=…`/`pwd:` with `<redacted>`. Every line the script prints — including check details and the `FATAL`/`BLOCKED` paths — passes through it. The script never prints the DSN, the password, or the environment file contents; it prints only which files were loaded.

---

## 4. Verification strategy

| # | Check id | Method | Proves |
| --- | --- | --- | --- |
| 1 | `identity` | `SELECT DATABASE(), CURRENT_USER(), VERSION()` | talking to `aivideo` as `aivideo_web@…`, not another database or account |
| 2 | `isolation` | `SELECT schema_name FROM information_schema.schemata` | only `aivideo` + `information_schema` are visible; any extra schema fails the run |
| 3 | `select:projects`, `select:assets` | `SELECT COUNT(*)` | read access to both Phase 1 tables |
| 4 | `insert:projects+assets` | two real `INSERT`s inside a transaction that is **always rolled back** | `INSERT` granted on both tables, including the FK path |
| 5 | `cleanup` | row counts before vs. after the probe | the rollback actually removed the rows — no test data left behind |
| 6 | `deny:update:*`, `deny:delete:*` | `UPDATE … SET x = x WHERE 1 = 0`, `DELETE FROM … WHERE 1 = 0` | `UPDATE`/`DELETE` are denied, **without any possibility of modifying data** |

Design notes:

- **No DELETE needed.** The probe never deletes; rollback does the cleanup, so the account only needs `SELECT` + `INSERT`, exactly as specified.
- **`WHERE 1 = 0` is safe in both outcomes.** MySQL/MariaDB checks table privileges during statement preparation, before evaluating `WHERE`. A denied user gets error 1142 (→ PASS); a wrongly-granted user gets "0 rows affected" (→ FAIL, and nothing was touched either way).
- **Permission denial vs. real failure are handled differently.** A denial (errno 1044/1142 or "command denied") is an expected config result → `FAIL` check with a precise message. Anything else — connection loss, a rollback that did not complete — is rethrown and aborts the run with `FATAL`, because after a failed transaction the row counts cannot be trusted and claiming "nothing was written" would be a lie. The residue check is `SKIP`ped (not `PASS`ed) when INSERT is denied.
- **No silent swallowing.** The only swallowed error is the explicit `RollbackSignal` sentinel that forces the rollback; everything else propagates. `finally { await prisma.$disconnect(); }` always runs.
- Exit codes: `0` all PASS, `1` any FAIL, `2` configuration missing (no `WEB_DATABASE_URL`).

---

## 5. Tests and results

Run with `npm run test:unit` (`node --import tsx --test tests/*.test.ts`). No database is contacted: `db-access-verify` tests use an in-memory `ProbeClient`, env tests use temp directories under the OS temp dir.

```
ℹ tests 18   ℹ pass 18   ℹ fail 0   ℹ duration_ms 319
```

| Area | Test | Status |
| --- | --- | --- |
| Env | `.env.local` loads and overrides `.env` (and `.env`-only keys survive) | PASS |
| Env | `.env` fallback when `.env.local` is absent (`missing` reported) | PASS |
| Env | shell value wins over both files | PASS |
| Env | missing `WEB_DATABASE_URL` → `undefined`, no throw | PASS |
| Env | default root is the repo root, not the cwd | PASS |
| Redaction | DSN removed, scheme kept | PASS |
| Redaction | percent-encoded password inside DSN removed | PASS |
| Redaction | `password=…` / `pwd: …` removed | PASS |
| Redaction | ordinary errors intact, only first line reported | PASS |
| Verify | clean run passes with UPDATE/DELETE denied (no DELETE privilege required) | PASS |
| Verify | probes `projects` + `assets` only; the `jobs` probe is gone | PASS |
| Verify | exactly 4 destructive statements, every one ends in `WHERE 1 = 0` | PASS |
| Verify | over-privileged account (UPDATE/DELETE allowed) → 4 FAILs | PASS |
| Verify | wrong database identity → FAIL | PASS |
| Verify | extra visible schema → FAIL | PASS |
| Verify | rollback not applied → `cleanup` FAIL with counts | PASS |
| Verify | denied INSERT → insert FAIL + cleanup SKIP | PASS |
| Verify | rollback failure rejects (not swallowed) | PASS |

Other checks in the same run:

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 (tests are now typechecked too) |
| `npx prisma validate` | exit 0 — `Loaded Prisma config from prisma.config.ts`, schema valid (proves the shared loader works inside the Prisma CLI) |

Per instruction, **`npm run verify:db-access` was not executed against the database**.

---

## 6. Remaining limitations

1. **The script is unproven end-to-end.** It has never run against MariaDB. Unit tests cover the logic; the Prisma adapters (`$queryRawUnsafe`, `$executeRawUnsafe`, interactive `$transaction` rollback with `@prisma/adapter-mariadb`) are exercised only in theory until the review approves one live run.
2. **The account currently has no privileges at all, so the run will abort.** Verified read-only at the end of this task: `SHOW GRANTS FOR CURRENT_USER()` for `aivideo_web` returns a single `GRANT USAGE ON *.*` line — the database-wide `SELECT` is gone and no table-scoped grant replaced it. Connecting with `database=aivideo` fails with **errno 1044**, so the first real run would not even reach the `SELECT` checks; it would end in `FATAL Access denied for user 'aivideo_web'@'localhost' to database 'aivideo'` with exit 1. That is the script reporting the truth, not a script defect. It needs:
   ```sql
   GRANT SELECT, INSERT ON aivideo.projects TO 'aivideo_web'@'localhost';
   GRANT SELECT, INSERT ON aivideo.assets   TO 'aivideo_web'@'localhost';
   ```
   Once those exist, a clean run is 7 checks: `identity`, `isolation`, two `select:*`, `insert:*`, and `cleanup`, plus four `deny:*`.
3. **`WHERE 1 = 0` relies on MySQL/MariaDB privilege-check semantics** (privilege is checked before rows are located). Even if a future server changed that ordering, the statements still match zero rows, so the probe stays non-destructive — it would only degrade from "detects over-privilege" to "reports 0 rows affected".
4. **`information_schema.schemata` only lists schemas the account can touch.** An account with a grant on another database would show it and fail the run; an account whose grants are dropped entirely would show fewer schemas, which the isolation check tolerates by design (absence is not a failure).
5. **The rolled-back INSERT writes real rows briefly** — inside an uncommitted transaction, with ULID ids prefixed by the marker name `__db_access_probe__`. Another session cannot see them; an `AUTO_INCREMENT` counter (not used here) would advance.
6. **Env-loader change alters Prisma CLI precedence** (§3.2). Intentional, but it should be reflected in any deployment runbook that relied on `.env.local` beating the shell.
7. **Each test run writes fixtures to the OS temp dir** and removes them; a killed process could leave an `aivideo-env-*` directory there.

### Environment note (observed, not caused by this task)

`prisma/migrations/` is no longer empty: `20261102065701_init/migration.sql` and `migration_lock.toml` appeared at **13:57 today**, and a read-only `information_schema` check shows they were applied — `aivideo` now contains `projects`, `assets`, `_prisma_migrations`, and `aivideo_shadow` contains `projects`/`assets`. This task created none of it (no migration command was run here). Consequences: the "no migration yet" premise in `docs/PHASE-1-PRE-MIGRATION-AUDIT.md` is now stale, and the verification script will find the tables it expects.

A **second** external change was observed while closing this task: `aivideo_web` now holds only global `USAGE` — the database-wide `SELECT` was revoked without a table-scoped replacement (`SHOW GRANTS` returns one `USAGE` line; connecting with `database=aivideo` returns errno 1044). Read-only checks as the migrator confirm **0 rows** in `projects`, **0 rows** in `assets`, and **0 rows** named `__db_access_probe__`: neither this task nor the earlier probe left any record behind.

---

## 7. GO / NO-GO

| Item | Decision |
| --- | --- |
| Shared env loader landing (`src/lib/env-loader.ts`, `prisma.config.ts`) | **GO** — one implementation, shell precedence, typechecked, `prisma validate` passes |
| Redaction helpers | **GO** — covered by 4 tests, used on every printed path |
| Rewritten verification script (code) | **GO for review** — 9 logic tests pass, no DELETE requirement, no `jobs`, non-destructive probes, failures surface |
| Running `npm run verify:db-access` against MariaDB | **NO-GO until (a) the review approves and (b) `aivideo_web` holds `SELECT, INSERT` on `projects`/`assets`.** With zero privileges the run aborts at the identity query with `FATAL 1044` |
| Phase 1 functional sign-off | **NO-GO** — `aivideo_web` currently has **no** privilege on `aivideo` (only global `USAGE`), so even reads fail; create-project and upload cannot work |
| Phase 2 | **Not started.** |

Recommended order once approved: grant `SELECT, INSERT` on `projects`/`assets` → run `npm run verify:db-access` once and confirm `7/7` checks PASS with `cleanup` PASS → exercise create-project and upload over HTTP → re-run to confirm no residue (row counts stable).
