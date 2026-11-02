# SYSTEM ARCHITECTURE — recommended design (v0.2, for approval)

This document proposes the architecture for the AI video editor. It is a **proposal**: every deviation from the brief's initial technology direction is collected in §11 and requires explicit approval. Nothing here is implemented yet.

**v0.2 (2026-11-02):** the database decision changed. **MySQL (MariaDB 11.8.8, one shared instance)** replaces SQLite/PostgreSQL as the only application database. See §7 for the audited environment, ownership boundaries, pooling, migrations, and the MySQL-backed queue.

---

## 1. Design principles

1. **The agent plans; the worker executes.** The LLM never touches the filesystem, never builds a command line, and never reports success. Only the worker's structured result can mark an operation as done.
2. **Everything is a real file on disk.** No simulated editing, no decorative timeline. Every operation produces an artifact that can be probed and played.
3. **One job at a time.** The host has ~1.3 GB free RAM. Determinism and reliability beat throughput.
4. **Non-destructive by default.** Source uploads are immutable. All editing happens on derived assets listed in a plan.
5. **CPU-only, no GPU assumptions.** All code paths must work with software encoding.
6. **Reasonable to run on one machine, ready to split later.** Component boundaries are process boundaries (HTTP, not function calls), so the worker can move to another host without rewriting the agent.

---

## 2. Process topology

```
┌──────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                              │
│  Dashboard · Projects · Editor (preview + timeline + chat)           │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ HTTP + SSE (progress, chat tokens)
┌───────────────────────────────▼──────────────────────────────────────┐
│ WEB APP — Next.js (App Router, TypeScript)                           │
│  · UI + server actions                                               │
│  · Project/asset CRUD, upload handling                               │
│  · Proxies agent + job APIs (keeps provider keys server-side)        │
└───────┬───────────────────────────────────────┬──────────────────────┘
        │ HTTP (internal)                       │ HTTP (internal)
┌───────▼──────────────────────────┐   ┌────────▼──────────────────────┐
│ AI AGENT SERVICE — FastAPI       │   │ MEDIA API — FastAPI           │
│  · Instruction parsing           │   │  · Job submission             │
│  · Context assembly              │   │  · Job status/logs            │
│  · Plan generation (LLM)         │   │  · Artifact serving           │
│  · Tool registry + validation    │   │  · Streaming (Range) reads    │
│  · Execution orchestration       │   └────────┬──────────────────────┘
└───────┬──────────────────────────┘            │
        │ enqueue validated tool calls          │
┌───────▼───────────────────────────────────────▼──────────────────────┐
│ WORKER — Python process (single concurrency)                         │
│  FFprobe · PyAV (decode + libx264/libx265) · FFmpeg filters          │
│  faster-whisper · silence/scene detection · subtitle render          │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│ STORAGE — filesystem behind an interface (S3/R2-compatible later)    │
│  data/projects/<id>/source | derived | transcript | renders | export │
└──────────────────────────────────────────────────────────────────────┘
```

For Phases 1–3 the agent service and media API can run as **one FastAPI process** with two routers; they are separated above because the boundary is the important part, not the process count.

Both services also share **one MySQL database** (`aivideo`, MariaDB 11.8.8) for all persistent state — projects, upload records, jobs, job states, and execution logs. It is omitted from the diagram for clarity; ownership rules and access boundaries are in §7.1. Media files themselves are never stored in the database (§8).

---

## 3. Technology decisions

| Layer | Decision | Rationale |
| --- | --- | --- |
| Frontend | Next.js (App Router) + TypeScript + Tailwind + shadcn/ui | As specified in the brief |
| Styling/theming | Dark editor workspace, single accent | The brief forbids generic dashboard aesthetics |
| Web API | Next.js route handlers for CRUD/upload; FastAPI for media + agent | Media work must not live in Node |
| Python service | FastAPI + uvicorn, Pydantic v2 schemas | Typed contracts, OpenAPI for free |
| Transcription | faster-whisper (existing `.venv312`) | Already working on this exact machine |
| Decode/encode | **PyAV 14 (bundled FFmpeg 7 + libx264/libx265)** | System FFmpeg cannot encode H.264 at all (audit §3) |
| Media analysis | **System FFmpeg/FFprobe filters** (`silencedetect`, `scdet`, `loudnorm`, `ebur128`) | Already installed, no re-encoding needed, parse stderr/JSON |
| Subtitle burn-in | **Pillow frame overlay in PyAV** (default); libass via system FFmpeg (fallback) | PyAV bundle lacks libass; overlay keeps one encode path and removes filter-graph injection risk. See §4.3 |
| Database | **MySQL (MariaDB 11.8.8), one shared database** for both Next.js and FastAPI; no SQLite, no PostgreSQL anywhere | Mandated; server already running on this host. Audited in §7.0 |
| Jobs | **MySQL-backed durable queue** (`FOR UPDATE SKIP LOCKED` + `GET_LOCK`) with strict single-worker execution; polling API + SSE | One fewer process than a Redis broker, same guarantees at this scale (§7.5) |
| ORM & schema owner | **Prisma ORM 7.10.1 + Prisma Migrate** (Next.js side). FastAPI reads/writes the same schema through **SQLAlchemy 2.x**, never migrating | Mandated. Prisma is the single owner of schema and migrations — no custom runner, no Alembic, no `db push` (§7.4, §7.7, §7.8) |
| LLM | **Gemini API (hosted)**, provider interface so Ollama/local can be added | Network verified reachable; no local models exist; 7 GB RAM |
| Auth | Deferred to Phase 7 (local single-user mode before that) | Brief sequences auth last |

