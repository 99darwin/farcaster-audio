"""Keep query strings and upstream URLs out of logs and Sentry.

- httpx/httpcore log every request URL at INFO (upstream URLs can carry
  cursors, ids or credentials), so they are capped at WARNING.
- Uvicorn's access log prints the full request target; for the Direct
  Cast proxy (``/v1/messages/*``) the query names conversations and
  cursors, so it is dropped.
- Sentry's httpx integration records each outbound URL (with its query)
  as a breadcrumb; :func:`sentry_before_breadcrumb` strips the query, and
  :func:`sentry_before_send` drops the inbound query string for
  ``/v1/messages`` events.
"""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlsplit, urlunsplit

QUIET_HTTP_LOGGERS = ("httpx", "httpcore")
REDACTED_QUERY_PATH_PREFIXES = ("/v1/messages",)
UVICORN_ACCESS_LOGGER = "uvicorn.access"
# Uvicorn access record args: (client_addr, method, full_path, version, status)
_ACCESS_ARGS_PATH_INDEX = 2
_SENTRY_HTTP_BREADCRUMB_CATEGORIES = frozenset({"httplib", "http"})
_SENTRY_QUERY_DATA_KEYS = ("http.query", "http.fragment")


def strip_query(url: str) -> str:
    """``url`` without its query string or fragment."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return url.split("?", 1)[0].split("#", 1)[0]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def is_redacted_path(path: str) -> bool:
    return any(
        path == prefix or path.startswith(prefix + "/")
        for prefix in REDACTED_QUERY_PATH_PREFIXES
    )


class AccessLogQueryRedactor(logging.Filter):
    """Drops the query from uvicorn access lines for redacted paths."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if not isinstance(args, tuple) or len(args) <= _ACCESS_ARGS_PATH_INDEX:
            return True
        full_path = args[_ACCESS_ARGS_PATH_INDEX]
        if not isinstance(full_path, str) or "?" not in full_path:
            return True
        path = full_path.split("?", 1)[0]
        if is_redacted_path(path):
            record.args = (
                *args[:_ACCESS_ARGS_PATH_INDEX],
                path,
                *args[_ACCESS_ARGS_PATH_INDEX + 1 :],
            )
        return True


def configure_log_redaction() -> None:
    """Idempotently apply the logger levels and access-log filter."""
    for name in QUIET_HTTP_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
    access_logger = logging.getLogger(UVICORN_ACCESS_LOGGER)
    if not any(isinstance(f, AccessLogQueryRedactor) for f in access_logger.filters):
        access_logger.addFilter(AccessLogQueryRedactor())


def sentry_before_breadcrumb(
    crumb: dict[str, Any], _hint: dict[str, Any] | None
) -> dict[str, Any] | None:
    """Strip the query from outbound-HTTP breadcrumbs."""
    if crumb.get("category") not in _SENTRY_HTTP_BREADCRUMB_CATEGORIES:
        return crumb
    data = crumb.get("data")
    if isinstance(data, dict):
        url = data.get("url")
        if isinstance(url, str):
            data["url"] = strip_query(url)
        for key in _SENTRY_QUERY_DATA_KEYS:
            data.pop(key, None)
    return crumb


def sentry_before_send(
    event: dict[str, Any], _hint: dict[str, Any] | None
) -> dict[str, Any] | None:
    """Drop the inbound query string for ``/v1/messages`` events."""
    request = event.get("request")
    if not isinstance(request, dict):
        return event
    url = request.get("url")
    path = urlsplit(url).path if isinstance(url, str) else ""
    if is_redacted_path(path):
        request.pop("query_string", None)
        request["url"] = strip_query(url)
    return event
