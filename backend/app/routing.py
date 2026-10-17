"""Shared ``APIRoute`` subclasses."""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

# Keys of a FastAPI/Pydantic error entry that are safe to return. ``input``
# (the submitted value) and ``ctx`` (may hold it, or the raised exception)
# are dropped: on credential routes they would echo signatures and tokens.
SAFE_VALIDATION_ERROR_KEYS = ("type", "loc", "msg")


def redact_validation_errors(exc: RequestValidationError) -> list[dict[str, Any]]:
    return [
        {key: error[key] for key in SAFE_VALIDATION_ERROR_KEYS if key in error}
        for error in exc.errors()
    ]


class RedactedValidationRoute(APIRoute):
    """422s keep FastAPI's shape (``{"detail": [{type, loc, msg}]}``) but
    never echo submitted values. Use on any router whose bodies carry
    signatures, tokens or private message text."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def handle(request: Request) -> Response:
            try:
                return await handler(request)
            except RequestValidationError as exc:
                return JSONResponse(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    content={"detail": redact_validation_errors(exc)},
                )

        return handle