---

## 4. The rendering strategy (the critical decision)

### 4.1 The problem

Fedora's `ffmpeg-free` is built with H.264/HEVC decoders compiled out and **no libx264/libx265 encoders**. It cannot produce a good H.264 export. Verified:

```
$ ffmpeg -i sample.mp4 -c:v libx264 ...
Unknown encoder 'libx264'
```

PyAV in the existing virtualenv, in contrast, reports `libx264` and `libx265` encoders and native `h264`/`hevc` decoders, because its manylinux wheels bundle a full FFmpeg 7 built with those libraries.

### 4.2 Options considered

| Option | Verdict |
| --- | --- |
| A. Enable RPM Fusion, install full `ffmpeg` with libx264 | Cleanest conceptually, but a **system-level change** requiring approval; adds a third-party repo to the host |
| B. Use system FFmpeg with `libopenh264` everywhere | Works (measured 1.24x realtime) but ~2x slower, lower quality, and no HEVC. Fallback only |
| C. **Hybrid: PyAV for decode/encode, system FFmpeg for analysis filters** | **Recommended.** No installs, no system changes, best measured speed |
| D. Build FFmpeg from source | Wasteful on 4 cores; long-term maintenance burden |

### 4.3 Recommended hybrid, concretely

| Task | Tool | Why |
| --- | --- | --- |
| Metadata | `ffprobe -print_format json` | Installed, authoritative, no decoding |
| Audio extraction (16 kHz mono WAV) | PyAV or `ffmpeg` (`aac` decode is available) | Either works; PyAV keeps one dependency |
| Silence detection | `ffmpeg -af silencedetect` (parse stderr) or `ebur128` | No encoding involved; filter exists |
| Scene detection | `ffmpeg -vf scdet` / `select='gt(scene,x)'` (parse stderr) | Same |
| Loudness normalization | `ffmpeg -af loudnorm` (two-pass with JSON measurement) | Same |
| Trim / concat / crop / scale / fps | PyAV frame-level, or FFmpeg with `libopenh264` | PyAV for exports, FFmpeg for probes |
| Vertical reframe | PyAV crop+scale (measured 2.5x realtime) | Verified |
| Subtitle burn-in | **Pillow text overlay onto PyAV frames** | Avoids libass dependency and filter-string injection |
| Export | PyAV → `libx264` + `aac` | Verified working |
| Preview | PyAV → `libx264`, 720p or lower, `crf 30` | Seconds per iteration |

**If the user later approves RPM Fusion (option A)**, subtitle burn-in and export can collapse into a single `ffmpeg` invocation. The architecture must not depend on this — it is an optimization, not a requirement.

### 4.4 Aspect-ratio math (must be exact)

1920x1080 → 9:16 full-height crop ⇒ width = `round(1080 * 9 / 16) = 608` (even, required by yuv420p). Horizontal offset = `(1920 - 608) / 2 = 656`. Verified in the measured benchmark.

The worker must compute crop rectangles from a **subject-aware** strategy later (Phase 5), but Phase 3 only needs center crop. All dimensions must be forced even, and all offsets integers, or `libx264` will reject the frame.

---

## 5. Job model

### 5.1 State machine

```
queued ──► running ──► succeeded
   │          │
   │          ├──► failed ──► queued (retry, attempt < max)
   │          └──► canceled
   └──► canceled
```

Rules:
- `attempt` counter, `max_attempts` default 3, exponential backoff.
- **Idempotency key** = hash of `(tool_name, validated_inputs, input_asset_hashes)`. A duplicate submission returns the existing job instead of re-running it (brief: "avoid duplicate job execution").
- A job is marked `succeeded` **only after** the output artifact has been probed and validated (duration > 0, expected stream types, decodable).
- `progress_percent` and a human-readable `stage` are written to the DB so any client can poll; SSE streams them.
- Every tool invocation writes an immutable `tool_calls` row: inputs, sanitized command/parameters, stdout/stderr excerpt, duration, exit status, output artifact.

### 5.2 Concurrency

- One worker process, one job at a time (semaphore of 1), FIFO with priority for interactive requests.
- The single-worker rule is enforced server-side with `GET_LOCK('aivideo_worker', 0)` in MySQL, not merely by an in-process semaphore — a second worker process exits immediately. See §7.5.
- Transcription and rendering never overlap.
- CTranslate2 `cpu_threads=3`; PyAV/x264 threads ≤ 4.

### 5.3 Crash recovery

