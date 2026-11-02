# PHASE 1 REPORT — Web application foundation

Date: 2026-11-02
Scope: Next.js foundation, Prisma 7 schema ownership, streaming upload, FastAPI media service skeleton.
**Phase 2 was not started.**

> **Document status — historical record, revised later.**
> This report is the Phase 1 *implementation* record, written before the database
> was provisioned. Statements such as "migration BLOCKED" and "credentials absent"
> were accurate on the date of that audit and are kept for the audit trail. They
> have since been resolved; the authoritative current status is
> [`docs/PHASE-1-FINAL-ACCEPTANCE-REPORT.md`](./PHASE-1-FINAL-ACCEPTANCE-REPORT.md)
> (**FINAL: GO**). Corrections are marked inline with **RESOLVED**.
>
> Sections affected: §2 (migration row), §6 (env files), §8 (rows 10 and 14–19),
> §11, §13 (rows 9 and 11–13), §14.

Status vocabulary: PASS / FAIL / BLOCKED / NOT TESTED.

---

## 1. Objective

Stand up the Phase 1 foundation: a runnable Next.js application with a real
dashboard, project and asset storage backed by MySQL via Prisma, streamed video
upload to local disk, and a FastAPI service ready for transcription in Phase 2 —
without any feature that belongs to a later phase.

---

## 2. Implemented features

| Feature | State |
| --- | --- |
| Repository initialised with git, `.gitignore`, project structure | Done |
| Next.js 16 app shell (sidebar, header, dark editor theme) | Done |
| Dashboard with real aggregate queries and honest DB-unavailable state | Done |
| Projects list page + recent projects on dashboard | Done |
| Create-project dialog wired to a server action (real Prisma insert) | Done, cannot be exercised without DB |
| Project detail page with asset list and upload panel | Done |
| `BlobStore` interface + `LocalBlobStore` (streaming, path-safe) | Done, tested with a real 42 MB file |
| Streaming upload route with SHA-256, size and type validation | Done, HTTP path blocked on DB |
| Prisma 7 config, schema (Project, Asset), generated client, singleton | Done |
| FastAPI service: `/api/health`, `/api/health/db`, CORS, SQLAlchemy wiring | Done, tested live |
| SQLAlchemy read-only models + schema parity test | Done; parity **BLOCKED at the time** (no DB) — **RESOLVED**: parity now runs and passes (8 passed total) |
| `.env.example` files (root + media service) | Done |
| Database migration | **BLOCKED at the time** (no credentials) — **RESOLVED**: `20261102065701_init` created and applied; `projects` + `assets` live (see final acceptance report §7) |

Explicitly **not** implemented (later phases): transcription, video processing,
AI chat, timeline editor, export. Sidebar entries for Exports/Settings are
rendered as visibly disabled, not as working links.

---

## 3. Dependencies and versions

All pins are explicit. `npm install` was run once; 215 packages, 59 s.

### Web (package.json)

| Package | Version | Notes |
| --- | --- | --- |
| next | 16.4.3 | App Router, Turbopack build |
| react / react-dom | 19.3.1 | |
| typescript | 5.9.3 | **not 7.0.2** (latest tag is the native rewrite; Prisma peer requires ≥5.4) |
| tailwindcss / @tailwindcss/postcss | 4.3.3 | v4 pipeline (no autoprefixer needed) |
| prisma (dev) | **7.10.1** | `latest` on npm is `8.0.0-rc.29`, a release candidate |
| @prisma/client | **7.10.1** | must match CLI exactly |
| @prisma/adapter-mariadb | **7.10.1** | driver adapter, required in v7 |
| mariadb | 3.5.4 | Node driver under the adapter |
| dotenv | 18.0.9 | v7 does not auto-load `.env` |
| @radix-ui/react-dialog / react-slot | 1.3.1 / 1.5.0 | shadcn-style primitives |
| class-variance-authority / clsx / tailwind-merge | 0.7.1 / 2.1.1 / 3.7.0 | |
| lucide-react | 1.66.0 | icons |
| postcss | 8.5.32 | |
| tsx | 4.23.15 | verification scripts |
| @types/node / react / react-dom | 26.6.6 / 19.3.0 / 19.3.0 | |

