"""M8: query strings and upstream URLs stay out of logs and Sentry."""

import logging

from app import log_redaction
from app.log_redaction import (
    AccessLogQueryRedactor,
    configure_log_redaction,
    sentry_before_breadcrumb,
    sentry_before_send,
    strip_query,
)


def _access_record(path: str) -> logging.LogRecord:
    return logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        0,
        '%s - "%s %s HTTP/%s" %d',
        ("1.2.3.4:5", "GET", path, "1.1", 200),
        None,
    )


def test_access_log_drops_query_for_messages_paths():
    record = _access_record("/v1/messages/search?q=secret+crush&cursor=abc")
    assert AccessLogQueryRedactor().filter(record) is True
    assert record.getMessage() == '1.2.3.4:5 - "GET /v1/messages/search HTTP/1.1" 200'


def test_access_log_keeps_other_paths_and_lookalikes():
    for path in ("/v1/feed?cursor=1", "/v1/messagesfoo?q=1"):
        record = _access_record(path)
        AccessLogQueryRedactor().filter(record)
        assert path in record.getMessage()


def test_access_filter_tolerates_unexpected_args():
    record = logging.LogRecord("uvicorn.access", 20, __file__, 0, "plain", None, None)
    assert AccessLogQueryRedactor().filter(record) is True


def test_configure_quiets_http_loggers_and_is_idempotent():
    configure_log_redaction()
    configure_log_redaction()
    for name in log_redaction.QUIET_HTTP_LOGGERS:
        assert logging.getLogger(name).level == logging.WARNING
    filters = logging.getLogger("uvicorn.access").filters
    assert sum(isinstance(f, AccessLogQueryRedactor) for f in filters) == 1


def test_strip_query():
    assert (
        strip_query("https://client.farcaster.xyz/v2/search?q=x#frag")
        == "https://client.farcaster.xyz/v2/search"
    )


def test_breadcrumb_query_is_stripped_for_http_crumbs():
    crumb = {
        "category": "httplib",
        "data": {
            "url": "https://client.farcaster.xyz/v2/direct-cast-search?q=alice",
            "http.query": "q=alice",
            "http.fragment": "x",
            "method": "GET",
        },
    }
    out = sentry_before_breadcrumb(crumb, None)
    assert out["data"] == {
        "url": "https://client.farcaster.xyz/v2/direct-cast-search",
        "method": "GET",
    }


def test_non_http_breadcrumb_untouched():
    crumb = {"category": "query", "message": "SELECT 1"}
    assert sentry_before_breadcrumb(dict(crumb), None) == crumb


def test_before_send_drops_query_for_messages_requests():
    event = {
        "request": {
            "url": "https://your-api-host.example.com/v1/messages/search?q=bob",
            "query_string": "q=bob",
        }
    }
    out = sentry_before_send(event, None)
    assert "query_string" not in out["request"]
    assert out["request"]["url"] == "https://your-api-host.example.com/v1/messages/search"


def test_before_send_keeps_other_requests():
    event = {
        "request": {"url": "https://your-api-host.example.com/v1/feed?c=1", "query_string": "c=1"}
    }
    assert sentry_before_send(event, None)["request"]["query_string"] == "c=1"
