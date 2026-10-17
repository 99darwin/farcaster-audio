"""In-process fake for the Hypersnap read client.

Installs a real ``HypersnapClient`` backed by ``httpx.MockTransport`` so tests
exercise the client's error mapping (404 -> ``HypersnapNotFound``, 5xx ->
``HypersnapUpstreamError``) instead of mocking it away. Routes are keyed by
the full request path (``/v2/farcaster/feed/following``,
``/v1/reactionsByFid``); unrouted paths answer with an empty object, which
also means viewer hydration finds no reactions/follows by default.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest

from app.clients import hypersnap

FAKE_BASE_URL = "https://hypersnap.test"
V2 = "/v2/farcaster"

RouteResult = dict | tuple[int, dict]
RouteHandler = Callable[[dict[str, str]], RouteResult]


@dataclass
class RecordedCall:
    path: str
    params: dict[str, str]


@dataclass
class FakeHypersnap:
    routes: dict[str, RouteResult | RouteHandler] = field(default_factory=dict)
    calls: list[RecordedCall] = field(default_factory=list)

    def route(self, path: str, result: RouteResult | RouteHandler) -> None:
        self.routes[path] = result

    def calls_to(self, path: str) -> list[RecordedCall]:
        return [call for call in self.calls if call.path == path]

    def handle(self, request: httpx.Request) -> httpx.Response:
        params = dict(request.url.params)
        self.calls.append(RecordedCall(path=request.url.path, params=params))
        result = self.routes.get(request.url.path, {})
        if callable(result):
            result = result(params)
        status, body = result if isinstance(result, tuple) else (200, result)
        return httpx.Response(
            status,
            content=json.dumps(body).encode(),
            headers={"content-type": "application/json"},
        )

    def install(self) -> hypersnap.HypersnapClient:
        client = hypersnap.HypersnapClient(
            base_url=FAKE_BASE_URL, transport=httpx.MockTransport(self.handle)
        )
        hypersnap.set_client(client)
        return client


@pytest.fixture
async def fake_hypersnap():
    """Route the process-wide Hypersnap client to a fresh ``FakeHypersnap``."""
    fake = FakeHypersnap()
    previous = hypersnap._client
    client = fake.install()
    try:
        yield fake
    finally:
        await client.aclose()
        hypersnap.set_client(previous)


def reactions_by_fid(target_hashes: list[str]) -> dict[str, Any]:
    """Build a ``/v1/reactionsByFid`` body reacting to ``target_hashes``."""
    return {
        "messages": [
            {"data": {"reactionBody": {"targetCastId": {"fid": 1, "hash": h}}}}
            for h in target_hashes
        ],
        "nextPageToken": "",
    }
