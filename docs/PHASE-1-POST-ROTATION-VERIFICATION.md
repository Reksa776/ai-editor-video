# PHASE 1 — POST-PASSWORD-ROTATION VERIFICATION

Date: 2026-11-02
Project: AI Video Editor — `~/ai-video-editor`
Branch: `main` · HEAD: `65ef0e4` · HEAD == `origin/main`
Mode: **audit/documentation only** — no code, schema, grant, migration, environment file, commit, or push was performed.

Status vocabulary: PASS / FAIL / **NOT VERIFIED**. Only executed checks are reported as PASS.

---

## 1. Summary

| Area | Result |
| --- | --- |
| Git integrity | **PASS** — HEAD `65ef0e4`, identical on `origin/main`, working tree clean |
| Web database access (`aivideo_web`) | **PASS** — 10/10 verifier checks |
| Media database access (`aivideo_media`) | **PASS** — `SELECT 1 = 1` via the app's own engine |
| Regression | **PASS** — tsc, 33 unit tests, 8 pytest, Prisma validate |
| Security posture | **PASS** — least privilege, cross-database denied, no tracked credentials |
| Password rotation provenance | **NOT VERIFIED** — see §7 |
| Production readiness | **NOT CERTIFIED** until §7 is resolved |

**Phase 1: ACCEPTED AND CLOSED WITH SECURITY FOLLOW-UP.**
**Phase 2: LOCKED.**
**GitHub synchronization: VERIFIED.**

---

## 2. Git integrity — PASS

| Check | Command | Result |
| --- | --- | --- |
| HEAD commit | `git log -1 --oneline` | `65ef0e4 Complete Phase 1: init migration, DB access verifier, audit trail` |
| Branch state | `git status -sb` | `## main...origin/main` — no ahead/behind marker |
| Unstaged changes | `git diff` | EMPTY |
| Staged changes | `git diff --cached` | EMPTY |
| Commit content | `git show --stat HEAD` | 23 files changed, 2,454 insertions(+), 59 deletions(-) |
| Tracked env files | `git ls-files` | only `.env.example` and `media-service/.env.example` |
| `.env.local`, `media-service/.env` | `git ls-files --error-unmatch` | untracked / ignored |
| Remote hash | `git rev-parse HEAD origin/main` | both `65ef0e4`; `0` behind, `0` ahead |

No local change is unexplained. The Phase 1 commit is present identically on the remote.

> Observation: the commit was already on `origin/main` at audit time. This session performed no push; synchronization is therefore reported as **VERIFIED**, not as an action taken here.

---

## 3. Web database access — `aivideo_web@localhost` — PASS (10/10)

Executed with `npm run verify:db-access` (Prisma Client + `@prisma/adapter-mariadb`, environment loaded by `src/lib/env-loader.ts`):

```
PASS  identity                 aivideo_web@localhost -> aivideo, server 11.8.8-MariaDB
PASS  isolation                visible: information_schema, aivideo
PASS  select:projects          0 row(s) readable
PASS  select:assets            0 row(s) readable
PASS  insert:projects+assets   both inserts inside a rolled-back transaction
PASS  cleanup                  row counts unchanged (projects=0, assets=0)
PASS  deny:update:projects     UPDATE command denied to user 'aivideo_web'@'localhost' for table `aivideo`.`projects`
PASS  deny:update:assets       UPDATE command denied … `aivideo`.`assets`
PASS  deny:delete:projects     DELETE command denied … `aivideo`.`projects`
PASS  deny:delete:assets       DELETE command denied … `aivideo`.`assets`

10/10 checks passed — exit 0
```

Facts proven:

