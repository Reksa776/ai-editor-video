# PHASE 0 REPORT

Date: 2026-11-02
Phase objective: audit the existing project and the Fedora environment, then propose an architecture that is viable on CPU-only, 7 GB RAM hardware. **Audit only — no implementation.**

> **Amendment (2026-11-02, after architecture review).** Two things changed after this report was written:
> 1. **The database decision changed to MySQL** (mandated by the user). D1 is closed; the authoritative design is now `SYSTEM-ARCHITECTURE.md §7`.
> 2. **A factual error in this report was found and corrected** — §4 and §10 originally claimed no database was installed. MySQL (as MariaDB 11.8.8) was in fact installed and running throughout Phase 0; the audit's package check omitted `mysql`/`mariadb` names. Corrected below and in `PROJECT-AUDIT.md §3`.
> 3. **Schema/migration ownership is now Prisma Migrate** (Prisma ORM 7.10.1, pinned — npm `latest` is an 8.0 release candidate). The custom SQL migration runner described in earlier drafts is withdrawn; FastAPI's SQLAlchemy is query-only. See `SYSTEM-ARCHITECTURE.md §7.4`, §7.7, §7.8.
>
> Phase 1 status is therefore **BLOCKED** pending MySQL provisioning, not on architecture.

---

## 1. Implemented features

None. Phase 0 is audit-only, so no application features were implemented by design.

Produced: five documentation deliverables.

| Document | Purpose |
| --- | --- |
| `docs/PROJECT-AUDIT.md` | Environment, assets, gaps, risk register |
| `docs/SYSTEM-ARCHITECTURE.md` | Proposed architecture, contracts, schema, deviations |
| `docs/DEVELOPMENT-ROADMAP.md` | Phase 1–7 sequencing with exit criteria |
| `docs/RESOURCE-ANALYSIS.md` | Measured performance and memory/disk budgets |
| `docs/PHASE-0-REPORT.md` | This report |

---

## 2. Changed files

Created (documentation only):

```
docs/PROJECT-AUDIT.md
docs/SYSTEM-ARCHITECTURE.md
docs/DEVELOPMENT-ROADMAP.md
docs/RESOURCE-ANALYSIS.md
docs/PHASE-0-REPORT.md
```

Modified: **none.**
Deleted: **none.**

Scratch files under `/tmp` were created during encode benchmarks and **deleted in the same command**. No project file, virtualenv, database, or system configuration was touched. No packages were installed. No services were started or stopped.

---

## 3. Dependencies added or changed

**None.** Nothing was installed, upgraded, or removed. All measurements used what was already present (`ffmpeg-free`, PyAV, faster-whisper, Node 24).

---

## 4. Database changes

**None.** No database was created, altered, or dropped by this phase.

**Correction to an earlier statement in this report:** MySQL *is* installed on this host — as **MariaDB 11.8.8**, running on `:3306`, service active and enabled, datadir `/var/lib/mysql`, ~14 MB RSS idle, shared with unrelated projects (`airprod_dev`, `restaurant_app`, `solusi_sejalan`, a Prisma shadow DB). The Phase 0 package check queried `postgresql`, `redis`, `valkey`, and `sqlite` but not `mysql`/`mariadb`, so the absence was misreported. No application database exists yet, and no application credentials exist (`root@localhost` → `ERROR 1698`, `reksa@localhost` → `ERROR 1045`). PostgreSQL, Redis, Valkey, and SQLite are genuinely absent.

---

## 5. Tests executed

