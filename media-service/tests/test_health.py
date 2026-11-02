"""Health endpoint tests. Require no database."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_liveness_reports_ok() -> None:
    response = client.get("/api/health")
    assert response.status_code == 200

    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "media-service"
    assert body["database"] in {"configured", "not_configured"}
    assert body["worker_concurrency"] >= 1


def test_db_readiness_is_503_without_credentials(monkeypatch) -> None:
    from app.config import settings

    monkeypatch.setattr(
        "app.api.health.settings",
        type(settings)(**{**settings.__dict__, "media_database_url": None}),
    )

    response = client.get("/api/health/db")
    assert response.status_code == 503
    assert response.json()["status"] == "not_configured"


def test_root_lists_endpoints() -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["health"] == "/api/health"
