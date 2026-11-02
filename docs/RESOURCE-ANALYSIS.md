# RESOURCE ANALYSIS — CPU-only, 7 GB RAM, Fedora 44

All figures below were **measured on this machine** during Phase 0 unless explicitly marked as an estimate. Measurement method is stated for each so it can be reproduced.

---

## 1. Host capacity

| Resource | Capacity | Notes |
| --- | --- | --- |
| CPU | Ryzen 3 7320U, 4C/8T @ 2.4 GHz, 4 MiB L3 | AVX2 + F16C; no AVX-512 |
| RAM | 7,154 MB total | ~1.3 GB available at audit; 3.7 GiB swap in use |
| Disk (`/home`) | 54 GB free on NVMe | Sufficient; monitor for growth |
| `/tmp` | tmpfs, RAM-backed | **Not usable for media** |
| GPU encode | unavailable | VAAPI `h264_vaapi` failed: "No usable encoding profile found" |
| Network | available | npm, Hugging Face, Google API reachable |
| MySQL | MariaDB 11.8.8 running on `:3306` | ~14 MB RSS idle (measured); shared with unrelated projects; app credentials not yet provisioned |

Effective compute budget for the product: **~4 usable cores** (the 8 logical threads share 4 physical cores and contend with the desktop). Plan for 3–4 worker threads, never 8.

---

## 2. Measured video performance

Test fixture: `whisper/videos/sample.mp4`, 1920x1080 H.264 High @ 30 fps, 93.632 s, AAC audio.
Target transform: crop to 9:16 (`crop=608:1080:656:0`), single-pass encode, no filters beyond crop/scale.

### 2.1 PyAV + bundled libx264 (recommended export path)

```
codec: libx264, crf 26, preset veryfast, 608x1080, yuv420p
result: 300 frames encoded in 4.07 s
```

| Metric | Value |
| --- | --- |
| Throughput | **73.7 fps** |
| Real-time factor @ 30 fps source | **2.46x realtime** |
| Projected render of the full 93.6 s clip | **~38 s** |
| Output size (10 s, crf 26) | 854 KB |
| Decode+encode memory footprint | ~250–350 MB (measured as delta during the run) |

This is the export path the architecture is built on. It is roughly 2x faster than the OpenH264 path because libx264's `veryfast` preset plus lower output resolution (608x1080 vs. read cost) and better rate control dominate.

### 2.2 System FFmpeg + libopenh264 (fallback path)

```
ffmpeg -ss 0 -i sample.mp4 -t 10 -vf "crop=608:1080:656:0" -c:v libopenh264 -b:v 3000k -c:a aac -b:a 128k
```

| Metric | Value |
| --- | --- |
| Elapsed for 10 s of video | **8.04 s** |
| Real-time factor | **1.24x realtime** |
| Projected full-clip render | ~75 s |
| Output | valid MP4, h264 608x1080 + aac, 10.0 s, 3.2 MB |

Viable for previews; ~2x slower and lower encoding quality than libx264. Kept as a fallback only.

### 2.3 Subtitle burn-in (libass via system FFmpeg)

```
ffmpeg -ss 0 -i sample.mp4 -t 5 -vf "crop=608:1080:656:0,subtitles=whisper/output.srt:force_style='FontSize=18,Outline=2'" -c:v libopenh264
```

| Metric | Value |
| --- | --- |
| Elapsed for 5 s | **3.39 s** |
| Real-time factor | **1.48x realtime** |
| Fonts available | 782 families; DejaVu/Liberation/Noto present |

Confirms libass works. Note the encode here is OpenH264; combining libass with libx264 requires either the PyAV overlay approach or a full FFmpeg build (see architecture §4.3).

### 2.4 Decode throughput (software)

| Path | Result |
| --- | --- |
| System FFmpeg `libopenh264` → `rawvideo`, 1080p30 | 60 frames in 2.15 s (≈28 fps); dominated by rawvideo output volume |
| PyAV native `h264` decoder, 1080p30 | 60 frames in 0.89 s (≈67 fps) |

PyAV's native decoder is markedly faster than the OpenH264 bridge — another reason the PyAV-centric pipeline is preferred.

### 2.5 Hardware encode

```
ffmpeg -vaapi_device /dev/dri/renderD128 ... -c:v h264_vaapi
→ [h264_vaapi] No usable encoding profile found.
→ Error while opening encoder
```

**Not available.** Do not design around GPU acceleration on this host. Revisit only if the FFmpeg build or driver changes.

---

## 3. Transcription budget

`faster-whisper 1.2.1` / `ctranslate2 4.8.4`, CPU, int8, `vad_filter=True`.

| Model | Weights on disk | RAM during inference (estimate) | Status |
| --- | --- | --- | --- |
| `tiny` | ~75 MB (cached) | ~250–400 MB | Executed successfully in this environment (artifact: `output.srt`) |
| `base` | ~145 MB (requires download) | ~500–700 MB | **NOT TESTED** — must be benchmarked in Phase 2 |
| `small` | ~480 MB | ~1.0–1.4 GB | Not recommended for this RAM budget |

Honest statement of what is known: the `tiny` model produced a complete, well-formed 93-second Indonesian transcript on this machine. **The wall-clock time of that run was not recorded**, so no error-per-second claim is made here. Phase 2 must run a timed benchmark of `tiny` and `base` on this exact fixture before any performance claim enters the roadmap.