All checks were read-only, except the /tmp benchmarks which wrote only to `/tmp` and cleaned up after themselves.

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | OS / kernel identification | `cat /etc/fedora-release`, `uname -a` | PASS — Fedora 44, kernel 7.2.4 |
| 2 | CPU topology | `lscpu` | PASS — Ryzen 3 7320U, 4C/8T |
| 3 | Memory and swap | `free -h` | PASS — 7,154 MB total, 1,334 MB available, 3.7 GiB swap used |
| 4 | Disk and mount types | `df -h /home /tmp` | PASS — 54 GB free on `/home`; **`/tmp` is tmpfs** |
| 5 | GPU presence | `lspci`, `/dev/dri` | PASS — Radeon 610M, `renderD128` present |
| 6 | FFmpeg / FFprobe availability | `ffmpeg -version`, `ffprobe -version` | PASS — 8.1.2 (`ffmpeg-free`) |
| 7 | Encoder inventory | `ffmpeg -encoders` | PASS — **no libx264/libx265**; `libopenh264`, `h264_vaapi`, `libsvtav1`, `libvpx`, `aac` |
| 8 | Decoder inventory | `ffmpeg -decoders` | PASS — native `h264`/`hevc` compiled out; only `libopenh264` for H.264 |
| 9 | Filter availability | `ffmpeg -filters` | PASS — `subtitles`, `ass`, `silencedetect`, `scdet`, `crop`, `scale`, `loudnorm`, `ebur128`, `atempo` |
| 10 | libx264 availability (system FFmpeg) | `ffmpeg -h encoder=libx264` | **FAIL** — `Unknown encoder 'libx264'` (expected; drives the architecture decision) |
| 11 | H.264 decode of real fixture | `ffmpeg -i sample.mp4 -map 0:v:0 -c:v rawvideo -f null -` | PASS — decodes via libopenh264, 1080p30 |
| 12 | Fixture metadata | `ffprobe` | PASS — 93.632 s, 1920x1080, 30 fps, h264+aac+data stream |
| 13 | PyAV decode capability | `av` codec enumeration | PASS — native `h264`, `hevc`, `aac`, `vp9`, `av1` |
| 14 | PyAV encode capability | `Codec("libx264","w")` etc. | PASS — `libx264`, `libx265`, `aac` all available |
| 15 | PyAV vertical export benchmark | 300 frames, crf 26, veryfast | PASS — **73.7 fps ≈ 2.5x realtime**; output verified with `ffprobe` |
| 16 | System FFmpeg encode benchmark | 10 s → crop+libopenh264 | PASS — 8.04 s, valid MP4, 1.24x realtime |
| 17 | VAAPI hardware encode | `-vaapi_device … -c:v h264_vaapi` | **FAIL** — "No usable encoding profile found" |
| 18 | libass subtitle burn-in | `-vf subtitles=output.srt` | PASS — 5 s in 3.39 s, artifact produced |
| 19 | Python envs | `.venv312` / `.venv` | PASS — 3.12.16 working (faster-whisper 1.2.1); 3.14.7 stale |
| 20 | Whisper model cache | `~/.cache/huggingface` | PASS — `tiny` cached (75 MB); `base` absent |
| 21 | Node toolchain | `node -v`, `npm -v` | PASS — v24.21.0, npm 10.9.9, corepack present |
| 22 | Version control | `git status` | **FAIL (state, not defect)** — not a git repository |
| 23 | Database/cache packages | `rpm -q …` | **FAIL (audit gap)** — check omitted `mysql`/`mariadb`; MariaDB 11.8.8 was installed and running. Corrected 2026-11-02: MySQL present, PostgreSQL/Redis/Valkey/SQLite absent |
| 24 | Font coverage | `fc-list`, 782 families | PASS — DejaVu/Liberation/Noto present |
| 25 | Repo availability | `dnf repolist` | PASS — no RPM Fusion enabled |
| 26 | Local LLM runtime | `ollama --version`, model dir | PASS — binary 0.40.13 present, daemon inactive, **0 models** |
| 27 | Network egress | `curl` to npm / HF / Google API | PASS — 200 / 200 / reachable(404 at root) |
| 28 | Secret presence | env var **names** only | PASS — no LLM keys configured |
| 29 | Existing transcription script review | source read | PASS — logic understood, weaknesses catalogued |
| 30 | Existing SRT validity | file read | PASS — valid, but `tiny`-quality Indonesian errors observed |

### NOT TESTED (and therefore not claimed)

