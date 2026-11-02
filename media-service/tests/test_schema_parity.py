"""SQLAlchemy <-> Prisma schema parity test.

Prisma Migrate owns the schema; these models only describe it. This test fails
loudly if the two drift apart (renamed column, wrong length, wrong type).

Skips when MEDIA_DATABASE_URL is not configured — a skip is honest, a false
pass is not.
"""

from __future__ import annotations

import pytest
from sqlalchemy import inspect

from app.config import settings
from app.database.session import get_engine
from app.models.entities import Asset, Project

pytestmark = pytest.mark.skipif(
    not settings.database_configured,
    reason="MEDIA_DATABASE_URL not configured - schema parity cannot be verified",
)


@pytest.mark.parametrize("model", [Project, Asset])
def test_table_exists(model) -> None:
    inspector = inspect(get_engine())
    assert model.__tablename__ in inspector.get_table_names()


@pytest.fixture(scope="module")
def inspector():
    return inspect(get_engine())


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        (Project, {"id", "name", "status", "settings", "created_at", "updated_at"}),
        (
            Asset,
            {
                "id",
                "project_id",
                "kind",
                "rel_path",
                "filename",
                "mime_type",
                "sha256",
                "bytes",
                "duration_s",
                "probe",
                "created_at",
            },
        ),
    ],
)
def test_columns_match_prisma_schema(inspector, model, expected) -> None:
    actual = {column["name"] for column in inspector.get_columns(model.__tablename__)}
    assert actual == expected, f"column drift in {model.__tablename__}: {actual ^ expected}"


def test_long_path_column_is_not_truncated(inspector) -> None:
    columns = {c["name"]: c for c in inspector.get_columns("assets")}
    # Prisma's String default is VARCHAR(191); rel_path must be VarChar(500).
    assert columns["rel_path"]["type"].length == 500
