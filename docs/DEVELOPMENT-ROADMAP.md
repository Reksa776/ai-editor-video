# DEVELOPMENT ROADMAP

Phases from the project brief, translated into concrete scope with verifiable exit criteria. **One phase at a time. No phase starts without explicit approval.**

---

## Phase 0 — Audit and architecture (COMPLETE, awaiting approval)

Deliverables: `docs/PROJECT-AUDIT.md`, `docs/SYSTEM-ARCHITECTURE.md`, `docs/DEVELOPMENT-ROADMAP.md`, `docs/RESOURCE-ANALYSIS.md`, `docs/PHASE-0-REPORT.md`.

Audit-only. No code, dependency, database, environment, or system changes made.

---

## Phase 1 — Web application foundation

**Prerequisites:**

1. Approval of the remaining decisions D2–D6 in `SYSTEM-ARCHITECTURE.md §11`. D1 is closed: **MySQL is mandated** and no longer open for discussion.
2. **MySQL access provisioned by an administrator.** The server is already running (MariaDB 11.8.8 on port 3306), but no application credentials exist and `root@localhost` requires OS root via `unix_socket` auth. Provisioning is a one-time `sudo` step:

```sql
CREATE DATABASE aivideo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE aivideo_shadow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'aivideo_migrator'@'localhost' IDENTIFIED BY '<generated>';
CREATE USER 'aivideo_web'@'localhost'      IDENTIFIED BY '<generated>';
CREATE USER 'aivideo_media'@'localhost'    IDENTIFIED BY '<generated>';
GRANT ALL PRIVILEGES ON aivideo.*        TO 'aivideo_migrator'@'localhost';
GRANT ALL PRIVILEGES ON aivideo_shadow.* TO 'aivideo_migrator'@'localhost';
GRANT SELECT ON aivideo.* TO 'aivideo_web'@'localhost';
GRANT INSERT, UPDATE, DELETE ON aivideo.projects TO 'aivideo_web'@'localhost';
GRANT INSERT, UPDATE, DELETE ON aivideo.assets   TO 'aivideo_web'@'localhost';
GRANT SELECT ON aivideo.* TO 'aivideo_media'@'localhost';
```

`aivideo_shadow` exists only so `prisma migrate dev` has a shadow database (architecture §7.4.1); with it configured, the migrator needs no `*.*` or wildcard grant. `aivideo_media`'s write grants are added per media-owned table in the same migration that creates them. Credentials live in `.env.local` and the service environment only — never in git, never in migration SQL, never sent to the browser.

Scope:
1. `git init` + `.gitignore` (`node_modules`, `.venv*`, `data/`, `.env*`, `*.mp4`) — the repo currently has no version control.
2. Next.js + TypeScript + Tailwind + shadcn/ui scaffold; dark editor shell (sidebar, top bar, main canvas).
3. Prisma ORM **7.10.1** (pinned exactly — `latest` on npm is the 8.0 release candidate) with `prisma.config.ts`, `prisma/schema.prisma` (`prisma-client` generator + mandatory `output`), `prisma/migrations/`, the `globalThis` client singleton, and `@prisma/adapter-mariadb` with `connectionLimit: 5`. Initial migration via `npm run db:migrate:dev -- --name init`.
4. SQLAlchemy 2.x models mirroring the Prisma schema for FastAPI (query-only; **no** `create_all`, **no** Alembic), `pool_size: 3` + `max_overflow: 2`, plus the `information_schema` parity test.
5. Project CRUD: create, list, rename, archive, delete.
6. Video upload: streamed multipart, size/duration caps, sha256, `data/projects/<id>/source/…`.
7. `LocalBlobStore` + the `BlobStore` protocol.
8. FastAPI service skeleton with `inspect_video` (FFprobe → structured metadata) and a health endpoint.
9. Preview player reading the uploaded source with HTTP Range support.