### Media service (media-service/requirements.txt, from `pip freeze`)

`fastapi==0.162.0`, `uvicorn==0.54.0`, `SQLAlchemy==2.1.6`, `PyMySQL==1.2.3`,
`cryptography==50.0.2`, `pydantic==2.14.2`, `starlette==1.10.0`,
`pytest==9.2.0`, `httpx==0.28.1`, plus transitive pins (33 lines total).

Python 3.12.16 in a dedicated `media-service/.venv`. **`whisper/.venv312` was
not modified.**

---

## 4. Project structure

```
.
├── docs/                      architecture, roadmap, phase reports
├── prisma/
│   ├── schema.prisma          Project, Asset, enums
│   └── migrations/            (empty at the time; now 20261102065701_init applied)
├── src/
│   ├── app/
│   │   ├── layout.tsx         shell
│   │   ├── page.tsx           dashboard
│   │   ├── projects/          list + [projectId] detail
│   │   └── api/               health, upload
│   ├── components/            sidebar, app-header, ui/{button,input,dialog}
│   ├── features/projects/     queries, actions, list, dialog, upload, empty state
│   ├── lib/                   env, prisma singleton, storage, id (ULID), utils
│   └── generated/prisma/      generated client (gitignored)
├── media-service/
│   ├── app/{main,config}.py
│   ├── app/api/health.py
│   ├── app/database/session.py
│   ├── app/models/{base,entities}.py
│   ├── tests/                 3 health tests, 5 parity tests
│   ├── requirements.txt
│   └── .env.example
├── scripts/                   verify-storage.ts, verify-db-access.ts
├── data/projects/             runtime media (gitignored)
├── whisper/                   preserved unchanged
├── .env.example
├── .gitignore
├── package.json / tsconfig.json / next.config.ts / postcss.config.mjs
├── prisma.config.ts
└── README.md
```

---

## 5. Prisma configuration

- `prisma.config.ts` at the repo root (required by v7): schema path, migration
  path, `datasource.url` from `DATABASE_URL` (migrator), `shadowDatabaseUrl`
  from `SHADOW_DATABASE_URL`.
- `process.env` is used instead of the `env()` helper so `prisma generate`
  works without a database URL (e.g. in CI or a production build).
- Generator: `provider = "prisma-client"`, `output = "../src/generated/prisma"`
  (the `output` field is mandatory in v7).
- Datasource: `provider = "mysql"` — **no URL in `schema.prisma`** (unsupported in v7).
- Runtime client: `src/lib/prisma.ts`, lazy singleton on `globalThis`, adapter
  pool overridden to `connectionLimit: 5`, `connectTimeout: 5000`,
  `idleTimeout: 300` (adapter defaults are 10 / 1 s / 1800 s).
- Credential separation: Next.js runtime reads `WEB_DATABASE_URL`
  (`aivideo_web`); the Prisma CLI reads `DATABASE_URL` (`aivideo_migrator`).
  Application code never holds DDL rights.
- Scripts: `db:generate`, `db:migrate:dev` (migrate + generate, because v7 no
  longer generates automatically), `db:migrate:deploy`, `db:migrate:status`,
  `db:studio`.

---

## 6. Environment examples

Both templates are committed and contain placeholders only (`CHANGE_ME`); no
real password exists anywhere in the repository.

**`.env.example`** (root): `DATABASE_URL`, `SHADOW_DATABASE_URL` (CLI only),
`WEB_DATABASE_URL` (runtime), `NODE_ENV`, `MEDIA_SERVICE_URL`,
`PROJECT_STORAGE_PATH`, `MAX_UPLOAD_BYTES`.

**`media-service/.env.example`**: `MEDIA_DATABASE_URL`
(`mysql+pymysql://aivideo_media:CHANGE_ME@localhost:3306/aivideo`),
`PROJECT_STORAGE_PATH`, `WORKER_CONCURRENCY=1`, `APP_ENV`, `MEDIA_HOST`,
`MEDIA_PORT`.

