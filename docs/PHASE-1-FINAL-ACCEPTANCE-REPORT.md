# PHASE 1 — FINAL ACCEPTANCE REPORT

Date: 2026-11-02
Project: AI Video Editor — `~/ai-video-editor`
Server: MariaDB 11.8.8 (`localhost:3306`), database `aivideo`
Scope: Phase 1 foundation only. **Phase 2 was not started and remains locked.**

Status vocabulary: PASS / FAIL / BLOCKED / **NOT TESTED**. Nothing below is marked PASS unless it was executed in this audit.

---

## 1. Decision

# ✅ FINAL: GO

All Phase 1 acceptance criteria are met on executed evidence: build, typecheck, unit tests, FastAPI tests, Prisma validation, live streaming upload, size/MIME/path controls, least-privilege database access, migration integrity, and zero residue.

Three items are explicitly **NOT TESTED** (§10) and none of them is a Phase 1 acceptance criterion: browser-driven form submission of the create-project dialog, HTTP-level 413 (covered at the storage layer instead), and a re-run of `verify:db-access` (privilege state verified directly from the server instead).

**Phase 2 stays locked until explicit approval.**

---

## 2. Environment

| Item | Value |
| --- | --- |
| Database | MariaDB 11.8.8, `aivideo` tables: `assets`, `projects`, `_prisma_migrations` |
| Web runtime account | `aivideo_web@localhost` |
| Media runtime account | `aivideo_media@localhost` |
| Prisma | 7.10.1 (`prisma-client` generator → `src/generated/prisma`) |
| Next.js | 16.4.3, production build + `next start` on a spare port |
| FastAPI | uvicorn on a spare port, `media-service/.venv` |

---

## 3. Acceptance matrix