On worker start: any job left in `running` is marked `failed` with reason `worker_restart` and requeued if attempts remain. Intermediates for that job are deleted.

---

## 6. AI agent design

### 6.1 Flow

```
user message
   │
   ├─► context assembly (project metadata, transcript summary, current plan,
   │   last job results, available tools)  ── deterministic, size-capped
   │
   ├─► LLM turn (structured output / function calling)
   │
   ├─► if clarification needed → ask user, stop
   ├─► if plan proposed → validate against EditingPlan schema → store as DRAFT
   │       └─► require explicit user approval before execution (brief §7 Phase 4)
   └─► if tool call requested → validate → enqueue job → wait for worker result
           └─► agent reports ONLY what the worker returned
```

### 6.2 Tool registry contract

Every tool is a Python class/function registered with a Pydantic input model. No dynamic code, no shell strings.

```python
class ToolSpec(BaseModel):
    name: str                      # snake_case, e.g. "trim_clip"
    description: str               # shown to the LLM
    input_model: type[BaseModel]   # Pydantic v2
    output_model: type[BaseModel]
    cost_class: Literal["cheap", "expensive", "destructive"]
    timeout_seconds: int
    requires_approval: bool
```

Mandatory behaviours for every tool:
- Validate inputs against the Pydantic model; reject unknown fields (`extra="forbid"`).
- Resolve every path through the storage layer; reject absolute paths, `..`, and symlinks escaping `data/projects/<id>/`.
- Build FFmpeg invocations as **argument arrays** (`subprocess.run([...], shell=False)`), never strings.
- Never interpolate user text into a filter graph.
- Return `{ok, artifact, probe, metrics, warnings}` or a typed error; never raise raw exceptions to the agent.
- Write a `tool_calls` audit row.
- Declare `cost_class`; `expensive` and `destructive` tools require plan approval before execution.

### 6.3 v0.1 tool set

| Tool | Group | Cost | Phase |
| --- | --- | --- | --- |
| `inspect_video` | analysis | cheap | 1/3 |
| `extract_audio` | analysis | cheap | 2 |
| `transcribe_audio` | analysis | expensive | 2 |
| `detect_silence` | analysis | cheap | 3 |
| `detect_scenes` | analysis | cheap | 3 |
| `analyze_transcript` | analysis | cheap | 4 |
| `identify_highlights` | analysis | expensive (LLM) | 5 |
| `create_editing_plan` | planning | cheap | 4 |
| `trim_clip` | render | expensive | 3 |
| `concatenate_clips` | render | expensive | 3 |
| `crop_video` / `convert_aspect_ratio` | render | expensive | 3 |
| `normalize_audio` | render | expensive | 3 |
| `generate_subtitles` (SRT/VTT + burn-in) | render | expensive | 2/3 |
| `render_preview` | render | expensive | 3 |
| `export_video` | render | expensive/destructive-ish | 7 |

Deliberately **excluded**: any `run_ffmpeg_command`, `execute_shell`, or `run_python` tool. There is no general-purpose escape hatch, by design.

### 6.4 Editing plan schema (v0.1)

```json
{
  "schema_version": "0.1",
  "project_id": "8f3c...",
  "intent": "60s Instagram Reel, Indonesian subtitles, 9:16",
  "output": {
    "format": "mp4",
    "video_codec": "h264",
    "aspect_ratio": "9:16",
    "resolution": [608, 1080],
    "fps": 30,
    "target_duration_seconds": 60,
    "crf": 23
  },
  "timeline": [
    { "id": "c1", "source_asset": "src.mp4", "start": 12.5, "end": 24.8, "transition_in": null },
    { "id": "c2", "source_asset": "src.mp4", "start": 41.0, "end": 55.2, "transition_in": "cut" }
  ],
  "audio": { "normalize": true, "target_lufs": -14, "remove_silence": true },
  "subtitles": { "language": "id", "mode": "burn_in", "style": "reel_center", "max_chars_per_line": 32 },
  "constraints": { "total_duration_max": 60, "reject_if_longer": true }
}
```

Validation rules (Pydantic + cross-checks):
- `sum(end - start)` must equal `target_duration_seconds` within tolerance, or the plan is rejected with a specific error.
- Every `start < end`, both within the probed duration of `source_asset`.
- `aspect_ratio` ∈ {9:16, 16:9, 1:1, 4:5}; resolution must be even and consistent with the ratio.
- `timeline` non-empty; no overlapping ranges within one source.
- Unknown operation `type`s and unknown fields are hard errors (no silent dropping).
- Plans are versioned and stored; a revision creates a new version rather than mutating history.

---

## 7. Database — MySQL (single shared instance)

### 7.0 Audited environment (2026-11-02)

