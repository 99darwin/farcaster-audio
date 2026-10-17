"""Global request-body cap and the auth-before-body media upload."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi import FastAPI, Request
from jose import jwt

from app.config import settings
from app.middleware.body_size import (
    DEFAULT_MAX_BODY_BYTES,
    MEDIA_UPLOAD_MAX_BODY_BYTES,
    BodySizeLimitMiddleware,
)
from app.routers import media
from tests.direct_cast_fake import FakeRedis

FID = 4242


async def _call(
    app: Any,
    *,
    method: str = "POST",
    path: str,
    headers: dict[str, str] | None = None,
    chunks: list[bytes] = (b"",),
) -> tuple[int, dict, int]:
    """Drive ``app`` over raw ASGI. Returns (status, json body, chunks read)."""
    pending = list(chunks)
    reads = 0
    sent: list[dict] = []

    async def receive() -> dict:
        nonlocal reads
        if not pending:
            return {"type": "http.disconnect"}
        reads += 1
        body = pending.pop(0)
        return {"type": "http.request", "body": body, "more_body": bool(pending)}

    async def send(message: dict) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [
            (k.lower().encode(), v.encode()) for k, v in (headers or {}).items()
        ],
        "client": ("127.0.0.1", 5000),
        "server": ("test", 80),
        "app": app,
    }
    await app(scope, receive, send)
    start = next(m for m in sent if m["type"] == "http.response.start")
    body = b"".join(
        m.get("body", b"") for m in sent if m["type"] == "http.response.body"
    )
    return start["status"], (json.loads(body) if body else {}), reads


def _echo_app() -> BodySizeLimitMiddleware:
    inner = FastAPI()

    @inner.post("/{path:path}")
    async def echo(request: Request) -> dict[str, int]:
        return {"size": len(await request.body())}

    return BodySizeLimitMiddleware(inner, default_limit=10, path_limits={"/big": 100})


# --- BodySizeLimitMiddleware -----------------------------------------------


async def test_declared_oversize_body_rejected_before_reading():
    status, body, reads = await _call(
        _echo_app(), path="/x", headers={"content-length": "11"}, chunks=[b"x" * 11]
    )
    assert status == 413
    assert body == {"detail": "Request body too large"}
    assert reads == 0


async def test_streamed_oversize_body_without_length_is_cut_off():
    status, _, reads = await _call(
        _echo_app(), path="/x", chunks=[b"x" * 6, b"x" * 6, b"x" * 6, b"x" * 6]
    )
    assert status == 413
    assert reads == 2  # stopped as soon as the running total passed 10


async def test_streamed_oversize_413_closes_the_connection():
    """Connection: close so the server stops draining the oversized body."""
    sent: list[dict] = []
    chunks = [b"x" * 6] * 4

    async def receive() -> dict:
        body = chunks.pop(0)
        return {"type": "http.request", "body": body, "more_body": bool(chunks)}

    async def send(message: dict) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/x",
        "raw_path": b"/x",
        "query_string": b"",
        "root_path": "",
        "headers": [],
        "client": ("127.0.0.1", 5000),
        "server": ("test", 80),
    }
    await _echo_app()(scope, receive, send)
    start = next(m for m in sent if m["type"] == "http.response.start")
    assert start["status"] == 413
    assert (b"connection", b"close") in start["headers"]


async def test_body_within_limit_passes():
    status, body, _ = await _call(_echo_app(), path="/x", chunks=[b"x" * 10])
    assert (status, body) == (200, {"size": 10})


async def test_prefix_limit_applies_to_subpaths_only():
    app = _echo_app()
    assert (await _call(app, path="/big", chunks=[b"x" * 50]))[0] == 200
    assert (await _call(app, path="/big/sub", chunks=[b"x" * 50]))[0] == 200
    assert (await _call(app, path="/bigger", chunks=[b"x" * 50]))[0] == 413


def test_limit_lookup_on_production_defaults():
    middleware = BodySizeLimitMiddleware(FastAPI())
    assert middleware.limit_for("/v1/media/upload") == MEDIA_UPLOAD_MAX_BODY_BYTES
    assert middleware.limit_for("/v1/feed/cast") == DEFAULT_MAX_BODY_BYTES


async def test_main_app_caps_ordinary_routes():
    from app.main import app

    status, _, reads = await _call(
        app,
        path="/v1/feed/cast",
        headers={"content-length": str(DEFAULT_MAX_BODY_BYTES + 1)},
    )
    assert status == 413
    assert reads == 0


# --- Media upload: auth + rate limit before the body -----------------------


def _bearer(fid: int = FID) -> str:
    token = jwt.encode(
        {"fid": fid, "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return f"Bearer {token}"


def _multipart(content: bytes, *, field: str = "file") -> tuple[str, bytes]:
    boundary = "testboundary"
    body = (
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{field}"; filename="a.png"\r\n'
            "Content-Type: image/png\r\n\r\n"
        ).encode()
        + content
        + f"\r\n--{boundary}--\r\n".encode()
    )
    return f"multipart/form-data; boundary={boundary}", body


@pytest.fixture
def media_env(monkeypatch):
    from app.main import app

    redis = FakeRedis()
    previous = getattr(app.state, "redis", None)
    app.state.redis = redis
    monkeypatch.setattr(settings, "CLOUDINARY_CLOUD_NAME", "demo")
    forwarded: list[tuple[bytes, int]] = []

    async def fake_forward(file, fid):
        forwarded.append((await file.read(), fid))
        return {"url": "https://example.test/a.png"}

    monkeypatch.setattr(media, "_forward_upload", fake_forward)
    try:
        yield app, redis, forwarded
    finally:
        app.state.redis = previous


async def test_unauthenticated_upload_is_rejected_without_reading_body(media_env):
    app, _, forwarded = media_env
    content_type, body = _multipart(b"x" * 1024)
    status, _, reads = await _call(
        app,
        path="/v1/media/upload",
        headers={"content-type": content_type, "content-length": str(len(body))},
        chunks=[body],
    )
    assert status in (401, 403)
    assert reads == 0
    assert forwarded == []


async def test_rate_limited_upload_is_rejected_without_reading_body(media_env):
    app, redis, forwarded = media_env
    template, rule = media.UPLOAD_RATE_LIMITS[0]
    redis.store[template.format(fid=FID)] = (rule.limit, None)
    content_type, body = _multipart(b"x")
    status, detail, reads = await _call(
        app,
        path="/v1/media/upload",
        headers={"authorization": _bearer(), "content-type": content_type},
        chunks=[body],
    )
    assert status == 429
    assert detail == {"detail": "Upload rate limit exceeded. Try again later."}
    assert reads == 0
    assert forwarded == []


async def test_authenticated_upload_reads_file_part(media_env):
    app, _, forwarded = media_env
    content_type, body = _multipart(b"PNGDATA")
    status, detail, _ = await _call(
        app,
        path="/v1/media/upload",
        headers={"authorization": _bearer(), "content-type": content_type},
        chunks=[body],
    )
    assert (status, detail) == (200, {"url": "https://example.test/a.png"})
    assert forwarded == [(b"PNGDATA", FID)]


async def test_streamed_oversize_upload_is_413_not_400(media_env, monkeypatch):
    """The cap's 413 raised mid-parse must not be rewrapped as a 400."""
    app, _, forwarded = media_env
    for middleware in app.user_middleware:
        if middleware.cls is BodySizeLimitMiddleware:
            break
    stack = app.middleware_stack
    app.middleware_stack = None
    monkeypatch.setitem(middleware.kwargs, "path_limits", {"/v1/media/upload": 64})
    try:
        content_type, body = _multipart(b"x" * 500)
        status, detail, _ = await _call(
            app,
            path="/v1/media/upload",
            headers={"authorization": _bearer(), "content-type": content_type},
            chunks=[body[i : i + 50] for i in range(0, len(body), 50)],
        )
    finally:
        app.middleware_stack = stack
    assert status == 413
    assert detail == {"detail": "Request body too large"}
    assert forwarded == []


async def test_upload_without_file_part_is_422(media_env):
    app, _, forwarded = media_env
    content_type, body = _multipart(b"x", field="other")
    status, _, _ = await _call(
        app,
        path="/v1/media/upload",
        headers={"authorization": _bearer(), "content-type": content_type},
        chunks=[body],
    )
    assert status == 422
    assert forwarded == []


async def test_non_multipart_upload_is_422(media_env):
    app, _, _ = media_env
    status, _, _ = await _call(
        app,
        path="/v1/media/upload",
        headers={"authorization": _bearer(), "content-type": "application/json"},
        chunks=[b"{}"],
    )
    assert status == 422