No `.env.local` or `media-service/.env` was created — inventing credentials was
explicitly forbidden. `.gitignore` ignores `.env` and `.env.*` while keeping
`!.env.example`.

> **RESOLVED (later).** Both files now exist locally, are gitignored, and all four
> connections (`DATABASE_URL`, `SHADOW_DATABASE_URL`, `WEB_DATABASE_URL`,
> `MEDIA_DATABASE_URL`) authenticate. See the final acceptance report §2 and §6.

---

## 7. Database schema

Prisma is the sole owner of DDL. Two models, deliberately minimal.

**`projects`** — `id` CHAR(26) PK (app-generated ULID), `name` VARCHAR(200),
`status` ENUM('active','archived') default active, `settings` JSON NULL,
`created_at` DATETIME(3) default now, `updated_at` DATETIME(3);
indexes on `created_at` and `status`.

**`assets`** — `id` CHAR(26) PK, `project_id` CHAR(26) FK → projects (CASCADE),
`kind` ENUM('source','derived','preview','export','audio','subtitle'),
`rel_path` VARCHAR(500), `filename` VARCHAR(255), `mime_type` VARCHAR(100),
`sha256` CHAR(64), `bytes` BIGINT, `duration_s` DECIMAL(10,3) NULL, `probe` JSON
NULL, `created_at` DATETIME(3); indexes on (`project_id`,`created_at`) and
`sha256`.

Explicit overrides applied because Prisma's MySQL defaults are wrong for this
data: `String` would be `VARCHAR(191)` (truncates paths), `Decimal` would be
`DECIMAL(65,30)`. InnoDB and `utf8mb4` come from the database defaults set in
`CREATE DATABASE`. Media is never stored in a BLOB column.

**Ownership:** Next.js writes only `projects` and `assets`; the media service
writes only future media-owned tables; the migrator performs DDL.

---

## 8. Tests and actual results

Executed on this machine, in this order. Nothing below is inferred.

| # | Check | Command | Result | Status |
| --- | --- | --- | --- | --- |
| 1 | Dependency install | `npm install` | 215 packages, 59 s | PASS |
| 2 | Prisma client generation **without DB** | `npm run db:generate` | Client 7.10.1 → `src/generated/prisma` in 104 ms | PASS |
| 3 | Prisma schema validity | `npx prisma validate` | "schema is valid" | PASS |
| 4 | Prisma CLI reads config | (during 2/3) | "Loaded Prisma config from prisma.config.ts" | PASS |
| 5 | TypeScript, strict | `npx tsc --noEmit` | 0 errors (2 fixes during development) | PASS |
| 6 | Production build | `npm run build` | Compiled in 6.4 s; 6 routes emitted | PASS |
| 7 | Next.js production server | `next start` on :3123 | `/api/health` 200, `/` 200, `/projects` 200 | PASS |
| 8 | Next.js dev server | `next dev` on :3125 | `/` 200, `/api/health` 200 | PASS |
| 9 | Streaming upload core, real 42 MB video | `npm run verify:storage` | 8/8 checks PASS (details below) | PASS |
| 10 | FastAPI test suite | `pytest -q` | 3 passed, 5 skipped | PASS (skips are the DB parity tests) |
| 11 | FastAPI live server | `uvicorn` on :8124 | `/api/health` 200, `/docs` 200, `/health/db` 503 | PASS |
| 12 | `.gitignore` enforcement | `git check-ignore` × 8 paths | all IGNORED | PASS |
| 13 | Git leak check | `git status --porcelain` | no `.env`, media, `node_modules`, or venv entries | PASS |
| 14 | Prisma migration status | `npx prisma migrate status` | `Error: Connection url is empty` (exit 1) | **BLOCKED** → **RESOLVED** (§8.1) |
| 15 | Initial migration creation | `prisma migrate dev` | not attempted — requires a database | **BLOCKED** → **RESOLVED** (§8.1) |
| 16 | SQLAlchemy ↔ Prisma parity | `pytest tests/test_schema_parity.py` | 5 skipped (no `MEDIA_DATABASE_URL`) | **BLOCKED** → **RESOLVED** (§8.1) |
| 17 | DB access-boundary probe | `npm run verify:db-access` | prints `BLOCKED`, exit 2 | **BLOCKED** → **RESOLVED** (§8.1) |
| 18 | Create project / upload over HTTP | UI + `/api/upload` | needs `projects` table; route returns 503 without DB | **NOT TESTED** → **RESOLVED: PASS** (§8.1) |
| 19 | Project persists across restart | — | requires database | **NOT TESTED** → **RESOLVED: PASS** (§8.1) |

