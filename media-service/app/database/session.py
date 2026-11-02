"""SQLAlchemy 2.x database session for the media service.

The media service is a QUERY-ONLY consumer of the schema owned by Prisma
Migrate. It must never create or alter tables:
  - no `Base.metadata.create_all()`
  - no Alembic
  - no DDL of any kind

Connection pool deliberately small (this host has ~7 GB RAM):
  pool_size=3, max_overflow=2  -> at most 5 connections from this process.
"""

from __future__ import annotations

from collections.abc import Iterator
from functools import lru_cache

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings


@lru_cache(maxsize=1)
def get_engine() -> Engine:
    """Create the engine lazily so the app boots without database credentials."""
    if not settings.media_database_url:
        raise RuntimeError(
            "MEDIA_DATABASE_URL is not set. Copy media-service/.env.example to "
            "media-service/.env and add the aivideo_media credentials."
        )

    return create_engine(
        settings.media_database_url,
        pool_size=3,
        max_overflow=2,
        pool_recycle=1800,
        pool_pre_ping=True,
        pool_timeout=10,
        future=True,
    )


@lru_cache(maxsize=1)
def get_session_factory() -> sessionmaker[Session]:
    return sessionmaker(bind=get_engine(), autoflush=False, expire_on_commit=False)


def get_session() -> Iterator[Session]:
    """FastAPI dependency. Raises if the database is not configured."""
    session = get_session_factory()()
    try:
        yield session
    finally:
        session.close()