| # | Criterion | Evidence | Status |
| --- | --- | --- | --- |
| 1 | Dashboard renders with database state | `GET /` → 200, 23,254 bytes; markers `Recent projects`, `Source assets`, project name rendered | **PASS** |
| 2 | Project listing renders | `GET /projects` → 200, 17,736 bytes; empty state with 0 rows, project name with 1 row | **PASS** |
| 3 | Project detail renders | `GET /projects/<id>` → 200; shows project name, `Source video`, uploaded filename; `No source footage yet` when empty | **PASS** |
| 4 | Create project persists | `project.create` through the app's own client as `aivideo_web@localhost` → row created, visible on `/` and `/projects` and on its detail page | **PASS (service layer)** / **NOT TESTED (browser form)** — see §10.1 |
| 5 | Upload streams to disk | `POST /api/upload` → 201; file on disk at `data/projects/<projectId>/source/<assetId>.mp4` (2,048 bytes); row written | **PASS** |
| 6 | Streaming (constant memory) | `verify:storage`: 40.3 MB file in 212 ms, **+46.3 MB RSS** (< 200 MB limit) | **PASS** |
| 7 | Size limit enforced | `verify:storage` oversize stream → **413** mid-stream | **PASS (storage layer)** |
| 8 | MIME validation | HTTP `text/plain` → **415** `Unsupported video type "text/plain". Allowed: mp4, mov, mkv, webm.` | **PASS** |
| 9 | Path containment | Traversal filename `../../evil.mp4` → 201 but resolved inside the project dir; **0** files outside `data/projects`, **0** files named `evil*` anywhere | **PASS** |
| 10 | Disk storage location | Files under `data/projects/…` on `/home`, never `/tmp`; `storageRoot: ./data/projects` in `/api/health` | **PASS** |
| 11 | SHA-256 recorded correctly | Uploaded 2,048-byte file: response hash equals locally computed `sha256sum`; DB has 2/2 assets with `sha256`; storage test matched a 42 MB source | **PASS** |
| 12 | Prisma runtime uses `aivideo_web` | Live query through `src/lib/prisma.ts` → `{"usr":"aivideo_web@localhost","db":"aivideo","ver":"11.8.8-MariaDB"}` | **PASS** |
| 13 | FastAPI uses `aivideo_media` | `SHOW GRANTS` = `USAGE` + `SELECT ON aivideo.*`; `/api/health/db` → 200 | **PASS** |
| 14 | Database readiness (web) | `GET /api/health` → 200 `{"database":"configured"}` | **PASS** |
| 15 | Database readiness (media) | `GET /api/health/db` → 200 `{"status":"ok"}` (real `SELECT 1`) | **PASS** |
| 16 | Liveness (media) | `GET /api/health` → 200 `{"status":"ok","database":"configured","worker_concurrency":1}` | **PASS** |
| 17 | TypeScript | `npx tsc --noEmit` → exit 0 | **PASS** |
| 18 | Unit tests | `npm run test:unit` → **33 tests, 33 pass, 0 fail** | **PASS** |
| 19 | FastAPI tests | `pytest -q` → **8 passed**, 1 warning (httpx deprecation) | **PASS** |
| 20 | Prisma validation | `prisma validate` → "The schema at prisma/schema.prisma is valid", exit 0 | **PASS** |
| 21 | Production build | `npm run build` → exit 0, "Compiled successfully in 2.1s", 7 workers, routes emitted | **PASS** |
| 22 | Migration unchanged and applied | `20261102065701_init`, `finished=1`, `applied_steps_count=1`, checksum `7a796de2584da385…` | **PASS** |
| 23 | No excessive database access | `aivideo_web`: `USAGE` + `SELECT, INSERT` on `aivideo.projects` and `aivideo.assets` only — no global, no db-level, no UPDATE/DELETE/CREATE, no other schema | **PASS** |
| 24 | No probe data / test files left | `projects=0`, `assets=0`, probe-named projects `=0`; `data/projects` holds only `.gitkeep`; no `.verify.*` dirs | **PASS** |
| 25 | Git diff reviewed | 6 modified + 10 untracked paths, all accounted for (§9); nothing committed | **PASS** |
| 26 | Phase 1 documentation present | 6 Phase 1 documents in `docs/`; one stale status line flagged (§9.2) | **PASS with follow-up** |

---

## 4. Storage verification detail (`npm run verify:storage`, exit 0)

```
PASS  file written to storage root (not /tmp)
PASS  byte count matches source            42,305,329 vs 42,305,329
PASS  on-disk size matches                 42,305,329
PASS  sha256 matches source                7c864a33…38a34
PASS  path containment enforced
PASS  rss growth < 200 MB (streamed)       46.3 MB
PASS  rejects unsupported type             415
PASS  rejects oversize stream              413
source: 40.3 MB in 212 ms
cleanup: removed data/projects/<generated id>
```

A 40 MB file moved through the pipeline with 46.3 MB of RSS growth: the payload was streamed, not buffered. The 413 fires mid-stream (the test writes only two 4 KB chunks against a 4 KB cap), proving the limit is enforced while reading rather than after the whole body is received.

---

## 5. Upload over HTTP (production server)

Disposable project `G08JT7CJ2SBZ8G3FJGBZFD5TE5`, removed afterwards.

| Request | Result |
| --- | --- |
| `POST /api/upload?projectId=…`, 2,048 B, `content-type: video/mp4` | **201** `{"asset":{"relPath":"<project>/source/<ulid>.mp4","sha256":"951d56a1…","bytes":2048}}` |
| same file, `content-type: text/plain` | **415** with the allow-list message |
| same file, filename `%2E%2E%2F%2E%2E%2Fevil.mp4` | **201**, stored at `<project>/source/<ulid>.mp4`; `evil*` found **0** times outside the project dir and **0** times outside `data/projects` |
| `GET /projects/<id>` afterwards | **200**, listing `acceptance-clip.mp4` and `Source video` |

