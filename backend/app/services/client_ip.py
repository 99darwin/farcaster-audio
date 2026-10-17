"""Proxy-aware client IP: the single source of truth for rate-limit keys.

Forwarding headers (``X-Forwarded-For`` / ``X-Real-IP``) are attacker
controlled unless they were written by a proxy we trust. So they are read
ONLY when the socket peer (``request.client.host``) is inside
``TRUSTED_PROXY_IPS``; otherwise the socket peer itself is the client.

Deployment assumptions (see ``docs/backend-network-limits.md``):

* Production runs on Railway (``railway.json`` -> ``/Dockerfile`` -> bare
  ``uvicorn``, no nginx). Railway's edge proxy reaches the container over
  Railway's private network, so the socket peer is a non-public address
  and the edge appends the real client to ``X-Forwarded-For`` / sets
  ``X-Real-IP``.
* ``backend/docker-compose.prod.yml`` fronts the API with ``nginx.conf``
  (separate container on the Docker bridge, ``172.16.0.0/12``), which sets
  ``X-Real-IP $remote_addr`` and appends via ``$proxy_add_x_forwarded_for``.

The default trust set (loopback, RFC 1918, Railway's ``100.0.0.0/8``
proxy range, IPv6 ULA) keeps both working without configuration. In both
deployments nothing but the fronting proxy can reach the container's
socket, so no internet client can choose its own rate-limit bucket. Operators narrow the set with
``TRUSTED_PROXY_IPS`` (comma-separated CIDRs) or disable header trust with
``TRUSTED_PROXY_IPS=none`` when the API is exposed directly.

Resolution when the peer is trusted: walk ``X-Forwarded-For`` from the
right, skipping trusted hops; the first untrusted address is the client
(entries to its left are client-supplied and ignored). If every hop is
trusted or the header is absent/invalid, fall back to ``X-Real-IP``, then
to the peer.
"""

from __future__ import annotations

import ipaddress
import logging
from collections.abc import Iterable
from functools import lru_cache

from starlette.requests import HTTPConnection

from app.config import PRODUCTION_ENVIRONMENT, settings

logger = logging.getLogger(__name__)

UNKNOWN_CLIENT_IP = "unknown"
TRUST_NONE_SENTINEL = "none"
FORWARDED_FOR_HEADER = "x-forwarded-for"
REAL_IP_HEADER = "x-real-ip"
# Bound header parsing work: a legitimate chain is a handful of hops.
MAX_FORWARDED_HOPS = 16
# An IPv6 client controls at least a /64, so per-address keys are trivially
# rotated. IPv6 clients are bucketed by their /64.
IPV6_CLIENT_PREFIX_LENGTH = 64

# Ranges a fronting proxy connects from. In the supported deployments only
# that proxy can reach the container's socket, so trusting these cannot let
# an internet client spoof its address. (Exposing the API directly? Set
# ``TRUSTED_PROXY_IPS=none``.)
DEFAULT_TRUSTED_PROXY_CIDRS: tuple[str, ...] = (
    "127.0.0.0/8",  # loopback (same-host proxy, uvicorn --proxy-headers)
    "10.0.0.0/8",  # RFC 1918
    "172.16.0.0/12",  # RFC 1918 (Docker bridge: docker-compose.prod.yml)
    "192.168.0.0/16",  # RFC 1918
    # Railway's edge proxies connect from 100.0.0.0/8 (Railway's published
    # guidance; superset of RFC 6598 CGNAT 100.64/10). Missing it would put
    # every Railway user in the edge's single rate-limit bucket.
    "100.0.0.0/8",
    "::1/128",  # IPv6 loopback
    "fc00::/7",  # IPv6 ULA (Railway private networking is fd12::/16)
)

IPNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network
IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address

_untrusted_header_warning_emitted = False


class TrustedProxyConfigError(ValueError):
    """``TRUSTED_PROXY_IPS`` contains an entry that is not a valid CIDR."""


def parse_trusted_proxies(raw: str) -> tuple[IPNetwork, ...]:
    """Parse a ``TRUSTED_PROXY_IPS`` value.

    Empty -> :data:`DEFAULT_TRUSTED_PROXY_CIDRS`; ``none`` -> trust nobody;
    otherwise comma-separated CIDRs or bare addresses. Raises
    :class:`TrustedProxyConfigError` on an invalid entry so a typo cannot
    silently widen or drop trust.
    """
    value = raw.strip()
    if not value:
        return _parse_networks(DEFAULT_TRUSTED_PROXY_CIDRS)
    if value.lower() == TRUST_NONE_SENTINEL:
        return ()
    return _parse_networks(part.strip() for part in value.split(",") if part.strip())


