# AI Video Editor

Web-based AI video editor with an agent that plans and executes real editing
operations. **Phase 1 (foundation) only** — upload, project storage, metadata
inspection, and service scaffolding.

## Stack

| Layer | Technology |
| --- | --- |
| Web app | Next.js 16.4.3, React 19.3.1, TypeScript 5.9.3, Tailwind CSS 4.3.3 |
| UI primitives | shadcn-style components (Radix + CVA), lucide icons |
| ORM / schema owner | Prisma **7.10.1** + Prisma Migrate (only migration system) |
| Database | MariaDB 11.8.8 via `provider = "mysql"` |
| Media service | FastAPI + SQLAlchemy 2.x (query-only), `pool_size=3`, `max_overflow=2` |
| Video engine (later phases) | PyAV (bundled libx264) |
| Storage | Local disk under `data/projects/` |

## Requirements

- Node.js ≥ 24 (tested on v24.21.0)
- Python 3.12 (media service)
- MySQL-compatible server (MariaDB 11.8.8)

## Environment files

| File | Purpose | Committed? |
| --- | --- | --- |
| `.env.example` | Root template for web + Prisma CLI | Yes |
| `.env.local` | Your real root values (Next.js + Prisma CLI) | **No** |
| `media-service/.env.example` | Media service template | Yes |
| `media-service/.env` | Your real media service values | **No** |

Never commit real credentials. Nothing uses `NEXT_PUBLIC_` for database values,
and the migrator URL is used only by Prisma CLI commands.

## Setup

```bash
# 1. Dependencies
npm install

# 2. Configure environment
cp .env.example .env.local          # then edit
cp media-service/.env.example media-service/.env

# 3. Database (requires the migrator account)
npm run db:migrate:deploy           # apply migrations
npm run db:generate                 # generate Prisma Client

# 4. Run
npm run dev                         # web on http://localhost:3000
cd media-service && .venv/bin/uvicorn app.main:app --reload --port 8000
```

## Database

Prisma Migrate owns the schema and history. There is no custom migration
runner, no Alembic, and no `prisma db push` workflow.

```bash
npm run db:migrate:dev -- --name <name>   # create a migration (dev)
npm run db:migrate:deploy                 # apply in any environment
npm run db:migrate:status                 # check state
npm run db:studio                         # inspect data
```

One writer per table: Next.js writes `projects` and `assets`; the media service
writes only media-owned tables. This is enforced by MySQL grants, not convention.

## Verification

```bash
npm run typecheck        # tsc --noEmit
npm run build            # production build
npm run verify:storage   # streaming upload + SHA-256 against a real 42 MB video
npm run verify:db-access # access-boundary probe (needs database credentials)
cd media-service && .venv/bin/pytest -q
```

## Layout

```
prisma/            schema + migrations (Prisma owns DDL)
src/app/           Next.js routes (dashboard, projects, API)
src/features/      feature modules (projects)
src/lib/           env, prisma singleton, storage, ids
media-service/     FastAPI service (health, SQLAlchemy models)
data/projects/     runtime media (gitignored, never /tmp)
whisper/           existing faster-whisper experiment (preserved, untouched)
docs/              architecture, roadmap, phase reports
```

## Limits

- One video job at a time; transcription and rendering never run concurrently.
- `data/` must stay on `/home` — `/tmp` is a RAM-backed tmpfs on Fedora.