| Item | Finding |
| --- | --- |
| Server | **MariaDB 11.8.8** (`mariadb-server-11.8.8-3.fc44`) providing the MySQL wire protocol and the `mysql`/`mysqld` binaries |
| Oracle MySQL | **Not installed**, and `community-mysql-server` is not available in the enabled DNF repos |
| Service | `mariadb.service` active and enabled (`mysqld.service` is an alias); listening on `0.0.0.0:3306` |
| Socket | `/var/lib/mysql/mysql.sock` |
| Datadir | `/var/lib/mysql` (per `/etc/my.cnf.d/mariadb-server.cnf`) |
| Resident memory | ~14 MB at audit (idle) |
| Existing databases | `airprod_dev`, `airprod_test`, `ecommerce_iot`, `reksa`, `repiw`, `restaurant_app`, `solusi_sejalan`, `prisma_migrate_shadow_db` |
| Application credentials | **None exist.** `root@localhost` → `ERROR 1698` (unix_socket auth, needs OS root); `reksa@localhost` → `ERROR 1045 (using password: NO)` |
| Credentials in env or project | none |
| Other servers on the host | Docker `restaurant-mariadb` on **3307** (unrelated project); Akonadi private `mysqld` as user `reksa` on `/run/user/1000/akonadi/mysql.sock` (KDE PIM) |

Three database instances exist on this machine. **Only the system instance on port 3306 is ours.** The Docker container on 3307 and the Akonadi instance are out of scope and must never be contacted, read, or modified.

That instance is **shared with unrelated applications**, therefore:
- **No global server tuning** at MVP (buffer pool, `max_connections`, `performance_schema`). Changes affect other projects and require explicit approval.
- All DDL is confined to the `aivideo` database. No `DROP`/`ALTER`/`TRUNCATE` outside it.
- No `GRANT` beyond `aivideo.*`.

Required one-time provisioning (needs `sudo`, therefore explicit approval; the exact statements also appear in `docs/DEVELOPMENT-ROADMAP.md` Phase 1):

```sql
CREATE DATABASE aivideo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- Prisma Migrate shadow database (development only; never touched by the app)
CREATE DATABASE aivideo_shadow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'aivideo_migrator'@'localhost' IDENTIFIED BY '<generated>';
CREATE USER 'aivideo_web'@'localhost'      IDENTIFIED BY '<generated>';
CREATE USER 'aivideo_media'@'localhost'    IDENTIFIED BY '<generated>';
GRANT ALL PRIVILEGES ON aivideo.*        TO 'aivideo_migrator'@'localhost';
GRANT ALL PRIVILEGES ON aivideo_shadow.* TO 'aivideo_migrator'@'localhost';
```

With a dedicated shadow database configured, the migrator needs **no global `*.*` privilege and no wildcard database pattern** — it physically cannot reach `airprod_dev`, `restaurant_app`, or any other project's schema. See §7.4.1.

### 7.1 Ownership and access boundaries

One database, one schema, **one writer per table**. The other service gets read access only.

| Table | Writer | Readers | Notes |
| --- | --- | --- | --- |
| `projects` | **web (Next.js)** | web, media | media reads metadata for context assembly |
| `assets` | **web (Next.js)** | web, media | inserted on upload completion; media reads paths |
| `jobs` | **media (FastAPI)** | web, media | web enqueues by calling the media API, never by writing |
| `job_attempts` | media | media | one row per execution attempt |
| `tool_calls` | media | web (display), media | immutable audit log |
| `transcripts` | media | web, media | |
| `plans` | media | web, media | approval is a media API call, so there is a single writer |
| `agent_messages` | media | web, media | |
| `exports` | media | web, media | |
| `worker_leases` | media | media | single-worker enforcement and heartbeats |
| `_prisma_migrations` | **Prisma Migrate** (migrator) | migrator | created and written only by Prisma Migrate; application code never touches it |

Grants follow that table. Example for the web user:

```sql
GRANT SELECT ON aivideo.* TO 'aivideo_web'@'localhost';
GRANT INSERT, UPDATE, DELETE ON aivideo.projects TO 'aivideo_web'@'localhost';
GRANT INSERT, UPDATE, DELETE ON aivideo.assets   TO 'aivideo_web'@'localhost';
```

This is how requirement 4 is enforced in practice: if the Next.js layer ever tried to write `jobs`, MySQL would reject it. The boundary is a privilege, not a convention in code. Service code still goes through repository classes (`ProjectRepository`, `JobRepository`) for testability — the grants are the backstop.

#### Which credential each process holds

| Process | MySQL user | URL variable | Can do |
| --- | --- | --- | --- |
| Prisma CLI (`migrate dev/deploy/status`, `studio`) | `aivideo_migrator` | `DATABASE_URL` (+ `SHADOW_DATABASE_URL`) | Full DDL + DML **inside `aivideo`** and DDL inside `aivideo_shadow` only |
| Next.js runtime (Prisma Client) | `aivideo_web` | `WEB_DATABASE_URL` | SELECT all; write only `projects`, `assets` |
| FastAPI + worker (SQLAlchemy) | `aivideo_media` | `MEDIA_DATABASE_URL` | SELECT all; write only media-owned tables |

The application never loads migrator credentials. `DATABASE_URL` is used only by CLI commands run from a developer shell or a deployment step, so a compromised request handler cannot alter the schema.