Disk: exactly two files, both `<projectId>/source/<assetId>.mp4`, 2,048 bytes each. Database: 2 asset rows, both with `sha256`.

**Cleanup:** `DELETE FROM assets WHERE project_id=…`, `DELETE FROM projects WHERE id=…`, `rm -rf data/projects/<id>`. After cleanup `projects=0`, `assets=0`, `data/projects` files `=1` (`.gitkeep`), directories `=0`.

---

## 6. Prisma runtime identity

Executed through the application's own singleton (`src/lib/prisma.ts` + `src/lib/env-loader.ts`), not a raw driver:

```
{"usr":"aivideo_web@localhost","db":"aivideo","ver":"11.8.8-MariaDB"}
```

Combined with `SHOW GRANTS FOR CURRENT_USER()`:

```
GRANT USAGE ON *.* TO `aivideo_web`@`localhost`
GRANT SELECT, INSERT ON `aivideo`.`assets`   TO `aivideo_web`@`localhost`
GRANT SELECT, INSERT ON `aivideo`.`projects` TO `aivideo_web`@`localhost`
```

Least privilege holds: no global privilege beyond `USAGE`, no database-level grant, no `UPDATE`, no `DELETE`, no `CREATE`, no access to any other schema. The earlier critical finding (global `SELECT, INSERT, UPDATE, DELETE, CREATE … WITH GRANT OPTION`) is resolved.

`aivideo_media` is equally scoped: `USAGE` + `SELECT ON aivideo.*` — read-only, appropriate for a service that writes only future media-owned tables.

---

## 7. Migration integrity

| Check | Result |
| --- | --- |
| Files on disk | `prisma/migrations/20261102065701_init/migration.sql`, `migration_lock.toml` |
| Applied row | `20261102065701_init`, `finished=1`, `applied_steps_count=1`, checksum `7a796de2584da385…` |
| Schema matches models | `aivideo` contains exactly `projects`, `assets`, `_prisma_migrations` |
| New migration this audit | **None** — no `migrate` command was run |
| Data volumes | `projects=0`, `assets=0` before and after the audit |

---

## 8. Test and build results (all executed this audit)

| Command | Exit | Output |
| --- | --- | --- |
| `npx tsc --noEmit` | 0 | no diagnostics |
| `npm run test:unit` | 0 | 33 tests, 33 pass, 0 fail, 256 ms |
| `npx prisma validate` | 0 | "schema … is valid" |
| `media-service/.venv/bin/pytest -q` | 0 | 8 passed, 1 warning, 1.17 s |
| `npm run build` | 0 | compiled in 2.1 s, static pages 262 ms |
| `npm run verify:storage` | 0 | 8/8 checks PASS |
| `next start` + HTTP probes | — | `/api/health` 200, `/` 200, `/projects` 200, detail 200, upload 201/415 |
| uvicorn + HTTP probes | — | `/api/health` 200, `/api/health/db` 200 |

FastAPI now runs 8 tests (the 5 schema-parity tests no longer skip, because `MEDIA_DATABASE_URL` is configured and `aivideo` has the tables).

---

## 9. Git diff and documentation review

### 9.1 Working tree

Modified (6): `.gitignore` (+7), `media-service/app/config.py` (+22), `package.json` (+3/−1), `prisma.config.ts` (+10/−…), `scripts/verify-db-access.ts` (+140/−…), `tsconfig.json` (+3/−…).

Untracked (10): `prisma/migrations/` (init migration + lock), `scripts/prisma-migrate-dev.mjs`, `src/lib/{db-access-verify,db-error,env-loader,redact}.ts`, `tests/`, and 4 new audit/Phase-1 documents plus this report.

Every path maps to work described in the Phase 1 audits (env loading, migration script, verifier, error classification). **No unexpected file, no `.env*`, no credential, no `data/` artefact is tracked or staged. Nothing was committed.**

