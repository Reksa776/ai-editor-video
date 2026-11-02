"""Read-only mappings for Prisma-managed Phase 1 tables.

Column names, types, and lengths must match `prisma/schema.prisma` exactly.
`tests/test_schema_parity.py` asserts this against information_schema.

Ownership reminder (one writer per table):
  - `projects` / `assets` are WRITTEN by the Next.js service only.
  - The media service reads them.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import CHAR, BigInteger, Enum, ForeignKey, JSON, Numeric, String
from sqlalchemy.dialects.mysql import DATETIME
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base

PROJECT_STATUS = ("active", "archived")
ASSET_KIND = ("source", "derived", "preview", "export", "audio", "subtitle")


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(CHAR(26), primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(
        Enum(*PROJECT_STATUS, name="ProjectStatus"), nullable=False, default="active"
    )
    settings: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # DATETIME(3) from the MySQL dialect: millisecond precision, matching
    # Prisma's `@db.DateTime(3)`. The generic DateTime has no fsp argument.
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=3), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DATETIME(fsp=3), nullable=False)

    assets: Mapped[list["Asset"]] = relationship(back_populates="project")


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[str] = mapped_column(CHAR(26), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        CHAR(26), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(
        Enum(*ASSET_KIND, name="AssetKind"), nullable=False, default="source"
    )
    rel_path: Mapped[str] = mapped_column(String(500), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(100), nullable=False)
    sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    duration_s: Mapped[Decimal | None] = mapped_column(Numeric(10, 3), nullable=True)
    probe: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=3), nullable=False)

    project: Mapped[Project] = relationship(back_populates="assets")
