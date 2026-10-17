"""Proxy-aware client IP resolution (``app.services.client_ip``)."""

import logging

import pytest
from starlette.requests import Request
from starlette.websockets import WebSocket

from app.config import settings
from app.services import client_ip as client_ip_module
from app.services.client_ip import (
    TrustedProxyConfigError,
    check_trusted_proxy_config,
    client_ip,
    parse_trusted_proxies,
)

RAILWAY_EDGE = "100.64.0.7"  # CGNAT-range private peer
RAILWAY_EDGE_NON_CGNAT = "100.20.4.1"  # in Railway's 100/8 but outside 100.64/10
NGINX_PEER = "172.18.0.3"  # docker-compose bridge
PUBLIC_PEER = "198.51.100.20"
REAL_CLIENT = "203.0.113.9"


def _scope(peer: str | None, headers: dict[str, str], kind: str = "http") -> dict:
    return {
        "type": kind,
        "path": "/",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "client": (peer, 1234) if peer is not None else None,
    }


def _request(peer: str | None, **headers: str) -> Request:
    return Request(_scope(peer, {k.replace("_", "-"): v for k, v in headers.items()}))


@pytest.fixture(autouse=True)
def _default_trust(monkeypatch):
    monkeypatch.setattr(settings, "TRUSTED_PROXY_IPS", "")
    monkeypatch.setattr(client_ip_module, "_untrusted_header_warning_emitted", False)


# --- Untrusted peers: headers are never honoured ---------------------------


def test_public_peer_cannot_spoof_via_forwarded_for():
    req = _request(PUBLIC_PEER, x_forwarded_for="1.1.1.1", x_real_ip="2.2.2.2")
    assert client_ip(req) == PUBLIC_PEER


def test_untrusted_forwarding_headers_warn_once(caplog):
    caplog.set_level(logging.WARNING, logger="app.services.client_ip")
    client_ip(_request(PUBLIC_PEER, x_forwarded_for="1.1.1.1"))
    client_ip(_request(PUBLIC_PEER, x_forwarded_for="1.1.1.1"))
    assert caplog.text.count("untrusted peer") == 1


def test_trust_none_ignores_headers_even_from_private_peer(monkeypatch):
    monkeypatch.setattr(settings, "TRUSTED_PROXY_IPS", "none")
    assert client_ip(_request(RAILWAY_EDGE, x_forwarded_for=REAL_CLIENT)) == (
        RAILWAY_EDGE
    )


# --- Trusted peers (the production shapes) ---------------------------------


def test_railway_edge_peer_uses_appended_client():
    """Railway appends the real client to whatever the client sent."""
    req = _request(RAILWAY_EDGE, x_forwarded_for=f"6.6.6.6, {REAL_CLIENT}")
    assert client_ip(req) == REAL_CLIENT


def test_rotating_forged_leftmost_entries_does_not_change_bucket():
    keys = {
        client_ip(_request(RAILWAY_EDGE, x_forwarded_for=f"{fake}, {REAL_CLIENT}"))
        for fake in ("1.1.1.1", "2.2.2.2", "3.3.3.3")
    }
    assert keys == {REAL_CLIENT}


def test_distinct_clients_behind_the_edge_get_distinct_buckets():
    """The regression this PR fixes: not everyone sharing the edge's IP."""
    a = client_ip(_request(RAILWAY_EDGE, x_forwarded_for="203.0.113.1"))
    b = client_ip(_request(RAILWAY_EDGE, x_forwarded_for="203.0.113.2"))
    assert a != b
    assert RAILWAY_EDGE not in (a, b)


def test_railway_proxy_range_outside_cgnat_is_trusted():
    """Railway's edge connects from 100.0.0.0/8, not only CGNAT 100.64/10."""
    req = _request(RAILWAY_EDGE_NON_CGNAT, x_forwarded_for=REAL_CLIENT)
    assert client_ip(req) == REAL_CLIENT


def test_ipv6_clients_share_a_bucket_per_64():
    keys = {
        client_ip(_request(RAILWAY_EDGE, x_forwarded_for=f"2001:db8:1:2::{n:x}"))
        for n in range(1, 50)
    }
    assert keys == {"2001:db8:1:2::/64"}
    other = client_ip(_request(RAILWAY_EDGE, x_forwarded_for="2001:db8:1:3::1"))
    assert other == "2001:db8:1:3::/64"


def test_untrusted_ipv6_peer_is_bucketed_per_64():
    assert client_ip(_request("2001:db8:aa:bb::7")) == "2001:db8:aa:bb::/64"