**One structural gap:** `prisma/migrations/` is untracked. The schema history exists only in the working tree, so a fresh clone could not reproduce the database. Committing it is required before any deployment — explicitly out of scope for this audit.

### 9.2 Phase 1 documentation

Present: `PHASE-1-REPORT.md`, `PHASE-1-PRE-MIGRATION-AUDIT.md`, `PHASE-1-DB-ACCESS-SCRIPT-FIX.md`, `PHASE-1-DB-ACCESS-ERROR-CLASSIFICATION-AUDIT.md`, `PHASE-1-PRIVILEGE-ROOT-CAUSE-AUDIT.md`, this report.

Stale statements that should be corrected (not edited here — this audit only reports):

- `PHASE-1-REPORT.md` §2/§11/§13 still says the migration is "Not created — BLOCKED (no credentials)" and credentials are "absent". Both are false now: the `init` migration is applied and all four accounts authenticate.
- `PHASE-1-REPORT.md` §8 row 16 says the parity tests are "5 skipped (no `MEDIA_DATABASE_URL`)"; they now pass (8 total).
- `README.md` is unchanged and still accurate for setup, but does not mention `npm run test:unit`.

---

## 10. NOT TESTED (explicitly)

1. **Create-project dialog submitted through a browser.** The insert path was exercised with the same `prisma.project.create` call the server action uses, as `aivideo_web`, and the resulting row rendered on `/`, `/projects` and the detail page. The client→server-action HTTP transport (form submit → `revalidatePath`) was not driven; no headless browser is installed.
2. **HTTP 413 for an oversized upload.** The 2 GiB default cap cannot be exceeded in a test without allocating gigabytes; the cap is proven at the storage layer by `verify:storage` (413 mid-stream). The route's declared `content-length` pre-check was likewise not triggered.
3. **`npm run verify:db-access` re-run.** Earlier instruction was not to re-run it. Privilege state was instead verified directly from the server (`SHOW GRANTS`, `information_schema`), which is the authoritative source the script reports on. Its unit tests (33 total suite) still pass.

Also out of scope by instruction: any migration, GRANT/REVOKE, password change, database deletion, deployment, or commit.

---

## 11. Residual risks

| # | Risk | Severity | Note |
| --- | --- | --- | --- |
| R1 | `prisma/migrations/` untracked | **High for deployment** | Schema history not reproducible from a clone; commit before shipping |
| R2 | `PHASE-1-REPORT.md` stale (migration/credentials/parity) | Low | Misleading for the next reader; correct before archiving the phase |
| R3 | Upload accepts any bytes labelled `video/mp4` | Low, by design | No media parsing in Phase 1; PyAV/ffprobe belongs to Phase 2. Content-type/extension allow-list is the only gate |
| R4 | No unique constraint on `(project_id, filename)`; `sha256` indexed but not unique | Low | Deliberate; duplicate uploads create separate assets |
| R5 | `updated_at` is client-side only (`@updatedAt`, no DB default) | Low | Any future SQLAlchemy writer must set it explicitly |
| R6 | `aivideo_web` previously held global privileges (was readable `mysql.user`) | Medium, mitigated | Grant revoked; consider rotating the account password since hashes were exposed |
| R7 | Browser UI unverified (§10.1) | Low | Data layer proven; form transport is stock Next.js |

---

## 12. Conditions attached to GO

1. Commit `prisma/migrations/` (with the rest of the Phase 1 work) before any deployment — **not done here by instruction**.
2. Correct the stale lines in `PHASE-1-REPORT.md` (§9.2).
3. When convenient, tick the three NOT TESTED items: submit the create dialog in a browser, exercise a 413 with a temporarily lowered `MAX_UPLOAD_BYTES` on a throwaway server, and run `verify:db-access` once.

None of these blocks Phase 1 acceptance, and none requires touching Phase 2 code.

---

## 13. Phase 2

**Locked.** No transcription, video processing, AI planning, timeline, or export code exists or was touched. Approval must be explicit.