### 7.2 Connection pooling (conservative, sized for ~1.2 GB free RAM)

Prisma ORM v7 uses **driver adapters** by default for relational databases, so pooling is controlled by the Node driver, not by a Prisma URL parameter. The `mariadb` adapter's documented defaults are `connectionLimit: 10`, `connectTimeout: 1s`, `acquireTimeout: 10s`, `idleTimeout: 1800s` — all wrong for this machine, and all overridden:

| Service | Driver | Pool settings |
| --- | --- | --- |
| Next.js (Prisma Client) | `@prisma/adapter-mariadb` (`PrismaMariaDb`) | `connectionLimit: 5`, `connectTimeout: 5000`, `acquireTimeout: 10000`, `idleTimeout: 300` |
| FastAPI | SQLAlchemy 2.x + `PyMySQL` | `pool_size: 3`, `max_overflow: 2`, `pool_recycle: 1800`, `pool_pre_ping: true` |
| Worker | same engine as FastAPI | shares that process pool; no second pool |
| Prisma CLI / Studio | `aivideo_migrator` | short-lived; never run during a render |

**Hard ceiling: 10 concurrent connections** across the application. `connectTimeout` is raised from the v7 default of 1 s to 5 s because a 4-core box under a render will otherwise drop connections; `idleTimeout` is cut from 1800 s to 300 s so idle sockets release memory between jobs. Do not raise these numbers without a measurement.

Next.js must hold **one** `PrismaClient` per process behind a `globalThis` singleton, or dev-mode hot reload accumulates pools until MySQL refuses connections.

### 7.3 Schema

InnoDB engine, `utf8mb4_unicode_ci`, `DATETIME(3)` timestamps, 26-char ULID primary keys as `CHAR(26)`. Every table has `created_at`; mutable tables have `updated_at ... ON UPDATE CURRENT_TIMESTAMP(3)`.

| Table | Key columns |
| --- | --- |
| `projects` | `id` PK, `name` VARCHAR(200), `status` ENUM('active','archived'), `settings` JSON |
| `assets` | `id` PK, `project_id` FK, `kind` ENUM('source','derived','preview','export','audio','subtitle'), `rel_path` VARCHAR(500), `sha256` CHAR(64), `bytes` BIGINT, `duration_s` DECIMAL(10,3), `probe` JSON |
| `jobs` | `id` PK, `project_id` FK, `tool_name` VARCHAR(64), `input` JSON, `idempotency_key` CHAR(64) **UNIQUE**, `status` ENUM('queued','running','succeeded','failed','canceled'), `attempt` TINYINT, `max_attempts` TINYINT, `progress` TINYINT UNSIGNED, `stage` VARCHAR(64), `error_code` VARCHAR(64), `error_detail` TEXT, `next_run_at` DATETIME(3), `started_at`, `finished_at`; INDEX (`status`,`next_run_at`), INDEX (`project_id`,`created_at`) |
| `job_attempts` | `id` PK, `job_id` FK, `attempt` TINYINT, `exit_status` INT, `duration_ms` INT, `log_excerpt` TEXT, `created_at` |
| `tool_calls` | `id` PK, `job_id` FK NULL, `project_id` FK, `tool_name`, `input` JSON, `output` JSON, `ok` BOOLEAN, `duration_ms`, `created_at`; INDEX (`project_id`,`created_at`) |
| `transcripts` | `id` PK, `project_id` FK, `asset_id` FK, `language` CHAR(5), `model` VARCHAR(32), `srt_rel_path`, `vtt_rel_path`, `segments` JSON, `created_at` |
| `plans` | `id` PK, `project_id` FK, `version` INT, `status` ENUM('draft','approved','executed','superseded'), `plan` JSON, `approved_at`; UNIQUE (`project_id`,`version`) |
| `agent_messages` | `id` PK, `project_id` FK, `role` ENUM('user','assistant','tool'), `content` MEDIUMTEXT, `tool_call_id` NULL, `created_at` |
| `exports` | `id` PK, `project_id` FK, `plan_id` FK, `preset` VARCHAR(32), `asset_id` FK, `status`, `created_at` |
| `worker_leases` | `worker_id` VARCHAR(64) PK, `job_id` NULL, `leased_until` DATETIME(3), `heartbeat_at` DATETIME(3) |
| `_prisma_migrations` | managed entirely by Prisma Migrate (id, checksum, applied_steps_count, logs). Never written by application code |

`prisma/schema.prisma` is the **single source of truth** for this schema; the table above is a human-readable summary of what it produces. MariaDB implements `JSON` as `LONGTEXT` with a `json_valid()` check — the semantics we depend on are unchanged. **Media files are never stored in the database** — only keys, paths, and probe metadata (§8).

Defaults produced by Prisma that must be overridden explicitly in the schema, because the defaults are wrong for this data:

| Prisma field | Default MySQL type | Required here |
| --- | --- | --- |
| `String` (ids) | `VARCHAR(191)` | `@db.Char(26)` |
| `String` (paths) | `VARCHAR(191)` | `@db.VarChar(500)` — 191 truncates real paths |
| `Decimal` (durations) | `DECIMAL(65,30)` | `@db.Decimal(10,3)` |
| `DateTime` | `DATETIME(3)` | correct as-is |

