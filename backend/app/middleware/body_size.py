"""ASGI request-body size cap with per-path-prefix limits.

Rejects an oversized body with 413 before the app buffers or spools it:
immediately when ``Content-Length`` declares too much, and mid-stream (for
chunked or lying clients) as soon as the received bytes pass the limit.
Route-level caps (e.g. webhook handlers) may be tighter; this is the
global ceiling.
"""

from __future__ import annotations

from collections.abc import Mapping

from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

MEGABYTE = 1024 * 1024
DEFAULT_MAX_BODY_BYTES = 2 * MEGABYTE
# Media uploads allow a 50 MB video plus multipart framing overhead.
MEDIA_UPLOAD_MAX_BODY_BYTES = 51 * MEGABYTE

# Longest matching prefix wins. Webhook routes stay on the default ceiling
# here; their handlers enforce their own, tighter caps.
DEFAULT_PATH_LIMITS: Mapping[str, int] = {
    "/v1/media/upload": MEDIA_UPLOAD_MAX_BODY_BYTES,
}

PAYLOAD_TOO_LARGE_STATUS = 413
PAYLOAD_TOO_LARGE_DETAIL = "Request body too large"


class _BodyTooLarge(HTTPException):
    """Raised from ``receive`` once the streamed body passes the limit.

    An ``HTTPException`` so FastAPI's body parsing re-raises it untouched
    and the exception middleware answers 413.
    """

    def __init__(self) -> None:
        super().__init__(
            status_code=PAYLOAD_TOO_LARGE_STATUS,
            detail=PAYLOAD_TOO_LARGE_DETAIL,
            # Without this the server keeps draining the rest of the body.
            headers={"Connection": "close"},
        )


class BodySizeLimitMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        *,
        default_limit: int = DEFAULT_MAX_BODY_BYTES,
        path_limits: Mapping[str, int] = DEFAULT_PATH_LIMITS,
    ) -> None:
        self.app = app
        self.default_limit = default_limit
        # Longest prefix first so the first match is the most specific.
        self.path_limits = sorted(
            path_limits.items(), key=lambda item: len(item[0]), reverse=True
        )

    def limit_for(self, path: str) -> int:
        for prefix, limit in self.path_limits:
            if path == prefix or path.startswith(prefix.rstrip("/") + "/"):
                return limit
        return self.default_limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        limit = self.limit_for(scope.get("path", ""))
        declared = _declared_length(scope)
        if declared is not None and declared > limit:
            await _reject(scope, receive, send)
            return

        received = 0
        response_started = False

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise _BodyTooLarge()
            return message

        async def tracking_send(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except _BodyTooLarge:
            # Reached only when nothing between here and the read converted
            # it into a response; answer if we still can.
            if response_started:
                raise
            await _reject(scope, receive, send)


def _declared_length(scope: Scope) -> int | None:
    for name, value in scope.get("headers", []):
        if name == b"content-length":
            try:
                return int(value)
            except ValueError:
                return None
    return None


async def _reject(scope: Scope, receive: Receive, send: Send) -> None:
    response = JSONResponse(
        {"detail": PAYLOAD_TOO_LARGE_DETAIL},
        status_code=PAYLOAD_TOO_LARGE_STATUS,
        headers={"Connection": "close"},
    )
    await response(scope, receive, send)