Exit criteria (all must be demonstrated on the real `sample.mp4`):
- [ ] User can create a project that persists across restarts (verified by restarting both services).
- [ ] `npm run db:migrate:deploy` applies the initial migration cleanly to an empty `aivideo`; `db:migrate:status` then reports up to date.
- [ ] `npm run db:migrate:dev` succeeds using the **separate migrator account**, including shadow-database use against `aivideo_shadow`.
- [ ] Write-boundary test passes: a Next.js/Prisma write to `jobs` is rejected by MySQL, while a write to `projects` succeeds.
- [ ] SQLAlchemy↔Prisma parity test passes against `information_schema.columns` (tables, columns, types, nullability).
- [ ] `prisma generate` runs before `next build` and the generated client is not committed.
- [ ] User can upload a real video; a 42 MB file uploads without loading into RAM.
- [ ] Metadata (duration, resolution, fps, codecs) is fetched and displayed correctly.
- [ ] The uploaded video plays in the browser.
- [ ] A failed upload (unsupported/corrupt/too large) surfaces a specific, non-generic error.
- [ ] `next build` and `tsc --noEmit` pass.

Risks to watch: Next.js dev server memory (~350–600 MB) plus the MySQL working set (~150–250 MB) against ~1.3 GB available. If RAM proves unacceptable here, that is a `BLOCKED` condition to report — not a reason to swap the database.

---

## Phase 2 — Transcription engine

Scope:
1. Port the proven `transcribe.py` logic into a service module driven by arguments (no hardcoded paths, no CWD writes).
2. Extract audio to 16 kHz mono WAV under `data/projects/<id>/derived/`.
3. Transcribe via faster-whisper (`device="cpu"`, `compute_type="int8"`, `cpu_threads=3`, `vad_filter=True`, `language="id"`).
4. Generate **both** SRT and VTT from one segment list; correct millisecond rounding (the current script truncates).
5. Persist segments + timestamps; download endpoints for both formats.
6. Job integration: status, progress, retry, cancel; dedupe by idempotency key.
7. **Benchmark `tiny` vs `base`** on `sample.mp4`; record wall-clock, RSS, and an accuracy spot-check against the known-good transcript.

Exit criteria:
- [ ] Real uploaded video is transcribed end to end from the UI.
- [ ] SRT and VTT have valid, monotonic, correctly rounded timestamps and are downloadable.
- [ ] A forced failure (e.g. audio-less input) is reported clearly and can be retried successfully.
- [ ] Killing the worker mid-job leaves the job recoverable: it becomes `failed` with `WORKER_RESTART`, requeues exactly once, and never executes twice concurrently.
- [ ] Benchmark table for `tiny` and `base` committed to docs with measured numbers.
- [ ] The existing `.venv312` is unchanged, or any change is documented with justification.

Open question to resolve here: `word_timestamps` on/off (needed for Phase 5 highlight precision vs. runtime cost).

---

## Phase 3 — Video processing engine

Scope (all on real files; originals never mutated):
1. `trim_clip`, `concatenate_clips`, `crop_video` / `convert_aspect_ratio`, `normalize_audio`, `render_preview`, `export_video`.
2. `detect_silence` (FFmpeg `silencedetect` / `ebur128`) and `detect_scenes` (`scdet`) with structured output.
3. Subtitle burn-in via the chosen strategy (Pillow overlay on PyAV frames by default).
4. Output validation: probe every artifact before declaring success (duration > 0, expected streams, decodable).
5. Intermediate cleanup on success; orphan reaper.

Exit criteria:
- [ ] Each operation produces a playable artifact that FFprobe validates.
- [ ] A 1080p→9:16 export completes on `sample.mp4` in the expected ~40 s range.
- [ ] Failures log the full argument array and stderr excerpt; job status is `failed` with a specific reason.
- [ ] Source file hash is unchanged after every operation (prove non-destructiveness).
- [ ] Peak RSS per job recorded and within the documented budget.

Decision needed: subtitle burn-in via Pillow overlay (no installs) vs. RPM Fusion full FFmpeg (needs approval). Recommendation: Pillow.

---