### 7.4 Migrations — Prisma Migrate only

Prisma Migrate is the **sole owner** of the schema and the migration history. The previously proposed custom SQL runner is withdrawn. There is no Alembic, no hand-rolled `db/migrations/*.sql` directory, and no `Base.metadata.create_all()` anywhere in this project.

| Rule | Detail |
| --- | --- |
| Authoring | Edit `prisma/schema.prisma`, then `npm run db:migrate:dev -- --name <snake_case_name>` |
| Output | `prisma/migrations/<timestamp>_<name>/migration.sql` — generated SQL, reviewed and committed |
| History | `_prisma_migrations` table with checksums; Prisma detects edited or deleted migration files |
| Apply (dev) | `prisma migrate dev` — uses the shadow database (§7.4.1) |
| Apply (prod) | `prisma migrate deploy` — no shadow database, never destructive |
| Status | `prisma migrate status` |
| Forbidden | `prisma migrate reset` against `aivideo`; `prisma db push` as a substitute for migrations |
| Generate | v7 no longer runs `prisma generate` inside `migrate dev` — `db:migrate:dev` chains it explicitly |

**Development workflow**

```
1. Edit prisma/schema.prisma
2. npm run db:migrate:dev -- --name add_job_queue
3. Review prisma/migrations/<timestamp>_add_job_queue/migration.sql
4. Run tests        (client is regenerated by the chained db:generate)
5. Commit prisma/schema.prisma + prisma/migrations/
```

**Production workflow**

```
1. Back up:      mariadb-dump aivideo > backup-<date>.sql
2. Check state:  npm run db:migrate:status
3. Apply:        npm run db:migrate:deploy
4. Health check: services boot, /api/health green
5. Verify application behaviour against the new schema
```

Prisma is forward-only in practice: MariaDB DDL autocommits, so a failed migration cannot be rolled back by transaction. Fix forward with a new migration.

#### 7.4.1 Shadow database (development only)

`prisma migrate dev` needs a second database to detect drift and to test migrations before applying them. It is **not** used by `migrate deploy` and is not needed in production.

| Option | Grant required | Assessment |
| --- | --- | --- |
| **A. Dedicated shadow DB (chosen)** | `ALL PRIVILEGES ON aivideo_shadow.*` | Deterministic and auditable. No `CREATE DATABASE`, no global or wildcard grant. Set `SHADOW_DATABASE_URL` |
| B. Prisma-created shadow DBs | `CREATE, ALTER, DROP, INDEX, REFERENCES ON \`prisma_migrate_shadow_db%\`.*` | Prisma creates `prisma_migrate_shadow_db_<id>`. MariaDB supports wildcard DB names (MySQL 8.0.35+ does not when `partial_revokes` is on) |

Option A is the decision: `SHADOW_DATABASE_URL` points at `aivideo_shadow`, granted to `aivideo_migrator` only. `INDEX` is called out in Prisma's docs because generated migrations emit standalone `CREATE INDEX` / `DROP INDEX` statements, which `CREATE` and `ALTER` alone do not permit — option A's `ALL PRIVILEGES` covers it. The shadow database is never connected to by the application.

### 7.5 Durable queue with strict single-worker execution

- **Single worker, enforced server-side:** the worker takes `SELECT GET_LOCK('aivideo_worker', 0)`. A return of 0 means another worker holds it and this process exits immediately.
- **Claiming:** inside a transaction, `SELECT id FROM jobs WHERE status='queued' AND next_run_at <= NOW(3) ORDER BY next_run_at LIMIT 1 FOR UPDATE SKIP LOCKED`, then `UPDATE ... SET status='running', attempt=attempt+1, started_at=NOW(3)`, then commit. `SKIP LOCKED` (MariaDB 10.6+) keeps a second claimer safe even if the advisory lock were bypassed.
- **Heartbeat:** the running worker updates `worker_leases.heartbeat_at` and `leased_until` every 10 s; an expired lease marks the job as interrupted.
- **Interrupted jobs:** on startup the worker sets `running` jobs with expired leases to `failed` with `error_code='WORKER_RESTART'`, increments `attempt`, requeues if `attempt < max_attempts`, and deletes that job's intermediates first.
- **No duplicate execution:** `jobs.idempotency_key` is UNIQUE over `(tool_name, validated inputs, input asset hashes)`. A duplicate submission returns the existing job id rather than inserting a second row.
- The UI polls `jobs` by id; SSE is derived from the same rows. No broker, no Redis.

### 7.6 Transactions

Kept short, never held across a render:

| Operation | Transaction |
| --- | --- |
| Job claim | `FOR UPDATE SKIP LOCKED` + `UPDATE` + `COMMIT` |
| Upload completion | insert `assets` row + update `projects.updated_at` together |
| Plan approval | `SELECT ... FOR UPDATE` on the `plans` row, bump status/version, commit |
| Job completion | `jobs` status + `job_attempts` row together, artifacts probed **before** commit |

