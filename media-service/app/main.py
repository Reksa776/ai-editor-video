"""FastAPI application entrypoint for the media service.

Phase 1 scope: health endpoints, database wiring, and a structure ready for
Phase 2 (transcription) and Phase 3 (video processing). No Whisper or video
processing is implemented here yet.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.health import router as health_router
from app.config import settings

app = FastAPI(
    title="AI Video Editor - Media Service",
    version="0.1.0",
    description="Media inspection and processing service. Schema owned by Prisma Migrate.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:3000", "http://localhost:3000"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["content-type"],
)

app.include_router(health_router, prefix="/api")


@app.get("/")
def root() -> dict[str, str]:
    return {
        "service": "media-service",
        "docs": "/docs",
        "health": "/api/health",
        "env": settings.app_env,
    }