## Phase 4 — AI agent foundation

Prerequisite: an LLM credential (Gemini key) or an approved local alternative.

Scope:
1. Agent chat UI (project-aware, streaming).
2. Context assembly: project metadata, transcript excerpt, current plan, recent job results, tool catalogue — with hard size caps.
3. Structured plan generation validated against the `EditingPlan` v0.1 schema.
4. Tool registry with Pydantic validation, path allowlisting, cost classes, audit rows.
5. Approval gate: `expensive`/`destructive` tools require explicit user confirmation before enqueueing.
6. Agent may only report results returned by the worker.

Exit criteria:
- [ ] "Edit this into a 60-second 9:16 Reel with Indonesian subtitles" yields a schema-valid plan with a timeline whose durations sum correctly.
- [ ] An invalid/oversized plan is rejected with a specific, actionable message.
- [ ] No approved tool can execute without passing validation; a malicious/malformed tool call is rejected and logged.
- [ ] Agent text never claims completion before the worker confirms.
- [ ] Every tool call leaves an audit row visible in the UI.

---

## Phase 5 — Automatic AI editing

Scope: highlight selection from transcript + audio energy + scene boundaries; silence removal; clip ordering to hit the target duration; subtitle generation with the chosen style; vertical reframing; automatic preview render; conversational revision ("shorter", "drop the intro", "bigger subtitles").

Exit criteria:
- [ ] One instruction produces a real rendered vertical MP4 with burned-in Indonesian subtitles.
- [ ] Result is previewable in the browser and downloadable.
- [ ] A revision request produces a new plan version and a new render, with the previous version still inspectable.
- [ ] Total wall-clock for the 94 s fixture stays within the documented budget on this hardware.

---

## Phase 6 — Manual video editor

Scope: timeline (video/audio/subtitle tracks), trim handles, clip reorder, subtitle text correction, preview scrubbing with synchronization, undo/redo over the plan document.

Exit criteria:
- [ ] Timeline edits change the plan JSON and the rendered output.
- [ ] Trim/reorder survive a page reload.
- [ ] Subtitle corrections appear in both the burned-in render and the exported SRT/VTT.
- [ ] Undo/redo restores both state and render.
- [ ] No decorative control: every visible control performs its advertised action.

---

## Phase 7 — Export and SaaS readiness

Scope: export presets, background job processing hardening, storage quotas and cleanup, project history, authentication, usage limits, credits architecture, error monitoring.

Not started without explicit approval, and no paid service is introduced without approval.

---

## Cross-cutting requirements (every phase)

- Unit tests for pure logic, integration tests at service boundaries, real-file tests for media paths.
- `tsc --noEmit` + `next build` for frontend changes.
- Status vocabulary in every report: PASS / FAIL / BLOCKED / NOT TESTED / CONDITIONAL GO.
- `docs/PHASE-X-REPORT.md` written at the end of each phase, ending with an approval request.
- Documentation updated in the same change as the code, not afterwards.

## Dependency introduction schedule

| Phase | Adds |
| --- | --- |
| 1 | `next`, `react`, `typescript` (≥5.4), `tailwindcss`, shadcn/ui deps; `prisma@7.10.1` (dev), `@prisma/client@7.10.1`, `@prisma/adapter-mariadb`, `dotenv`; Python: `fastapi`, `uvicorn`, `pydantic`, `httpx`, `SQLAlchemy`, `PyMySQL`, `pytest` |
| 2 | nothing new (faster-whisper already present) |
| 3 | `Pillow` (subtitle overlay) |
| 4 | LLM SDK for the approved provider |
| 5 | none expected |
| 6 | timeline UI library only if vetted and lightweight |
| 7 | auth + monitoring, only with approval |

SQLite and PostgreSQL are **never** used — MySQL is the only application database. **Prisma Migrate is the only migration system**: no custom SQL runner, no Alembic, no Sequelize/Drizzle/TypeORM. Redis, Docker, and RPM Fusion are **not** introduced at any current phase.