Practical constraint regardless of the benchmark: transcription and video rendering must **never run concurrently**. Each can consume the machine's available memory on its own.

Thread allocation: `cpu_threads=3` for CTranslate2 (leaving one physical core for Node, MySQL client work, and the OS). Using 8 threads would oversubscribe 4 physical cores and slow everything down.

---

## 4. Service memory budget

Estimates based on typical RSS for these stacks, to be validated in Phase 1 with real measurements.

| Component | Idle RSS | Peak during work | Notes |
| --- | --- | --- | --- |
| Next.js dev server (`next dev`) | 350–600 MB | ~700 MB (compile) | Largest fixed cost; use production build for long sessions |
| Python API (FastAPI + uvicorn) | 90–140 MB | ~200 MB | Stateless; modest |
| Video worker process (PyAV + libx264) | 120 MB | 300–400 MB | Runs one job at a time |
| Transcription worker | 150 MB | 400 MB (`tiny`), 700 MB (`base`) | Never concurrent with rendering |
| MySQL (MariaDB 11.8.8, shared instance) | ~14 MB (measured, idle) | ~150–250 MB under application load | `innodb_buffer_pool_size` defaults to 128 MB and is allocated by the server; the instance is shared, so this is not ours to tune |
| Browser (user's editing session) | 600 MB–1.6 GB | higher with video preview | Observed Firefox at ~1.6 GB during this audit |

**Recommended operating envelope:** ≤ 2.7 GB for all application processes — raised from the earlier 2.5 GB to absorb the MySQL working set. With the desktop and a browser already consuming ~4–5 GB, headroom is thin. Three consequences drive the architecture:

1. **MySQL is the only database, and its cost is now fixed.** It is mandated, so the ~150–250 MB is budgeted rather than avoided. It replaces *both* the previously planned SQLite file *and* the Redis broker: the durable job queue lives in MySQL (architecture §7.5), so there is no extra process to pay for.
2. **Preview must never be stored in memory.** Video reads and writes stream to disk files; no route may buffer a whole file in RAM.
3. **Connection pools are part of the memory budget.** The application is capped at 10 connections total (5 in Next.js, 5 in FastAPI/worker). Each live connection carries per-connection buffers on both sides.

### Why not Ollama as the primary model

| Constraint | Value |
| --- | --- |
| Ollama installed | yes (0.40.13), daemon inactive |
| Models downloaded | none |
| 3–4B model Q4 RAM | ~2.5–3.0 GB |
| 7B model Q4 RAM | ~4.5–5.0 GB |

A 7B model is impossible here alongside a browser and the dev stack. A 3–4B model fits only if nothing else runs, and it would contend with video encoding for the same 4 cores. Local inference is therefore **not** the primary path; it can be offered later as an opt-in for offline use.

---

## 5. Disk budget

Per project, assuming a 94 s 1080p source:

| Artifact | Approx. size | Retained |
| --- | --- | --- |
| Original upload | 1x source (42 MB here) | Permanent |
| Extracted audio (WAV 16 kHz mono) | ~3 MB | Until transcript ready |
| Transcript JSON | 50–200 KB | Permanent |
| Editing plans / timelines | < 100 KB | Permanent |
| Preview render (720p, crf 30) | ~2–5 MB | Latest only |
| Final export (608x1080, crf 26) | ~1.5–4 MB | Permanent |
| Intermediate renders | 5–50 MB each | Deleted after success |

At ~50 MB per project plus source, 54 GB supports hundreds of projects — but only if intermediates are cleaned up. The storage layer must delete intermediates on job success and provide an explicit cleanup path for orphans.

---

## 6. Throughput model for the MVP

| Operation | Measured / estimated | Confidence |
| --- | --- | --- |
| Probe metadata | < 300 ms | measured |
| Extract audio (94 s clip) | 1–3 s | estimate from decode rates |
| Transcribe `tiny` (94 s clip) | not measured | Phase 2 |
| Transcribe `base` (94 s clip) | not measured | Phase 2 |
| Silence + scene detection | 3–8 s (single decode pass) | estimate |
| Vertical export 94 s (PyAV/libx264) | **~38 s** | measured |
| Subtitle burn-in equivalent | ~63 s projected (1.48x RT) | measured on 5 s sample |

The product is therefore usable in the "request an edit, wait under a minute, review" loop — provided only one job runs at a time and the browser is not competing for RAM during export.

---

## 7. Hard rules derived from this analysis

1. **One heavy job at a time.** A global semaphore of 1 for rendering, 1 for transcription, and never both together.
2. **`data/` lives on `/home`, never `/tmp`.** `/tmp` is RAM.
3. **Stream, never buffer.** No route handler may read a full video into memory.
4. **Cap concurrency, not ambition.** Additional parallel workers are a Phase 7 concern, after measuring on this hardware.
5. **No heavyweight local models by default.** Any local LLM must be benchmarked and opt-in.
6. **Do not claim transcription timing** until Phase 2 measures it.
7. **Preview resolution stays low** (720p or lower, crf 30) so iteration costs seconds, not minutes.
8. **Never exceed 10 database connections.** Raising pool sizes trades RAM for latency this product does not need yet.
9. **Do not tune the shared MySQL server.** `innodb_buffer_pool_size`, `max_connections`, and `performance_schema` are global to an instance shared with unrelated projects; changing them requires approval and a measurement first.
