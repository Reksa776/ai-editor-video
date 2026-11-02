# PROJECT AUDIT — Phase 0

Audit date: 2026-11-02
Scope: read-only inspection of the repository and the Fedora host. No files, packages, services, or configuration were modified.

---

## 1. Repository state

| Item | Finding |
| --- | --- |
| Repository root | Project root contains exactly one directory: `whisper/` |
| Version control | **No git repository.** `git status` → `fatal: not a git repository`. No history, no baseline, no ability to diff changes |
| Total tracked project files | 4 (excluding the two virtualenvs) |
| Application code | None. There is no web application, no backend service, no database, no build system |
| Documentation | None prior to this audit |

The project is effectively **greenfield**. The only pre-existing asset is a working transcription experiment.

### Complete file inventory (excluding virtualenv contents)

```
whisper/
├── transcribe.py        1,052 B   faster-whisper experiment script
├── output.srt           2,005 B   generated Indonesian subtitle file
├── videos/
│   └── sample.mp4      42,305,329 B  sample source footage
├── .venv/                        Python 3.14.7 environment (stale)
└── .venv312/                     Python 3.12.16 environment (active, working)
```

---

## 2. Environment audit

### Operating system

| Property | Value |
| --- | --- |
| Distribution | Fedora Linux 44 (KDE Plasma Desktop Edition) |
| Kernel | 7.2.4-200.fc44.x86_64 |
| Init | systemd (user services available) |
| Shell | bash |

### CPU

| Property | Value |
| --- | --- |
| Model | AMD Ryzen 3 7320U with Radeon Graphics |
| Cores / threads | 4 physical / 8 logical |
| Max frequency | 2401 MHz |
| L3 cache | 4 MiB (single instance) |
| SIMD | AVX2, FMA, F16C present; no AVX-512 |
| Observed load | ~1.48 (15 min average) at idle-ish desktop use |