def test_trusted_intermediate_hops_are_skipped():
    req = _request(NGINX_PEER, x_forwarded_for=f"{REAL_CLIENT}, 10.0.0.5, 172.18.0.9")
    assert client_ip(req) == REAL_CLIENT


def test_nginx_real_ip_used_when_no_forwarded_for():
    assert client_ip(_request(NGINX_PEER, x_real_ip=REAL_CLIENT)) == REAL_CLIENT


def test_forwarded_for_wins_over_real_ip():
    req = _request(RAILWAY_EDGE, x_forwarded_for=REAL_CLIENT, x_real_ip="9.9.9.9")
    assert client_ip(req) == REAL_CLIENT


def test_garbage_hop_falls_back_to_real_ip_then_peer():
    req = _request(RAILWAY_EDGE, x_forwarded_for="1.1.1.1, not-an-ip")
    assert client_ip(req) == RAILWAY_EDGE
    req = _request(
        RAILWAY_EDGE, x_forwarded_for="1.1.1.1, not-an-ip", x_real_ip=REAL_CLIENT
    )
    assert client_ip(req) == REAL_CLIENT


def test_whitespace_headers_fall_through_to_peer():
    req = _request(RAILWAY_EDGE, x_forwarded_for="   ", x_real_ip="  ")
    assert client_ip(req) == RAILWAY_EDGE


def test_ports_and_ipv4_mapped_addresses_are_normalised():
    assert client_ip(_request(RAILWAY_EDGE, x_forwarded_for="203.0.113.9:443")) == (
        REAL_CLIENT
    )
    assert client_ip(_request(RAILWAY_EDGE, x_forwarded_for="[2001:db8::1]:443")) == (
        "2001:db8::/64"
    )
    assert client_ip(_request("::ffff:10.0.0.1", x_forwarded_for=REAL_CLIENT)) == (
        REAL_CLIENT
    )


def test_huge_forwarded_chain_is_bounded():
    chain = ", ".join(["10.0.0.1"] * 10_000)
    # Only the last MAX_FORWARDED_HOPS are inspected; all trusted -> peer.
    assert client_ip(_request(RAILWAY_EDGE, x_forwarded_for=chain)) == RAILWAY_EDGE


def test_missing_peer_is_unknown():
    assert client_ip(_request(None, x_forwarded_for=REAL_CLIENT)) == "unknown"


def test_websocket_connections_are_supported():
    ws = WebSocket(
        _scope(RAILWAY_EDGE, {"x-forwarded-for": REAL_CLIENT}, kind="websocket"),
        receive=None,
        send=None,
    )
    assert client_ip(ws) == REAL_CLIENT


def test_explicit_trust_list_narrows_default(monkeypatch):
    monkeypatch.setattr(settings, "TRUSTED_PROXY_IPS", "10.1.0.0/16")
    assert client_ip(_request("10.1.2.3", x_forwarded_for=REAL_CLIENT)) == REAL_CLIENT
    # No longer trusted under the explicit list.
    assert client_ip(_request(RAILWAY_EDGE, x_forwarded_for=REAL_CLIENT)) == (
        RAILWAY_EDGE
    )


# --- Config parsing / startup check ----------------------------------------


def test_parse_trusted_proxies_variants():
    assert len(parse_trusted_proxies("")) == len(
        client_ip_module.DEFAULT_TRUSTED_PROXY_CIDRS
    )
    assert parse_trusted_proxies("NONE") == ()
    assert [str(n) for n in parse_trusted_proxies("10.0.0.1, fd00::/8")] == [
        "10.0.0.1/32",
        "fd00::/8",
    ]


def test_invalid_trusted_proxy_entry_fails_fast(monkeypatch):
    with pytest.raises(TrustedProxyConfigError):
        parse_trusted_proxies("10.0.0.0/8, not-a-cidr")
    monkeypatch.setattr(settings, "TRUSTED_PROXY_IPS", "bogus")
    with pytest.raises(TrustedProxyConfigError):
        check_trusted_proxy_config()


def test_unset_in_production_warns_but_does_not_raise(monkeypatch, caplog):
    caplog.set_level(logging.WARNING, logger="app.services.client_ip")
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    check_trusted_proxy_config()
    assert "TRUSTED_PROXY_IPS is unset" in caplog.text


def test_unset_outside_production_is_silent(monkeypatch, caplog):
    caplog.set_level(logging.WARNING, logger="app.services.client_ip")
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    check_trusted_proxy_config()
    assert caplog.text == ""