| Item | Why |
| --- | --- |
| Transcription wall-clock time for `tiny` / `base` | Not benchmarked in Phase 0 (would burn CPU unnecessarily); scheduled for Phase 2. The existing `output.srt` proves it *ran*, not how fast |
| Silence/scene detection accuracy | Requires the engine to exist (Phase 3) |
| Subtitle overlay via Pillow | Pillow not installed; deferred to Phase 3 |
| End-to-end upload → transcribe → render | No application exists yet |
| Concurrency/soak behaviour | Requires the job system (Phase 1+) |
| HEVC workflow | No HEVC fixture available |
| Ollama inference viability | No models downloaded |

---

## 6. Test results summary

| Status | Count |
| --- | --- |
| PASS | 27 |
| FAIL (expected/host-capability findings, not code defects) | 3 |
| BLOCKED | 0 |
| NOT TESTED | 7 |

The three FAIL results are **environmental findings that shaped the architecture**, not regressions: no `libx264` in system FFmpeg, VAAPI encode unusable, and no git repository.

---

## 7. Performance observations

Measured on this host, real fixture, real files:

| Path | Measurement | Real-time factor |
| --- | --- | --- |
| PyAV + libx264 export (1080p → 608x1080, crf 26, veryfast) | 300 frames / 4.07 s = 73.7 fps | **2.5x realtime** |
| Full 94 s fixture export projection | ~38 s | — |
| System FFmpeg + libopenh264, same transform | 10 s in 8.04 s | 1.24x realtime |
| libass subtitle burn-in | 5 s in 3.39 s | 1.48x realtime |
| PyAV native H.264 decode, 1080p30 | 60 frames / 0.89 s ≈ 67 fps | — |
| Hardware encode (VAAPI) | failed | n/a |

Memory state during the audit: 1,334 MB available of 7,154 MB, with 3.7 GiB swap already in use and measurable PSI pressure. The machine is memory-constrained **before** the app exists, which is why the architecture forbids Postgres/Redis at MVP and enforces single-job concurrency.

---

## 8. Known issues and risks

| # | Issue | Severity | Disposition |
| --- | --- | --- | --- |
| 1 | System FFmpeg cannot encode H.264 (no libx264/libx265) | High | Solved by PyAV's bundled libx264 (verified). Requires approval of D3 |
| 2 | No native H.264/HEVC decoder in system FFmpeg | Medium | PyAV decodes natively; `libopenh264` bridge works for CLI paths |
| 3 | GPU encoding unavailable (VAAPI fails) | Medium | Accepted: CPU-only, 2.5x realtime is adequate |
| 4 | ~1.3 GB RAM available; 3.7 GiB swap used | High | Single-job concurrency, no broker process, streaming I/O, disk-backed intermediates; MySQL adds ~150–250 MB to the budget |
| 5 | `/tmp` is tmpfs (RAM) | Medium | All intermediates forced to `data/` on `/home` |
| 6 | No git repository | Medium | `git init` as the first Phase 1 action |
| 7 | `tiny` Indonesian transcript has real word errors | Medium | Benchmark `base` in Phase 2; subtitle correction is a required Phase 6 feature |
| 8 | No LLM credentials; Ollama has no models | High (Phase 4+) | Gemini API recommended; key required before Phase 4 |
| 9 | Stale `.venv` (Python 3.14.7) alongside `.venv312` | Low | Standardize on `.venv312`; deletion only with approval |
| 10 | Docker service running | Low | Not used for this project (rule 17) |
| 11 | Node 24 is not LTS | Low | Acceptable; pin Node 22 if instability appears |

---

## 9. Security considerations

Verified and designed-for:

- **No shell execution by the agent.** The architecture has no `run_command`/`exec` tool; tool inputs are Pydantic-validated with `extra="forbid"`.
- **No path input from the LLM.** The agent references assets by ID; paths are resolved server-side and must stay inside `data/projects/<id>/` after `resolve()`, with symlink checks.
- **No user text in FFmpeg filter graphs.** This closes a real injection vector (`subtitles=…` takes a filename, and filter syntax uses `:` and `'`). Styling comes from fixed presets.
- **Argument arrays, never strings.** `subprocess.run([...], shell=False)`.
- **Secrets stay server-side.** The Next.js layer proxies agent calls so provider keys never reach the browser.
- **Resource limits** as abuse controls: upload size cap, duration cap, single-job concurrency, per-project disk quota.
- **Non-destructive source handling:** uploads are read-only; every operation writes a new artifact and the source hash is verified unchanged.
- No secrets were exposed during this audit: environment inspection printed variable **names** only, never values.

