"""Deployment configuration contracts that protect production schema safety."""

import json
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def test_railway_runs_migrations_before_deploying_application() -> None:
    config = json.loads((REPOSITORY_ROOT / "railway.json").read_text())

    assert config["deploy"]["preDeployCommand"] == ["alembic upgrade head"]


def test_railway_config_changes_trigger_deployment() -> None:
    config = json.loads((REPOSITORY_ROOT / "railway.json").read_text())

    assert "/backend/**" in config["build"]["watchPatterns"]
    assert "/railway.json" in config["build"]["watchPatterns"]


def test_railway_uses_repository_dockerfile() -> None:
    config = json.loads((REPOSITORY_ROOT / "railway.json").read_text())

    assert config["build"]["builder"] == "DOCKERFILE"
    assert config["build"]["dockerfilePath"] == "/Dockerfile"