Isolation: `READ COMMITTED` for normal work (avoids gap-lock contention on the queue), default `REPEATABLE READ` only where needed.

### 7.7 Prisma + Next.js integration

**Version: Prisma ORM 7.10.1**, pinned exactly (`prisma` and `@prisma/client` must match).

```
prisma          7.10.1     devDependency (CLI: generate, migrate, studio)
@prisma/client  7.10.1     dependency
@prisma/adapter-mariadb ^7.10.1  driver adapter (uses the `mariadb` Node driver)
dotenv          latest     required: v7 does not load .env automatically
```

Numeric verification of the choice:

| Check | Result |
| --- | --- |
| `npm view prisma dist-tags` | `latest: 8.0.0-rc.29` (**release candidate**, not stable), `prev: 7.10.1` |
| `npm view @prisma/client dist-tags` | `latest: 7.10.1` |
| Stable 7.x line | 7.8.0 → 7.9.1 → 7.10.1 |
| Node engines (`prisma@7.10.1`) | `^20.19 \|\| ^22.12 \|\| >=24.0` → **Node 24.21.0 satisfies this** |
| TypeScript peer | `>=5.4.0` |
| MariaDB support | `provider = "mysql"` supports self-hosted MariaDB 10.0+ with full Migrate support → **11.8.8 supported** |

Because `latest` resolves to a v8 release candidate, **never** run bare `npm install prisma`. Install with explicit versions.

**File layout**

```
prisma/schema.prisma            models (single source of truth)
prisma/migrations/              generated SQL history, committed
prisma.config.ts                v7 config: schema path, migrations path, URLs
src/generated/prisma/           generated client (gitignored, built in CI)
src/lib/prisma.ts               globalThis singleton
```

**`prisma.config.ts`** (required in v7 — `datasource.url` in `schema.prisma` is no longer supported):

```ts
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    // migrator credentials — used by the CLI only
    url: process.env.DATABASE_URL ?? "",
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL ?? "",
  },
});
```

`process.env` is used rather than the `env()` helper on purpose: the helper throws when a variable is missing, which would break `prisma generate` in CI or during a production build where no database URL is present.

**`prisma/schema.prisma`** (v7 rules: `prisma-client` generator, `output` mandatory, no `url` in the datasource):

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "mysql"
}
```

**Client singleton** (`src/lib/prisma.ts`) — one pool per process, survives hot reload:

```ts
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";

const adapter = new PrismaMariaDb({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME ?? "aivideo",
  connectionLimit: 5,      // v7 default is 10 — too many for this host
  connectTimeout: 5000,    // v7 default is 1000
  idleTimeout: 300,        // v7 default is 1800 (seconds)
});

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```

**npm scripts**

```json
{
  "db:generate": "prisma generate",
  "db:migrate:dev": "prisma migrate dev && prisma generate",
  "db:migrate:deploy": "prisma migrate deploy",
  "db:migrate:status": "prisma migrate status",
  "db:studio": "prisma studio"
}
```

`db:migrate:dev` chains `prisma generate` because v7 removed automatic generation. `next build` must run `prisma generate` first, since the client lives outside `node_modules` and is gitignored.

**ESM requirement:** Prisma 7 ships as ESM. `package.json` needs `"type": "module"`, and `tsconfig.json` needs `module: "ESNext"`, `moduleResolution: "bundler"`, `target: "ES2023"`, `strict: true`, `esModuleInterop: true`. This constrains the Next.js scaffold and any CommonJS tooling in Phase 1.

### 7.8 SQLAlchemy ↔ Prisma schema mapping

FastAPI uses SQLAlchemy 2.x for queries only. **Prohibited:** `Base.metadata.create_all()`, Alembic, or any automatic DDL from Python. Prisma owns the schema; SQLAlchemy describes it.

| Prisma | SQLAlchemy 2.x | Rule |
| --- | --- | --- |
| `model Project` + `@@map("projects")` | `class Project(Base): __tablename__ = "projects"` | Names must match exactly, in snake_case |
| `String @db.Char(26)` (id) | `String(26)` mapped to `CHAR(26)` | Ids are app-generated ULIDs in **both** services |
| `String @db.VarChar(500)` | `String(500)` | Never rely on the 191 default |
| `Json` | `mysql.JSON` | MariaDB stores it as LONGTEXT + `json_valid()` |
| `Boolean` | `Boolean` → `TINYINT(1)` | Prisma-consistent |
| `DateTime @db.DateTime(3)` | `mysql.DATETIME(fsp=3)` | Millisecond precision on both sides |
| `Decimal @db.Decimal(10,3)` | `Numeric(10, 3)` | Durations in seconds |
| `enum` | `Enum(..., native_enum=True)` | Native MariaDB ENUM, same member names |

Two traps that would silently break parity:

1. **`@updatedAt` is applied by Prisma Client, not by MySQL.** A row written by SQLAlchemy would leave `updated_at` stale. Every SQLAlchemy model that maps a table with `updated_at` must set it explicitly (`onupdate=func.current_timestamp(3)`); no database triggers are used, because a trigger would not appear in `schema.prisma` and would show up as schema drift.
2. **Default `String` → `VARCHAR(191)`** truncates real file paths. Long-text columns must declare their length in `schema.prisma`.

Parity is verified by a test, not by trust: a pytest reads `information_schema.columns` for `aivideo` and asserts that every table, column, and type matches the SQLAlchemy models. A mismatch fails CI.

---

## 8. Storage abstraction

```python
class BlobStore(Protocol):
    def put(self, key: str, fileobj, *, content_type: str) -> StoredObject: ...
    def get_path(self, key: str) -> Path:        # local fast path
    def open(self, key: str) -> BinaryIO:        # streaming
    def url_for(self, key: str, *, expires: int) -> str
    def delete(self, key: str) -> None
    def exists(self, key: str) -> bool