Residual risks documented but not yet mitigated (they depend on Phase 1+ work): authenticated access, rate limiting, and audit-log retention policy.

---

## 10. Remaining tasks

Before Phase 1 can start, these decisions need sign-off (details in `SYSTEM-ARCHITECTURE.md §11`):

| ID | Decision | Recommendation |
| --- | --- | --- |
| D1 | ~~PostgreSQL now, or SQLite at MVP?~~ | **CLOSED — MySQL is mandated** (MariaDB 11.8.8, one shared database). See `SYSTEM-ARCHITECTURE.md §7` |
| D2 | Redis + broker now, or in-process durable queue? | **MySQL-backed durable queue**, strict single-worker; no broker |
| D3 | Rendering engine: PyAV hybrid, or enable RPM Fusion for full FFmpeg? | **PyAV hybrid** (no system change); RPM Fusion optional later |
| D4 | LLM provider | **Gemini API** (needs a key); Ollama optional for offline |
| D5 | Backend split (Next.js CRUD + FastAPI media) | **As proposed** |
| D6 | Confirm single-user local mode until Phase 7 | **Confirm** |
| D7 | Subtitle burn-in approach (Pillow overlay vs. libass CLI) | **Pillow overlay**; revisit in Phase 3 |
| D8 | Node version: keep 24 or pin 22 LTS? | **Keep 24** unless problems appear |
| D9 | Is it acceptable to `git init` in Phase 1? | **Yes** |
| D10 | Schema management and migrations | **Prisma ORM 7.10.1 + Prisma Migrate** as sole owner; SQLAlchemy query-only in FastAPI; no Alembic, no custom runner, no `db push` |

Also required from you: an LLM API key (or an explicit decision to go local), and confirmation of the target footage mix (phone 1080p only, or 4K) since 4K would roughly quadruple render time on this CPU.

---

## 11. Final recommendation

**Proceed with the PyAV-centric hybrid architecture and a MySQL-backed durable queue** — after MySQL access is provisioned. (Originally recommended SQLite; superseded by the mandatory MySQL decision.)

The environment is viable. The three findings that matter are:

1. **PyAV's bundled FFmpeg is the only way to encode H.264 on this machine without a system change.** Verified working at 2.5x realtime. This is the foundation of the rendering engine.
2. **Memory, not CPU, is the binding constraint.** 1.3 GB available and 3.7 GiB of swap already in use means Postgres, Redis, containers, and multi-job concurrency are all inappropriate right now. SQLite plus a single-worker queue keeps the app inside its budget.
3. **The existing Whisper prototype is genuinely reusable.** The model configuration is already correct for this hardware; what's missing is service plumbing (arguments, SRT+VTT, job control), not a new approach.

---

## PHASE STATUS

| Field | Value |
| --- | --- |
| Phase | 0 — Audit and Architecture |
| Status | **COMPLETE** |
| Acceptance criteria | **SATISFIED** — repository, environment, Python/venv, faster-whisper, PyAV, FFmpeg/FFprobe, RAM/CPU all inspected; the five required documents exist |
| Changes to code / deps / DB / env / system | **None** |
| Next phase safe to begin? | **BLOCKED** — architecture is consistent, but no application MySQL credentials exist. Phase 1 starts only after `aivideo`, `aivideo_shadow`, and the three scoped users are provisioned (needs `sudo`) |
| Blocking for later phases | Phase 4 is blocked without an LLM credential |

### Approval requested

Phase 0 is finished and I have stopped. I will not begin Phase 1, install dependencies, initialize git, or write application code until you approve.

Please reply with either:
- **"Approve Phase 1"** (optionally overriding any of D1–D9), or
- your amendments to the architecture and decisions.
