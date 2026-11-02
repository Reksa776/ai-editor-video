# PHASE 1 — PRE-MIGRATION FINAL AUDIT

Date: 2026-11-02
Scope: security of local secrets, Prisma schema review, Next.js privilege requirements, migration readiness.
**Read-only.** No migration was run, no table was created or altered, no user or grant was changed, no application code was modified, and nothing was committed. **Phase 2 was not started.**

Status vocabulary: PASS / FAIL / BLOCKED / NOT TESTED.

---

## 1. Executive summary

| Area | Result |
| --- | --- |
| Secrets protection (`.gitignore`) | **PASS** — after this audit's one edit |
| Prisma schema vs. app code vs. SQLAlchemy | **PASS** — no defect found; no schema change made |
| Next.js privilege requirements | **FAIL (current grants)** — `aivideo_web` is SELECT-only; `INSERT` is required on both tables |
| Migration readiness | **PASS (environment)** — migrator + shadow + isolated targets verified; zero migrations, zero tables |
| **Recommendation** | **CONDITIONAL GO** to create/apply the `init` migration; **NO-GO** to declaring Phase 1 complete until `aivideo_web` can write |

The schema is sound and the migration environment is correctly isolated. The only blockers are the two known non-schema defects: missing `INSERT` grants for the web account, and no migration yet. Neither requires a schema change.

---

## 2. Security findings (Task A)

### 2.1 Change made

`.gitignore` — one section appended:

```gitignore
# ---- Editor swap/backup files (can contain unsaved secret file contents) ----
*.kate-swp
*.swp
*.swo
```

`*.swp` / `*.swo` were added alongside `*.kate-swp` because Vim writes the same kind of plaintext swap file; leaving that hole open next to a credentials file would repeat the same exposure.

### 2.2 Verification

`git check-ignore -q <path>` — exit 0 means ignored:

| Path | Status |
| --- | --- |
| `akses database local.txt` | IGNORED |
| `.akses database local.txt.kate-swp` | IGNORED |
| `sample.kate-swp` (arbitrary name) | IGNORED — pattern is name-independent |
| `.env` | IGNORED |
| `.env.local` | IGNORED |
| `media-service/.env` | IGNORED |

`git status --short` no longer lists either secret file as untracked.

### 2.3 Findings

1. **Swap file was exposed (now mitigated).** `.akses database local.txt.kate-swp` is Kate's on-disk copy of the credentials note and contains the same plaintext secrets. It was untracked *and* unignored, i.e. one `git add -A` away from being committed.
2. **The file was not deleted**, as instructed — Kate may still hold it open, and removing a live swap file can prompt data-loss recovery dialogs or discard unsaved edits. Ignoring it is the correct, non-destructive fix. Once Kate is closed normally, the swap file is deleted by the editor itself.
3. **Root cause is structural, not a one-off.** Secrets live in a plaintext note inside the repo working tree. Ignore patterns are the only thing between them and a commit. Moving the note outside the repository (e.g. `~/.config/`) removes the class of risk entirely; this audit deliberately did not move the user's file.
4. **No credentials were printed** in this audit. Database targets are reported as scheme/host/port/user/database only; passwords are never read into output. Note that MariaDB's `SHOW GRANTS` output embeds account password *hashes* — those were inspected during connection verification and are deliberately excluded from every report.

---

## 3. Schema review (Task B)

Source of truth: `prisma/schema.prisma` (Prisma 7, `provider = "mysql"`, no `url` in the datasource — supplied by `prisma.config.ts`). Mirrors: `media-service/app/models/entities.py` (SQLAlchemy 2.x, read-only) and the Next.js data layer.

### 3.1 `projects`

| Prisma field | Prisma type | MySQL type | SQLAlchemy mirror | Verdict |
| --- | --- | --- | --- | --- |
| `id` | `String @id` | `CHAR(26)` PK | `CHAR(26)` PK | matches — ULID generated in app (`src/lib/id.ts`) |
| `name` | `String` | `VARCHAR(200)` | `String(200)` NOT NULL | matches; action validates 2–200 chars |
| `status` | `ProjectStatus` | `ENUM('active','archived')` DEFAULT `active` | `Enum('active','archived')`, default `active` | matches — `@map` values are lowercase, same as SQLAlchemy |
| `settings` | `Json?` | `JSON` NULL | `JSON` NULL | matches; unused in Phase 1 |
| `createdAt` | `DateTime @db.DateTime(3)` DEFAULT `now()` | `DATETIME(3)` DEFAULT `CURRENT_TIMESTAMP(3)` | `DATETIME(fsp=3)` NOT NULL | matches |
| `updatedAt` | `DateTime @updatedAt @db.DateTime(3)` | `DATETIME(3)` NOT NULL, **no DB default, no ON UPDATE** | `DATETIME(fsp=3)` NOT NULL | matches column-for-column; see hazard H1 |

