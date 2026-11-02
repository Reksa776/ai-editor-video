"""Declarative base for read-only SQLAlchemy models.

These models mirror the Prisma schema. Prisma Migrate owns all DDL; this file
exists only so FastAPI can query and (on media-owned tables) write rows.
"""

from __future__ import annotations

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Base class for all ORM models mapped onto Prisma-managed tables."""
