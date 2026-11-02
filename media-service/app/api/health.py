"""Health endpoints.

/health      - liveness only; never touches the database (always 200 when up)
/health/db   - readiness; executes SELECT 1 and returns 503 when unavailable
"""

from __future__ import annotations

from fastapi import APIRouter, status
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.config import settings
from app.database.session import get_engine

router = APIRouter(tags=["health"])


@router.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "service": "media-service",
        "env": settings.app_env,
        "database": "configured" if settings.database_configured else "not_configured",
        "worker_concurrency": settings.worker_concurrency,
    }


@router.get("/health/db")
def health_db() -> JSONResponse:
    if not settings.database_configured:
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"status": "not_configured", "detail": "MEDIA_DATABASE_URL is not set"},
        )

    try:
        with get_engine().connect() as connection:
            connection.execute(text("SELECT 1"))
        return JSONResponse(status_code=status.HTTP_200_OK, content={"status": "ok"})
    except Exception as exc:  # noqa: BLE001 - surfaced to the operator, not swallowed
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"status": "error", "detail": str(exc).split("\n")[0]},
        )