Indexes: `@@index([createdAt])` (backs `ORDER BY created_at DESC`), `@@index([status])`. Table name `projects`.

### 3.2 `assets`

| Prisma field | Prisma type | MySQL type | SQLAlchemy mirror | Verdict |
| --- | --- | --- | --- | --- |
| `id` | `String @id` | `CHAR(26)` PK | `CHAR(26)` PK | matches |
| `projectId` | `String` FK | `CHAR(26)` NOT NULL, FK → `projects.id` ON DELETE CASCADE | `CHAR(26)`, `ForeignKey(..., ondelete="CASCADE")` | matches |
| `kind` | `AssetKind` | `ENUM('source','derived','preview','export','audio','subtitle')` DEFAULT `source` | `Enum(...)` same six values | matches |
| `relPath` | `String @db.VarChar(500)` | `VARCHAR(500)` | `String(500)` | matches — explicit override avoids Prisma's `VARCHAR(191)` default, which would truncate paths (asserted by `test_long_path_column_is_not_truncated`) |
| `filename` | `String` | `VARCHAR(255)` | `String(255)` | matches |
| `mimeType` | `String` | `VARCHAR(100)` | `String(100)` | matches |
| `sha256` | `String @db.Char(64)` | `CHAR(64)` | `CHAR(64)` | matches — hex digest length is exact |
| `bytes` | `BigInt` | `BIGINT` | `BigInteger` | matches; app writes `BigInt(number)`, bounded by `MAX_UPLOAD_BYTES` (2 GiB) |
| `durationS` | `Decimal? @db.Decimal(10,3)` | `DECIMAL(10,3)` NULL | `Numeric(10,3)` NULL | matches — max 9,999,999.999 s ≈ 115 days, ample for source footage |
| `probe` | `Json?` | `JSON` NULL | `JSON` NULL | matches; populated in a later phase |
| `createdAt` | `DateTime @db.DateTime(3)` | `DATETIME(3)` DEFAULT `CURRENT_TIMESTAMP(3)` | `DATETIME(fsp=3)` | matches |

Indexes: `@@index([projectId, createdAt])` (backs the per-project asset list ordered by `created_at`), `@@index([sha256])` (dedupe lookups). No `updatedAt` on `Asset`, and the SQLAlchemy model correctly omits it. Table name `assets`.

### 3.3 Consistency with Phase 1 application code

- **IDs** — `ulid()` produces 26 Crockford base32 chars; `isUlid()` validates the same pattern. `CHAR(26)` is exact on both tables, and `LocalBlobStore` rejects non-ULID project/asset ids before touching the filesystem. ✓
- **`kind`** — upload route writes `"SOURCE"`, matching the enum member and its `source` mapping. ✓
- **`relPath`** — generated as `<projectId>/source/<assetId><ext>`, well inside 500 chars; the storage layer guarantees containment under the root. ✓
- **`sha256`/`bytes`** — computed while streaming, hex digest (64) and byte count; upload route converts `BigInt` back to `Number` for JSON. ✓
- **`status`** — `ProjectSummary` types it as `"ACTIVE" | "ARCHIVED"` (Prisma enum names); the DB stores `active`/`archived` via `@map`. ✓
- **Timestamps** — `getProject`/`listProjects` order by `createdAt`; both indexes exist. ✓

### 3.4 Defects found

**None.** No column, type, length, nullability, default, relation, or index mismatch was found across the three definitions. No schema change was made, as required.

### 3.5 Observations (documented, not changed)

| # | Observation | Impact |
| --- | --- | --- |
| H1 | `updated_at` is maintained **client-side only** (`@updatedAt`). The column is `NOT NULL` with no DB default and no `ON UPDATE`. | Any writer other than Prisma must set it explicitly, or the insert fails (no default) / the value goes stale. Phase 1 only writes via Prisma, so this is latent, not active. It becomes real when the media service starts writing media-owned tables. |
| H2 | No unique constraint on `(project_id, filename)`. | Intentional: paths are ULID-based, so re-uploading the same filename creates a separate asset. Prevents accidental collision failures. |
| H3 | `sha256` is indexed but not unique. | Deduplication is a later-phase decision; uniqueness now would block legitimate duplicate uploads. |
| H4 | `projects.settings` and `assets.probe` are defined but never written in Phase 1. | Reserved for later phases; harmless (nullable). |
| H5 | SQLAlchemy models declare no `__table_args__`/indexes. | Cosmetic only — Prisma owns DDL and the database indexes are what matter; the parity test checks columns and `rel_path` length, which is the real risk. |
| H6 | Database collation is `utf8mb4_uca1400_ai_ci` (MariaDB 11.8 default), not the `utf8mb4_unicode_ci` mentioned in older notes. | No drift: the schema sets no collation, so MySQL DDL inherits the database default consistently. Only matters if a future database is created with a different default. |