AVX2 + F16C is the relevant subset: CTranslate2 (faster-whisper's runtime) can use int8 AVX2 kernels on this CPU, which is the fastest CPU path available without a GPU.

### Memory

| Property | Value |
| --- | --- |
| Total RAM | 7,154 MB (~7.0 GiB) |
| Used at audit | 5,820 MB |
| **Available at audit** | **1,334 MB** |
| Swap | 7.0 GiB total, **3.7 GiB already in use** |
| PSI memory pressure | `some avg10=1.57`, `full avg10=1.57` |

This is the single most important constraint in the project. The host is **already under memory pressure before any application is built**. Top consumers at audit time were Firefox content processes (~1.6 GB combined) plus KDE Plasma, AnyDesk, ChatGPT desktop app, and Akonadi.

Any architecture that assumes 2–4 GB of headroom per service is not viable here.

### Storage

| Mount | Size | Used | Available | Notes |
| --- | --- | --- | --- | --- |
| `/home` (nvme0n1p8) | 110 G | 55 G | **54 G** | Project lives here. NVMe, fast |
| `/tmp` | 3.5 G | 58 M | 3.5 G | **tmpfs — RAM-backed** |

Critical detail: **`/tmp` is a tmpfs mount.** Writing video intermediates to `/tmp` consumes RAM directly and will trigger the swap/OOM behaviour already visible in the system. All scratch and intermediate media must live under the project's own `data/` directory on `/home`.

### GPU

| Property | Value |
| --- | --- |
| Adapter | AMD Radeon 610M (Mendocino, integrated) |
| Device nodes | `/dev/dri/card1`, `/dev/dri/renderD128` present |
| VAAPI encode attempt | **FAILED** — `h264_vaapi: No usable encoding profile found` |
| CUDA | Not present; no NVIDIA hardware |

Hardware video encoding is **not available** through the installed FFmpeg build. Treat this machine as CPU-only for all video work, exactly as the project brief assumed.

---

## 3. Toolchain audit

### FFmpeg / FFprobe

| Property | Value |
| --- | --- |
| Package | `ffmpeg-free-8.1.2-4.fc44.x86_64` |
| Binaries | `/usr/bin/ffmpeg`, `/usr/bin/ffprobe` (8.1.2) |
| H.264 decoder | Only `libopenh264` (Cisco). The native `h264` decoder is **compiled out** |
| HEVC decoder | **Not available** (compiled out) |
| H.264 encoder | `libopenh264`, `h264_vaapi` (broken), `h264_nvenc` (no hardware) |
| **libx264 / libx265** | **Not present.** `Unknown encoder 'libx264'` |
| Other encoders | `libsvtav1`, `libvpx-vp9`, `libaom`, `aac`, `libfdk_aac`, `prores`, `ffv1` |
| Filters confirmed | `subtitles`/`ass` (libass 0.17.4), `silencedetect`, `scdet`, `crop`, `scale`, `atempo`, `loudnorm`, `ebur128`, `select` |
| Hardware accel methods advertised | vdpau, cuda, vaapi, qsv, drm, vulkan, amf (advertised ≠ working; VAAPI encode failed) |

The Fedora build config is explicit: `--disable-encoders --disable-decoders ... --disable-decoder='h264,hevc,vc1,vvc'`. This is the standard Fedora "patent-clean" FFmpeg.

**Consequence:** the system FFmpeg cannot be the sole video engine. It can *analyze* media and *render subtitles*, but it cannot produce a high-quality H.264 export.

### PyAV (bundled FFmpeg)

The Python environment ships PyAV, which bundles its own FFmpeg libraries — and these are complete.

| Property | Value |
| --- | --- |
| PyAV version | 14.0.1 |
| Bundled libavcodec | 61.19.100 (FFmpeg 7.x) |
| Decoders | `h264` YES, `hevc` YES, `aac` YES, `vp9` YES, `av1` YES, `mp3` YES |
| Encoders | **`libx264` OK**, **`libx265` OK**, `aac` OK |
| Bundled libs | `libx264-2a4c6f6d.so.164`, `libx265-d8690e8d.so.199` |

This resolves the encoder gap **without installing anything and without changing system configuration.** It is the decisive finding of this audit and the basis of the recommended rendering architecture.

Note: PyAV's bundle does **not** include libass, so the `subtitles` filter is unavailable inside PyAV. Subtitle burn-in must therefore either use system FFmpeg (which has libass) or be drawn directly onto frames in Python.

### Python environments

| Environment | Version | State | Assessment |
| --- | --- | --- | --- |
| `whisper/.venv312` | Python 3.12.16 | Working, faster-whisper functional | **Canonical — keep** |
| `whisper/.venv` | Python 3.14.7 | Stale, incomplete (contains only CTranslate2 converter shims) | Dead weight; do not delete without approval |

Installed in `.venv312`:

```
faster-whisper   1.2.1      av              14.0.1
ctranslate2      4.8.4      onnxruntime     1.31.1
numpy            2.5.4      tokenizers      0.23.3
huggingface_hub  2.4.0      PyYAML          6.0.3
protobuf         7.36.2     flatbuffers     25.12.19
tqdm             4.70.1     httpx2/httpcore2 (present)
```

Notably **absent**: `fastapi`, `uvicorn`, `pydantic`, `Pillow`, `sqlalchemy`. All are Phase 1+ additions.

### Whisper model cache

| Item | Value |
| --- | --- |
| `~/.cache/huggingface` size | 75 MB |
| Models present | `Systran/faster-whisper-tiny` only |
| `tiny` / `base` | `tiny` cached; `base` not cached (~145 MB download required) |

### Node.js toolchain

| Property | Value |
| --- | --- |
| Node | v24.21.0 (via nvm) |
| npm | 10.9.9 |
| pnpm | Not installed (corepack available) |
| Compatible with Next.js | Yes (Next.js requires Node 8.2+, modern releases require 18+) |

Node 24 is at the aggressive end of the support matrix; pinning to the active LTS (Node 22) is safer for a long-lived project, but Node 24 is workable and already installed. No new install is required either way.

### Database / cache

> **Correction (2026-11-02, post-audit):** the original version of this section claimed no database was installed. That was wrong — the package check queried `postgresql`, `redis`, `valkey`, and `sqlite` but never `mysql`/`mariadb`. Verified findings follow.

**MySQL is present and running.** Fedora provides it as **MariaDB 11.8.8**, which speaks the MySQL wire protocol and installs the `mysql`/`mysqld` binaries:

| Item | Finding |
| --- | --- |
| Packages | `mariadb-server-11.8.8-3.fc44`, `mariadb-11.8.8-3.fc44`, `mariadb-connector-c-3.4.9`, `mysql-selinux` |
| Service | `mariadb.service` **active and enabled** (`mysqld.service` is an alias); listening on `0.0.0.0:3306` |
| Datadir / socket | `/var/lib/mysql`, `/var/lib/mysql/mysql.sock` |
| Resident memory | ~14 MB (idle) |
| Existing databases | `airprod_dev`, `airprod_test`, `ecommerce_iot`, `reksa`, `repiw`, `restaurant_app`, `solusi_sejalan`, `prisma_migrate_shadow_db` |
| Oracle MySQL | **Not installed**; `community-mysql-server` is unavailable in the enabled repos |
| Application credentials | **None.** `root@localhost` → `ERROR 1698` (unix_socket auth); `reksa@localhost` → `ERROR 1045` |
| Other instances | Docker `restaurant-mariadb` on **3307**; Akonadi private `mysqld` on `/run/user/1000/akonadi/mysql.sock` |

The instance is **shared with unrelated projects**, so anything this application does must be confined to its own database (`aivideo`) and its own users. See `SYSTEM-ARCHITECTURE.md §7`.

`postgresql-server`, `postgresql`, `redis`, `valkey`, and the `sqlite` packages are genuinely **not installed**.

**ORM / migration tooling: none present.** No `prisma`, `@prisma/client`, `@prisma/adapter-mariadb`, SQLAlchemy, or Alembic is installed in the project or globally. Version note for the chosen stack: `npm view prisma dist-tags` currently reports `latest: 8.0.0-rc.29` (a **release candidate**) while `@prisma/client` stable is `7.10.1` — an unpinned `npm i prisma` would install the RC. The project pins `7.10.1` explicitly (see `SYSTEM-ARCHITECTURE.md §7.7`).

### Fonts (subtitle rendering)

782 font families installed, 529 of them DejaVu/Liberation/Noto. Subtitle burn-in has adequate font coverage; no font packaging work needed.

### Package repositories

Enabled: `fedora`, `updates`, `fedora-cisco-openh264`, `code`, `docker-ce-stable`, `google-chrome`, `openai-chatgpt`, `tailscale-stable`.

**RPM Fusion is not enabled.** The full-featured `ffmpeg` (with libx264/libx265) cannot be installed without first enabling a third-party repository — a system-level change requiring explicit approval.

### Container runtime

Docker CLI (`/usr/bin/docker`) is installed and the `docker` service is **active**. Per project rule 17, Docker should not be used for initial local development; the service is already running for unrelated reasons and was left untouched.

### Local LLM runtime

| Item | Value |
| --- | --- |
| Ollama binary | `/usr/local/bin/ollama`, version 0.40.13 |
| Daemon state | **inactive** |
| Downloaded models | **none** (`no local models`) |
| Disk used by Ollama | negligible |

Ollama is installed but has never been used — no weights exist locally. A 7B-class model in Q4 needs roughly 4.5–5 GB of RAM; combined with the browser and the Node/Python services on a 7 GB machine, that is not viable. A 3–4B model is the practical ceiling and would compete with video encoding for the same cores.

### Network egress

| Endpoint | Result |
| --- | --- |
| `registry.npmjs.org` | 200 |
| `huggingface.co` | 200 |
| `generativelanguage.googleapis.com` | 404 on bare root (endpoint reachable; requires a key) |
| LLM API keys in environment | **none present** |

A hosted multimodal model is reachable from this machine, but no credentials exist yet.

---

## 4. Existing assets and what actually works

### `whisper/transcribe.py`

```python
model = WhisperModel("tiny", device="cpu", compute_type="int8")
segments, info = model.transcribe("videos/sample.mp4", language="id", vad_filter=True)
```

**Working and reusable:**
- The model configuration is correct for this hardware: CPU, int8, `tiny`.
- `vad_filter=True` is the right default — it prevents Whisper hallucinating text over silence, which matters for footage with pauses.
- `language="id"` confirms the Indonesian target language from the brief.
- Transcription of the sample footage **has been executed successfully** — `output.srt` is the artifact.

**Why it works despite the broken system FFmpeg:** faster-whisper decodes audio through **PyAV**, which bundles a complete FFmpeg. The transcription pipeline never touches `/usr/bin/ffmpeg`. This is not a coincidence to rely on blindly, but it does mean the audio path is sound.

**Weaknesses to address in Phase 2 (none are blockers):**

| Issue | Impact |
| --- | --- |
| `"videos/sample.mp4"` hardcoded relative path | Only runs from inside `whisper/` |
| No CLI arguments, no output path control | Cannot be driven by a job worker |
| Writes `output.srt` into CWD | Conflicts between concurrent jobs |
| SRT only — no VTT generation | Brief requires both |
| Timestamp formatter truncates with `int()` | Millisecond drift; not rounded |
| `list(segments)` materializes everything | Fine at 93 s; wasteful on long footage |
| No `word_timestamps` | Blocks word-level/karaoke subtitle styling later |
| No error handling, no progress reporting | Unusable as a service component |
| Model name hardcoded to `tiny` | Cannot benchmark tiny vs base without editing source |

### `whisper/output.srt`

A valid, well-formed Indonesian SRT: 19+ cues covering 0:00–0:45+ of speech, sensible cue boundaries, correct `HH:MM:SS,mmm` formatting. Quality is consistent with Whisper `tiny`: mostly accurate with predictable errors on proper nouns ("mengalola" → mengelola, "Build X", "menganalysis" → menganalisis, "dapetik" → detik). This is direct evidence that `base` or `small` will be needed for *publishable* Indonesian subtitles, and that a user-facing subtitle correction step (Phase 6) is genuinely necessary, not optional polish.

### `whisper/videos/sample.mp4`

| Property | Value |
| --- | --- |
| Size | 42.3 MB |
| Duration | 93.632 s |
| Video | H.264 High, 1920x1080, 30 fps, yuv420p, bt709, ~3.35 Mbps |
| Audio | AAC |
| Extra stream | index 2, `data` type (mobile timecode/metadata track) |
| Container | MP4 |

An excellent test fixture: real 1080p phone-style footage with a third data stream that naive pipelines often choke on, ~94 s long (long enough to make performance measurable, short enough to iterate), and with known-good Indonesian speech.

---

## 5. Gap analysis against the product brief

| Brief component | State | Gap |
| --- | --- | --- |
| Web application (dashboard, projects, editor) | Absent | Everything |
| Upload + project management | Absent | Everything |
| Storage abstraction | Absent | Everything |
| Python AI service (FastAPI) | Absent | Everything |
| Transcription engine | **Prototype exists** | Needs service wrapper, VTT, job control, benchmarking |
| Video processing engine | Absent | Needs all operations; encoder strategy is the key decision |
| Job management | Absent | Everything |
| Database | Absent | Everything |
| AI agent + tool registry | Absent | Everything |
| LLM credentials | Absent | Requires user-supplied key or a local model |
| Database | **MariaDB 11.8.8 present and running on `:3306`** (MySQL protocol), shared with other projects; no application database or credentials yet | Provision `aivideo` + `aivideo_shadow` + scoped users (see `SYSTEM-ARCHITECTURE.md §7.0`) |
| ORM / migrations | Absent — no Prisma, SQLAlchemy, or Alembic installed | Add `prisma@7.10.1` + `@prisma/client@7.10.1` + `@prisma/adapter-mariadb` (Phase 1); SQLAlchemy query-only in FastAPI |
| Git version control | Absent | Should be initialized before Phase 1 writes code |
| Automated tests | Absent | Everything |

---

## 6. Risk register

| # | Risk | Severity | Evidence | Mitigation |
| --- | --- | --- | --- | --- |
| R1 | **RAM exhaustion** — 1.3 GB available before building anything | High | `free -h`; 3.7 GiB swap already used | Single-job concurrency, stream frames instead of buffering, keep intermediates on disk, document "close the browser before rendering" |
| R2 | **No libx264 in system FFmpeg** | High | `Unknown encoder 'libx264'` | Use PyAV's bundled libx264/libx265 (verified working) |
| R3 | Hosted FFmpeg has no native H.264/HEVC decoder | Medium | `--disable-decoder='h264,hevc,vc1,vvc'` | PyAV decodes these natively; system FFmpeg falls back to `libopenh264` where a CLI is needed |
| R4 | **No hardware encoding** | Medium | VAAPI encode failed | Accept CPU-only; ~2.5x realtime with libx264 `veryfast` at 608x1080 — acceptable for MVP |
| R5 | **`/tmp` is tmpfs (RAM)** | Medium | `df -h /tmp` → tmpfs | Hard rule: intermediates go to `data/`, enforced in the storage layer |
| R6 | No LLM credentials; Ollama has no models | High (Phase 4–5) | env scan; `no local models` | Decide provider before Phase 4: Gemini API (network verified) recommended |
| R7 | Disk growth from renders/previews | Medium | 54 GB free | Per-project quotas, cleanup policy for intermediates, storage abstraction from day one |
| R8 | No version control | Medium | `not a git repository` | `git init` as the first action of Phase 1, with `.gitignore` excluding `data/` and venvs |
| R9 | Dual Python venvs (3.12 + stale 3.14) cause import confusion | Low | `.venv`, `.venv312` | Standardize on `.venv312`; retire the other only with approval |
| R10 | `tiny` Indonesian transcript quality is below publishable | Medium | Observed errors in `output.srt` | Benchmark `base`; plan for user subtitle editing (Phase 6) |
| R11 | Next.js on Node 24 (not LTS) | Low | `node --version` | Accept, or pin Node 22 via nvm |
| R12 | Docker service active alongside CPU-bound jobs | Low | `docker` active | Do not add containers; per rule 17 |
| R13 | Subtitle filter path/filename injection into FFmpeg filtergraph | Medium | filter argument construction | Never interpolate user strings into filter graphs; validate against a path allowlist |

---

## 7. Audit conclusion

The environment is **workable for this project, with one forced architectural decision**: the system FFmpeg is decode-crippled and encoder-less for H.264, and PyAV's bundled FFmpeg 7 must carry the encode path. Everything else — faster-whisper, Indonesian language support, libass subtitle rendering, scene/silence analysis filters, fonts, Node, network access to both npm and a hosted LLM API — is present and verified.

The dominant constraint is **memory, not CPU**. CPU throughput is adequate (measured below); the machine cannot host MySQL + a broker + Node dev server + Python worker + browser simultaneously in its current 7 GB configuration without heavy swapping. (This is also why the queue is MySQL-backed and there is no Redis.)

Measured performance (full detail in `docs/RESOURCE-ANALYSIS.md`):

| Path | Measured | Real-time factor |
| --- | --- | --- |
| PyAV + libx264, 1080p→9:16 608x1080, crf 26 veryfast | 73.7 fps | **2.5x realtime** |
| System FFmpeg + libopenh264, same transform | 10 s in 8.04 s | 1.24x realtime |
| libass subtitle burn-in, 5 s clip | 5 s in 3.39 s | 1.48x realtime |
| VAAPI hardware encode | failed | unusable |

A 94-second 1080p clip can be cropped to vertical, encoded, and muxed with audio in roughly 38 seconds on CPU. That is fast enough for an iterative editing product on this hardware.

See `docs/SYSTEM-ARCHITECTURE.md` for the recommended design, `docs/RESOURCE-ANALYSIS.md` for budgets, `docs/DEVELOPMENT-ROADMAP.md` for sequencing, and `docs/PHASE-0-REPORT.md` for the decision summary and approval request.