```

- `LocalBlobStore` for Phases 1–6: root `data/`, layout `projects/<id>/<kind>/<asset_id>.<ext>`.
- `S3BlobStore` (R2-compatible) added later without touching call sites.
- Keys are generated server-side; user-supplied filenames are never used in paths (prevents traversal and injection in one move).
- Uploads stream to disk with a size cap; no in-memory buffering.

---

## 9. Security model

| Threat | Control |
| --- | --- |
| Path traversal | Server-generated keys; every resolved path must be inside the project root after `Path.resolve()`; symlink checks |
| Command injection | `shell=False` + argument arrays; no string concatenation into commands; enum-validated filter parameters |
| Filtergraph injection | User text never enters a filter string; subtitle styling uses fixed presets |
| LLM-driven abuse | No shell/exec tool exists; every tool input is schema-validated; path arguments excluded entirely (agent references assets by ID) |
| Secret exposure | Provider keys stay in the Python service env, never sent to the browser; `/api/*` proxies agent calls |
| Resource exhaustion | Upload size cap, duration cap, single-job concurrency, per-project disk quota |
| Malicious media | All processing sandboxed to `data/`; no auto-execution of anything from the file; FFprobe output treated as untrusted input |
| Prompt injection via transcript | Transcript text is passed to the model as **data**, and tool calls still pass through the registry — the worst case is a bad plan, not a bad command |

---

## 10. Observability

- Structured JSON logs per job with a `job_id` correlation key.
- Every FFmpeg/FFprobe invocation logged with its argument array, duration, and the last 100 lines of stderr.
- `/api/jobs/{id}/logs` streams the log ring buffer to the UI.
- Resource sampling (RSS, elapsed) recorded per job for the resource analysis to stay honest over time.
- Agent decisions logged: prompt hash, plan version, tool calls, worker confirmations.

---

## 11. Deviations from the brief's initial technology direction (require approval)

| # | Brief said | Proposed | Why | Reversible? |
| --- | --- | --- | --- | --- |
| D1 | PostgreSQL (this doc previously proposed SQLite) | **MySQL — MariaDB 11.8.8, one shared database for both services** | **Mandated by the user.** Server already runs on this host; no SQLite or PostgreSQL anywhere in the app | No — decided and locked |
| D2 | Redis + background job processing | **MySQL-backed durable queue**, strict single-worker; no broker process | Removes a process and its memory; `GET_LOCK` + `FOR UPDATE SKIP LOCKED` give the same guarantees at this scale | Yes — the queue sits behind an interface |
| D3 | FFmpeg as the main engine | **PyAV for encode/decode + FFmpeg for analysis filters** | System FFmpeg has no libx264/libx265 and no native H.264/HEVC decoder | Yes — collapses back if RPM Fusion is approved |
| D4 | Gemini or Ollama | **Gemini API** primary; Ollama optional/offline later | Ollama has zero models and 7 GB RAM cannot host a capable one | Yes |
| D5 | Next.js API or dedicated backend | **Both, split by concern** (Next.js for web CRUD, FastAPI for media/agent) | Keeps CPU-heavy work out of Node; matches the brief's allowance | Partially |
| D6 | User auth at Phase 7 | Confirm single-user local mode before Phase 7 | Sequencing is in the brief; flagged for confirmation | Yes |
| D7 | No ORM specified in the brief; this doc previously proposed a custom SQL runner | **Prisma ORM 7.10.1 + Prisma Migrate as sole schema/migration owner**; SQLAlchemy query-only in FastAPI | Mandated by the user; removes the custom runner entirely | No — decided |

**None of these change silently.** Each is listed here for the approval step.

---

## 12. Future scaling path (not MVP)

- Worker extraction: the worker already talks HTTP and reads/writes blobs by key, so moving it to a remote host is a config change.
- Multiple application instances, read replicas, or a separate cache once concurrency exceeds what one MySQL instance and one worker can serve. A broker (Redis) becomes justified only when more than one worker must consume jobs.
- S3/R2 + signed URLs when storage outgrows the disk.
- GPU/remote render farm when export load exceeds one machine.