---

## 4. Next.js privilege audit (Task C)

Not granted here. This is the exact minimum implied by Phase 1 code.

### 4.1 Every database operation in the web app

| Call site | Operation | Prisma API | Tables touched |
| --- | --- | --- | --- |
| `src/features/projects/actions.ts` → `createProjectAction` | **INSERT** | `project.create({ data: { id, name }, select: { id } })` | `projects` (write); `id` is supplied by the app, so no generated column is read back |
| `src/features/projects/queries.ts` → `listProjects` | **SELECT** | `project.findMany` + `include: { _count: { assets } }` | `projects`, `assets` (count subquery) |
| `src/features/projects/queries.ts` → `getDashboardSummary` | **SELECT** | `project.count`, `asset.aggregate({ _sum: bytes, _count })`, `project.findMany` | `projects`, `assets` |
| `src/features/projects/queries.ts` → `getProject` | **SELECT** | `project.findUnique` + `include: { assets: {...}, _count }` | `projects`, `assets` |
| `src/app/api/upload/route.ts` | **SELECT** then **INSERT** | `project.findUnique({ select: { id } })`, then `asset.create({...})` | `projects` (read), `assets` (write) |
| `src/app/api/health/route.ts` | none | — (config check only) | none |
| `src/lib/prisma.ts` | none | client construction only | none |
| `src/lib/storage.ts` | none (filesystem only) | — | none |

No `UPDATE`, no `DELETE`, no raw SQL anywhere in `src/`. `revalidatePath` is a Next.js cache call, not a database write.

### 4.2 Required operations per table

| Table | SELECT | INSERT | UPDATE | DELETE | Why |
| --- | --- | --- | --- | --- | --- |
| `projects` | **required** | **required** | not used | not used | list/dashboard/detail/upload-guard reads; create-project writes |
| `assets` | **required** | **required** | not used | not used | asset lists, `_count`, `_sum(bytes)`; upload records the row |

`UPDATE` is unused because no Phase 1 feature renames a project or edits an asset. `DELETE` is unused because no Phase 1 feature deletes anything; note `LocalBlobStore.remove()` is called on upload failure, but that removes a **file**, not a row.

### 4.3 Minimum grants (proposed — **not executed**)

```sql
GRANT SELECT, INSERT ON aivideo.projects TO 'aivideo_web'@'localhost';
GRANT SELECT, INSERT ON aivideo.assets   TO 'aivideo_web'@'localhost';
```

Notes:

- The account currently holds `SELECT ON aivideo.*` (database-wide). That is broader than the app needs and is *not* least-privilege; table-scoped grants above are tighter. The existing db-wide `SELECT` must be revoked if table-scoped grants replace it, otherwise the account simply keeps reading every future table.
- If project deletion is added later, `DELETE ON aivideo.projects` is sufficient — MySQL performs FK-cascaded deletions on `assets` without requiring `DELETE` on the child table.
- `scripts/verify-db-access.ts` is the one script that needs writes beyond the app: it inserts a `projects` row and deletes it again, so it additionally needs `DELETE ON aivideo.projects`. It will report `BLOCKED` until then.
- `aivideo_media` is correctly read-only for Phase 1 (no media-owned tables exist yet). No change needed now; Phase 2 will require scoped `INSERT`/`UPDATE` on its own tables.

---

## 5. Migration readiness (Task D)

All checks were executed read-only (`information_schema` queries, `prisma validate`, `prisma migrate status`).