- Identity is exactly `aivideo_web@localhost`, connected to database `aivideo`.
- Isolation holds: only `aivideo` and `information_schema` are visible.
- `SELECT` works on both Phase 1 tables.
- `INSERT` works and is executed inside a transaction that is **always rolled back**; the row counts before/after are identical, so no probe data persists.
- `UPDATE` and `DELETE` are denied with genuine MariaDB errno 1142 (the server's message is now surfaced instead of a generic string).

---

## 4. Media database access — `aivideo_media@localhost` — PASS

Executed through the application's own configuration, not a raw driver: `media-service/app/config.py` (`settings`, which loads `media-service/.env` resolved relative to the module) plus `media-service/app/database/session.py` (`get_engine()`, pool unchanged: `pool_size=3`, `max_overflow=2`, `pool_recycle=1800`, `pre_ping=True`).

```
MEDIA_DATABASE_URL: SET
database_configured: True
SELECT 1     -> 1
DATABASE()   -> aivideo
CURRENT_USER -> aivideo_media@localhost
VERSION()    -> 11.8.8-MariaDB
```

Read-only: only `SELECT 1` and session metadata were issued. No write, no DDL, no pool change. No password or DSN was printed.

The media test suite (`pytest`, 8 passed) additionally exercises real `information_schema` parity queries, which is independent evidence that the configured media credentials work.

---

## 5. Regression — PASS

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0, no diagnostics |
| `npm run test:unit` | **33 tests, 33 passed, 0 failed** |
| `media-service/.venv/bin/pytest -q` | **8 passed**, 1 warning (upstream `httpx`/`starlette.testclient` deprecation) |
| `npx prisma validate` | "schema at prisma/schema.prisma is valid", exit 0 |

Note on naming: the 33 unit tests run on Node's built-in test runner via `tsx` (`node --import tsx --test tests/*.test.ts`); the project does not use Jest. Same count, different runner.

---

## 6. Security — PASS

### 6.1 Effective grants

```
aivideo_web@localhost
  GRANT USAGE ON *.*
  GRANT SELECT, INSERT ON `aivideo`.`assets`
  GRANT SELECT, INSERT ON `aivideo`.`projects`

aivideo_media@localhost
  GRANT USAGE ON *.*
  GRANT SELECT ON `aivideo`.*
```

- No global privilege beyond `USAGE` for either account.
- No `UPDATE`, no `DELETE`, no `CREATE`, no `GRANT OPTION`.
- `information_schema.USER_PRIVILEGES` for `aivideo_*` contains a single row: `('aivideo_web'@'localhost', 'USAGE')` — no grantable global rights.
- Visible databases: `aivideo`, `information_schema` only, for both accounts.

### 6.2 Cross-database access probes

Read-only probes (`SELECT … LIMIT 0`, which cannot return or modify rows):

| Account | `mysql.user` | `ecommerce_iot.products` |
| --- | --- | --- |
| `aivideo_web` | denied (1142) | denied (1142) |
| `aivideo_media` | denied (1142) | denied (1142) |

A denied statement changes nothing, so these probes had no side effects.

### 6.3 Credentials in the repository

- `.env.local` and `media-service/.env` are untracked and gitignored.
- Working-tree diff and staged diff were both empty, so no credential could appear in a diff.
- No password, DSN, or credential value is reproduced anywhere in this report.

---

## 7. Password rotation provenance — **NOT VERIFIED**

What the audit establishes:

- The credentials **currently held in `.env.local` and `media-service/.env`** authenticate successfully as `aivideo_web` and `aivideo_media` against `aivideo` on MariaDB 11.8.8. Connectivity with the configured credentials is therefore proven **as of this audit**.
- The user states that both passwords were rotated.

What the audit does **not** establish, and why:

1. **That the configured secrets are the newly rotated ones.** The previous passwords are not retained anywhere accessible, so a still-valid earlier password cannot be distinguished from a rotated one by any query.
2. **When the rotation happened.** MariaDB offers no readable password-change timestamp for these accounts — the attempt to read `mysql.user` (including a `password_last_changed` column) returned **errno 1142** because no project account has SELECT on `mysql.*`. Rotation time is therefore unknown from the database side.
3. **Indirect timing signal only.** File mtimes: `.env.local` = `13:34:41`, `media-service/.env` = `13:43:54`; the Phase 1 commit `65ef0e4` was created at `15:02:14`. If the rotation occurred after 15:02, the environment files were not rewritten and may still contain the previous secret. This is an observation, not a conclusion.

Explicitly **not** claimed:

- Rotation is **not** declared successful (no historical proof that the old secrets were invalidated).
- Rotation is **not** declared failed (every current credential authenticates correctly and grants are correct).

**Consequence:** production readiness is **NOT CERTIFIED** until provenance is closed by a positive test that only the new secret works (e.g. confirming the old secret is rejected) or by an operator-attested rotation record with a timestamp after the environment files were updated.

---

## 8. Final decision

| Item | Status |
| --- | --- |
| Phase 1 | **ACCEPTED AND CLOSED WITH SECURITY FOLLOW-UP** |
| Phase 2 | **LOCKED** |
| Production readiness | **NOT CERTIFIED** until password rotation provenance is resolved |
| GitHub synchronization | **VERIFIED** (`HEAD == origin/main == 65ef0e4`) |

### Follow-up required (one item)

1. Prove the rotation: confirm the prior `aivideo_web` / `aivideo_media` secrets are rejected, or record the rotation timestamp together with the environment-file update timestamp, ensuring the files were written **after** the rotation. No grant, schema, or code change is needed for this.

Once that single item is closed, production certification can be reconsidered without re-running the full Phase 1 acceptance.

---

## 9. Constraints honored

Documentation only. No source edit, no `.env` / `media-service/.env` change, no database or grant change, no migration executed, no commit, no push, no deployment, no Phase 2 work. No credential value appears in this document.