### 8.1 Post-audit resolution (later the same day)

The rows above are exactly what was executed **for this report**; nothing in the
table is rewritten. Rows 10 and 14–19 were later unblocked:

| Row | Then | Now | Evidence |
| --- | --- | --- | --- |
| 10 | 3 passed, 5 skipped | **8 passed** | `pytest -q` in the final acceptance report §8 |
| 14 | `migrate status` → "Connection url is empty" | connected; migration applied | `_prisma_migrations.finished_at` set, checksum `7a796de2584da385…` |
| 15 | initial migration not attempted | **`20261102065701_init` applied** | `prisma/migrations/20261102065701_init/` |
| 16 | parity tests skipped | **passing** (part of the 8) | parity runs against the real `information_schema` |
| 17 | `verify:db-access` BLOCKED | **10/10 PASS** (owner-run); 33 unit tests pass | final acceptance report §6 |
| 18 | create/upload NOT TESTED | **PASS over HTTP** | upload 201, 415 for wrong MIME, traversal contained — §5 |
| 19 | persistence NOT TESTED | **PASS** | row created as `aivideo_web` and rendered on `/`, `/projects`, detail |

### Streaming verification detail (`npm run verify:storage`)

Source: `whisper/videos/sample.mp4`, 42,305,329 bytes.

```
PASS  file written to storage root (not /tmp)
PASS  byte count matches source        (42305329 vs 42305329)
PASS  on-disk size matches             (42305329)
PASS  sha256 matches source            (7c864a33…38a34)
PASS  path containment enforced
PASS  rss growth < 200 MB (streamed)   (33.5 MB)
PASS  rejects unsupported type         (415)
PASS  rejects oversize stream          (413)
source: 40.3 MB in 188 ms
```

A 40 MB file moved through the pipeline with **33.5 MB of RSS growth**, i.e. the
file was streamed, not buffered. The oversize test proves the cap triggers
mid-stream (413) rather than after the whole body is read, and the type test
proves the MIME/extension allowlist rejects non-video input before writing.

### Fixes made during the phase (real failures, not cosmetic)