| # | Check | Evidence | Status |
| --- | --- | --- | --- |
| 1 | Prisma CLI uses `aivideo_migrator` | resolved `datasource.url` → `mysql://…@localhost:3306/aivideo`, user `aivideo_migrator` | **PASS** |
| 2 | Shadow database configured | resolved `datasource.shadowDatabaseUrl` → user `aivideo_migrator`, db `aivideo_shadow`; connection verified (`SELECT 1`, `DATABASE()` = `aivideo_shadow`) | **PASS** |
| 3 | Shadow database usable | exists, `utf8mb4` / `utf8mb4_uca1400_ai_ci`, **0 tables**, 0 views, 0 triggers, 0 routines | **PASS** |
| 4 | Migration directory empty | `ls -A prisma/migrations` → 0 entries (directory exists) | **PASS** (nothing to apply yet) |
| 5 | `aivideo` is the intended target | resolved target db name `aivideo`; `prisma migrate status` prints `MySQL database "aivideo" at "localhost:3306"` | **PASS** |
| 6 | Target is pristine | `aivideo` **0 tables**, 0 views, 0 triggers, 0 routines; not yet managed by Prisma Migrate | **PASS** |
| 7 | No unrelated database can be affected | migrator grants: `ALL PRIVILEGES` on `aivideo`.* and `aivideo_shadow`.* only; `SHOW DATABASES` returns exactly `aivideo`, `aivideo_shadow`, `information_schema`; `SHOW GRANTS` shows only global `USAGE` outside those two | **PASS** |
| 8 | Character set | both databases `utf8mb4` | **PASS** |
| 9 | Arguments reach `migrate dev` | `scripts/prisma-migrate-dev.mjs` dry-run forwarded `--name init` to `migrate dev` only | **PASS** |
| 10 | `prisma migrate status` | exit 1 with "No migration found in prisma/migrations / The current database is not managed by Prisma Migrate" | **PASS (expected)** — accurate for an empty history, not an error to fix |

### 5.1 Risks for the migration run

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | **`prisma.config.ts` loads `.env.local` with `override: true`.** A stale or copied `.env.local` on any host silently beats an exported `DATABASE_URL`, so `db:migrate:deploy` can target the wrong database without any error. | Treat `.env.local` as host-local only; on CI/production either omit it or ensure it holds the intended URL; prefer exported env + no local file. |
| R2 | Shadow DB is shared. `migrate dev` **wipes and rewrites** `aivideo_shadow`. | It is empty and dedicated; never point `SHADOW_DATABASE_URL` at `aivideo`. |
| R3 | After migrating, the app will read fine but fail on create/upload. | Grant `SELECT, INSERT` on `projects` and `assets` to `aivideo_web` before exercising the UI, otherwise Phase 1 looks broken for the wrong reason. |
| R4 | `updated_at` has no DB default (H1). | Keep all Phase 1 writes on Prisma; set it explicitly in any future SQLAlchemy write path. |
| R5 | `migrate dev` must never run against production data. | Today the target is empty, so `init` is safe; from the second migration on, use `db:migrate:deploy`. |

---

## 6. GO / NO-GO recommendation

### **CONDITIONAL GO** — to create and apply the initial migration

The schema has no defects, the target is empty and correctly isolated, the shadow database is ready, and the CLI is authenticated as the migrator. Creating `init` is safe.

### **NO-GO** — to declaring Phase 1 complete

Phase 1 cannot be signed off while `aivideo_web` holds only `SELECT`: project creation and upload both require `INSERT` and will fail with an access-denied error the UI will report as a generic database failure.

### Required order (not executed in this audit)

1. Administrator grants `SELECT, INSERT` on `aivideo.projects` and `aivideo.assets` to `aivideo_web`.
2. `npm run db:migrate:dev -- --name init` → creates `prisma/migrations/<timestamp>_init` (also regenerates the client).
3. `npm run db:migrate:status` → expect "Database schema is up to date".
4. `cd media-service && .venv/bin/pytest -q` → the 5 skipped parity tests must now pass against real `information_schema`.
5. `npm run verify:db-access` → needs `DELETE ON aivideo.projects` as well; proves the write boundary.
6. Exercise create-project and upload over HTTP; confirm rows and files, then re-check the boundary.

---

## 7. Verification log for this audit

| # | Command | Result |
| --- | --- | --- |
| 1 | `git check-ignore -q` × 5 secret paths + arbitrary `*.kate-swp` | all IGNORED (exit 0) |
| 2 | `git status --short` | no secret file listed; only `.gitignore`, this doc, and pre-existing Phase 1 work |
| 3 | `npx tsx` printing resolved Prisma datasource | user `aivideo_migrator`, db `aivideo` / `aivideo_shadow`, password never printed |
| 4 | `information_schema` queries as migrator | 0 tables / 0 views / 0 triggers / 0 routines in both schemas; both `utf8mb4` |
| 5 | `ls -A prisma/migrations` | 0 entries |
| 6 | `npx prisma migrate status` | exit 1, "No migration found… not managed by Prisma Migrate" (expected) |
| 7 | Schema/app/SQLAlchemy cross-read | no defect; no edit made |

No migration, DDL, DML, grant change, application change, deployment, or commit occurred. `prisma/migrations/` remains empty and both schemas remain table-free.
