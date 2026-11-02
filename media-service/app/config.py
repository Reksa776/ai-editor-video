"""FastAPI media service configuration.

Reads configuration from the environment only. No secrets are hardcoded and no
default password is ever used. If MEDIA_DATABASE_URL is missing, the service
still starts and reports `not_configured` from /health so that the rest of the
foundation can be exercised.

Environment loading:
    `media-service/.env` is loaded explicitly from a path resolved against this
    module (not the current working directory), so `uvicorn app.main:app` works
    the same whether it is started from media-service/ or from the repo root.
    `override=False` keeps shell/CI exports authoritative over file values. A
    missing .env file is silent: every lookup still falls back to the ambient
    process environment and to the defaults below.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# app/config.py -> app/ -> media-service/ -> media-service/.env
ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


def load_env_file() -> bool:
    """Load media-service/.env. Exported variables are never overridden."""
    return load_dotenv(dotenv_path=ENV_FILE, override=False, encoding="utf-8")


load_env_file()


@dataclass(frozen=True)
class Settings:
    app_env: str
    media_database_url: str | None
    project_storage_path: str
    worker_concurrency: int
    host: str
    port: int

    @property
    def database_configured(self) -> bool:
        return bool(self.media_database_url)


def load_settings() -> Settings:
    database_url = os.getenv("MEDIA_DATABASE_URL")
    if database_url is not None:
        database_url = database_url.strip() or None

    return Settings(
        app_env=os.getenv("APP_ENV", "development"),
        media_database_url=database_url,
        project_storage_path=os.getenv("PROJECT_STORAGE_PATH", "../data/projects"),
        worker_concurrency=max(1, int(os.getenv("WORKER_CONCURRENCY", "1"))),
        host=os.getenv("MEDIA_HOST", "127.0.0.1"),
        port=int(os.getenv("MEDIA_PORT", "8000")),
    )


settings = load_settings()