1. `src/lib/storage.ts` — the DOM `ReadableStream` type lacks
   `Symbol.asyncIterator`; added an explicit `AsyncIterable<Uint8Array>` cast
   (Node's implementation is async-iterable at runtime, proven by test 9).
2. `media-service/app/models/entities.py` — `DateTime(fsp=3)` raised
   `TypeError: DateTime.__init__() got an unexpected keyword argument 'fsp'`.
   Replaced with the MySQL dialect type `sqlalchemy.dialects.mysql.DATETIME(fsp=3)`.

---

## 9. Resource usage (measured)

| Item | Value |
| --- | --- |
| `node_modules` | 771 MB |
| `media-service/.venv` | see `du` run at commit time |
| `npm install` | 59 s |
| Production build | 6.4 s compile + 5.2 s TypeScript |
| Streaming verification | 188 ms for 40.3 MB, +33.5 MB RSS |
| Next.js prod server | served 3 routes concurrently without error |
| Swap/PSI during work | no OOM, no build failure at ~1.1 GB free |

Only one server ran at a time during verification; no encoding jobs were run
(Phase 2+ work).

---

## 10. Files changed

Created (implementation): `package.json`, `package-lock.json`, `tsconfig.json`,
`next.config.ts`, `postcss.config.mjs`, `prisma.config.ts`,
`prisma/schema.prisma`, `.env.example`, `.gitignore`, `README.md`,
`src/app/{layout.tsx,page.tsx,globals.css}`, `src/app/projects/page.tsx`,
`src/app/projects/[projectId]/page.tsx`,
`src/app/api/{health,upload}/route.ts`,
`src/components/{sidebar.tsx,app-header.tsx}`, `src/components/ui/{button,input,dialog}.tsx`,
`src/features/projects/{queries.ts,actions.ts,project-list.tsx,create-project-dialog.tsx,upload-panel.tsx,empty-state.tsx}`,
`src/lib/{env.ts,prisma.ts,storage.ts,id.ts,utils.ts}`,
`media-service/{requirements.txt,.env.example}`,
`media-service/app/{main.py,config.py}`, `media-service/app/api/health.py`,
`media-service/app/database/session.py`, `media-service/app/models/{base.py,entities.py}`,
`media-service/tests/{test_health.py,test_schema_parity.py}`,
`scripts/{verify-storage.ts,verify-db-access.ts}`,
`data/projects/.gitkeep`, `docs/PHASE-1-REPORT.md`.

Modified: `tsconfig.json` (Next.js added `jsx: react-jsx` and
`.next/dev/types` to `include` — automatic, accepted and re-verified).

Not modified: everything under `whisper/` (mtimes unchanged), `docs/` except
this report, and any system package, MariaDB configuration, or other database.

---

## 11. Blockers (historical — all resolved)

> **RESOLVED (later).** Every item below now works: the four connections were
> verified (final acceptance report §2), the `init` migration is applied, both
> databases exist, and `aivideo_web` holds table-scoped `SELECT, INSERT` only.
> The text is preserved as the record of this audit.

**MySQL credentials were absent at the time of this audit.** Specifically:

| Missing | Needed for | Consequence |
| --- | --- | --- |
| `WEB_DATABASE_URL` (`aivideo_web`) | runtime reads/writes | dashboard shows "Database not configured"; create/upload disabled |
| `DATABASE_URL` (`aivideo_migrator`) | Prisma Migrate | `prisma migrate status` → "Connection url is empty" |
| `SHADOW_DATABASE_URL` (`aivideo_shadow`) | `prisma migrate dev` | shadow DB does not exist yet |
| `MEDIA_DATABASE_URL` (`aivideo_media`) | SQLAlchemy | parity tests skip; `/health/db` returns 503 |

Also outstanding: the `aivideo` database exists but is **empty** (`aivideo_shadow`
not created), and no initial migration has been generated because generating one
requires a reachable database.

> **RESOLVED.** `aivideo` now contains `projects`, `assets`, `_prisma_migrations`;
> `aivideo_shadow` exists and is empty, as a shadow database should be.

No password guessing was attempted, no users or databases were created, no
MariaDB configuration was changed, and no other database was touched (the
server's 16 schemas are unchanged).

---

## 12. Remaining risks

1. **Prisma 8 RC trap** — any unpinned `npm i prisma` will install
   `8.0.0-rc.29`. Pins are exact; keep them exact.
2. **ESM constraint** — `"type": "module"` is required by Prisma 7 and now
   applies to the whole project; any CommonJS tool added later needs care.
3. **`@updatedAt` asymmetry** — Prisma sets `updated_at` client-side. When the
   media service starts writing `plans`/`jobs`, it must set it explicitly or the
   column silently goes stale (documented in architecture §7.8).
4. **Upload route needs the DB for correctness** — it deliberately returns 503
   rather than writing orphan files, which is why criterion 9 is only proven at
   the storage layer.
5. **Memory headroom** — Next dev (~350–600 MB) plus MySQL (~150–250 MB) against
   ~1.1 GB free is tight; close the browser during builds.
6. **Tailwind v4 / `@theme` tokens** — class names such as `bg-canvas` depend on
   the `@theme` block in `globals.css`; renaming a token silently removes
   utilities.
7. **No eslint config** — linting was not part of this phase; `tsc` and
   `next build` are the gates that were actually run.

---

## 13. Exit criteria status

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Next.js can run | **PASS** | prod `next start` 200 on `/`, `/projects`, `/api/health`; dev 200 |
| 2 | FastAPI can run | **PASS** | uvicorn on :8124 → `/api/health` 200 |
| 3 | `npm run build` succeeds | **PASS** | compiled 6.4 s, 6 routes |
| 4 | `npx tsc --noEmit` succeeds | **PASS** | exit 0 |
| 5 | Prisma Client generates without DB | **PASS** | 7.10.1 → `src/generated/prisma` in 104 ms |
| 6 | Prisma CLI reads configuration | **PASS** | "Loaded Prisma config from prisma.config.ts" |
| 7 | Environment examples complete | **PASS** | root + media-service templates, placeholders only |
| 8 | `.gitignore` protects credentials and media | **PASS** | 8/8 paths IGNORED; no leaks in `git status` |
| 9 | Upload streams | **PASS (storage layer)** / **NOT TESTED (HTTP)** → **RESOLVED: PASS** | 42 MB streamed, +33.5 MB RSS; the HTTP route later returned 201 (final acceptance report §5) |
| 10 | FastAPI health endpoint works | **PASS** | `/api/health` 200, `/health/db` 503 without DB |
| 11 | Database structure + repository access prepared | **PASS (code)** / **BLOCKED (migration)** → **RESOLVED: PASS** | schema, singleton, repositories exist; `init` migration later applied |
| 12 | Database access-boundary test prepared | **PASS (prepared)** / **BLOCKED (execution)** → **RESOLVED: 10/10 PASS** | `verify:db-access` exists; 33 unit tests cover its classification |
| 13 | No changes to other databases | **PASS** | 16 schemas unchanged at the time (18 observed later, none created by this project); MariaDB service untouched |

---

## 14. Final status (historical)

> **SUPERSEDED.** The two blocked items were resolved and every criterion now
> passes. Current verdict: **FINAL GO** —
> [`docs/PHASE-1-FINAL-ACCEPTANCE-REPORT.md`](./PHASE-1-FINAL-ACCEPTANCE-REPORT.md).
> The paragraphs below are the original conclusion, kept unchanged.

**Phase 1 implementation: PASS with two blocked items.**

- 13 of 13 exit criteria were addressed; 10 are fully PASS.
- 3 are split: the code exists and is verified as far as possible, but the
  database-dependent half is **BLOCKED** by missing credentials (criteria 9, 11, 12).
- Nothing was reported PASS that was not executed. The five skipped parity
  tests and the migration are labelled BLOCKED, not passed.

**Phase 2 has not been started. No deployment was performed.**

### To unblock

```sql
-- run once as an administrator
CREATE DATABASE aivideo_shadow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'aivideo_migrator'@'localhost' IDENTIFIED BY '<generated>';
CREATE USER 'aivideo_web'@'localhost'      IDENTIFIED BY '<generated>';
CREATE USER 'aivideo_media'@'localhost'    IDENTIFIED BY '<generated>';
GRANT ALL PRIVILEGES ON aivideo.*        TO 'aivideo_migrator'@'localhost';
GRANT ALL PRIVILEGES ON aivideo_shadow.* TO 'aivideo_migrator'@'localhost';
GRANT SELECT ON aivideo.* TO 'aivideo_web'@'localhost';
GRANT SELECT ON aivideo.* TO 'aivideo_media'@'localhost';
```

> **What was actually applied (differs from this draft).** `aivideo_web` received
> table-scoped `SELECT, INSERT` on `projects` and `assets` — not a database-wide
> `SELECT` — and `aivideo_media` `SELECT ON aivideo.*`. An accidental global
> `GRANT … ON *.* WITH GRANT OPTION` was later found on `aivideo_web` and revoked;
> see `docs/PHASE-1-PRIVILEGE-ROOT-CAUSE-AUDIT.md` and the final acceptance
> report §6.

Then, with credentials in `.env.local` and `media-service/.env`:

```bash
npm run db:migrate:dev -- --name init   # creates prisma/migrations/<ts>_init
npm run db:migrate:status
npm run verify:db-access                # proves the write boundary
cd media-service && .venv/bin/pytest -q  # parity tests stop skipping
```

**Approval is requested before Phase 2 (transcription engine).**