def _parse_networks(entries: Iterable[str]) -> tuple[IPNetwork, ...]:
    networks: list[IPNetwork] = []
    for entry in entries:
        try:
            networks.append(ipaddress.ip_network(entry, strict=False))
        except ValueError as exc:
            raise TrustedProxyConfigError(
                f"TRUSTED_PROXY_IPS entry is not a valid CIDR: {entry!r}"
            ) from exc
    return tuple(networks)


@lru_cache(maxsize=8)
def _trusted_networks(raw: str) -> tuple[IPNetwork, ...]:
    return parse_trusted_proxies(raw)


def _parse_ip(value: str | None) -> IPAddress | None:
    if not value:
        return None
    candidate = value.strip()
    # ``[v6]:port`` / ``v4:port`` forms some proxies emit.
    if candidate.startswith("[") and "]" in candidate:
        candidate = candidate[1 : candidate.index("]")]
    elif candidate.count(":") == 1:
        candidate = candidate.split(":", 1)[0]
    try:
        address = ipaddress.ip_address(candidate)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        return address.ipv4_mapped
    return address


def _is_trusted(address: IPAddress, networks: tuple[IPNetwork, ...]) -> bool:
    return any(address in network for network in networks)


def _from_forwarded_for(
    header_value: str, networks: tuple[IPNetwork, ...]
) -> IPAddress | None:
    """Rightmost untrusted ``X-Forwarded-For`` hop, or ``None``."""
    hops = [hop for hop in header_value.split(",") if hop.strip()]
    for raw_hop in reversed(hops[-MAX_FORWARDED_HOPS:]):
        address = _parse_ip(raw_hop)
        if address is None:
            # Garbage in the chain: we can't tell who wrote what to its left.
            return None
        if not _is_trusted(address, networks):
            return address
    return None


def _warn_untrusted_forwarding_once(peer: str) -> None:
    """Flag a likely misconfiguration (proxy outside the trust set) once."""
    global _untrusted_header_warning_emitted
    if _untrusted_header_warning_emitted:
        return
    _untrusted_header_warning_emitted = True
    logger.warning(
        "[client-ip] untrusted peer %s sent forwarding headers; ignoring them. "
        "If this peer is your reverse proxy, add its range to TRUSTED_PROXY_IPS "
        "or every client will share one rate-limit bucket.",
        peer,
    )


def _bucket(address: IPAddress) -> str:
    """Rate-limit identity: the address for IPv4, its ``/64`` for IPv6."""
    if isinstance(address, ipaddress.IPv6Address):
        network = ipaddress.ip_network(
            (address, IPV6_CLIENT_PREFIX_LENGTH), strict=False
        )
        return str(network)
    return str(address)


def client_ip(conn: HTTPConnection) -> str:
    """Client identity to key rate limits / dedupe on (``"unknown"`` if none).

    An IPv4 address, or an IPv6 client's ``/64`` network (e.g.
    ``2001:db8::/64``). Accepts a ``Request`` or ``WebSocket``.
    """
    peer_host = conn.client.host if conn.client and conn.client.host else None
    if peer_host is None:
        return UNKNOWN_CLIENT_IP
    peer = _parse_ip(peer_host)
    networks = _trusted_networks(settings.TRUSTED_PROXY_IPS)
    if peer is None or not _is_trusted(peer, networks):
        if conn.headers.get(FORWARDED_FOR_HEADER) or conn.headers.get(REAL_IP_HEADER):
            _warn_untrusted_forwarding_once(peer_host)
        return _bucket(peer) if peer is not None else peer_host

    forwarded = _from_forwarded_for(
        conn.headers.get(FORWARDED_FOR_HEADER, ""), networks
    )
    if forwarded is not None:
        return _bucket(forwarded)
    real_ip = _parse_ip(conn.headers.get(REAL_IP_HEADER))
    if real_ip is not None:
        return _bucket(real_ip)
    return _bucket(peer)


def check_trusted_proxy_config() -> None:
    """Validate ``TRUSTED_PROXY_IPS`` at startup and warn in production when
    it is unset (running on the built-in private-range default).

    Invalid values raise (fail fast on typos); an unset value only warns so a
    missing env var never takes production down.
    """
    networks = _trusted_networks(settings.TRUSTED_PROXY_IPS)
    if settings.ENVIRONMENT != PRODUCTION_ENVIRONMENT:
        return
    if not settings.TRUSTED_PROXY_IPS.strip():
        logger.warning(
            "[client-ip] TRUSTED_PROXY_IPS is unset; trusting forwarding headers "
            "only from private/Railway/loopback peers (%s). Set it explicitly to "
            "your edge proxy's ranges.",
            ", ".join(DEFAULT_TRUSTED_PROXY_CIDRS),
        )
    elif not networks:
        logger.warning(
            "[client-ip] TRUSTED_PROXY_IPS=none: forwarding headers are ignored; "
            "behind a reverse proxy every client shares one rate-limit bucket."
        )
