import json
import logging
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import AliasChoices, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_log = logging.getLogger(__name__)

# Module-level cache for parsed recording-agent custody keys.
# Keyed by the raw JSON string so distinct configs (e.g. across test
# fixtures) don't share state, and a process-global config parses
# exactly once.
_RECORDING_AGENT_KEY_CACHE: dict[str, dict[int, str]] = {}

# Look for .env in backend/ dir, then repo root

_backend_dir = Path(__file__).resolve().parent.parent
_env_candidates = [_backend_dir / ".env", _backend_dir.parent / ".env"]
_env_file = next((p for p in _env_candidates if p.exists()), ".env")

PRODUCTION_ENVIRONMENT = "production"
HTTPS_SCHEME = "https"


def require_https_in_production(
    url: str, *, setting_name: str, environment: str
) -> None:
    """Raise ``ValueError`` when ``environment`` is production and ``url`` is
    not an absolute ``https://`` URL. The URL itself is not echoed."""
    if environment != PRODUCTION_ENVIRONMENT:
        return
    parts = urlsplit(url)
    if parts.scheme != HTTPS_SCHEME or not parts.netloc:
        raise ValueError(f"{setting_name} must be an https:// URL in production")


class Settings(BaseSettings):
    # ``hide_input_in_errors``: a failed validation must not echo the raw
    # settings (DB URL, JWT secret, RPC URL with provider key) into logs.
    model_config = SettingsConfigDict(
        env_file=str(_env_file), extra="ignore", hide_input_in_errors=True
    )

    DATABASE_URL: str = Field(
        default="postgresql+asyncpg://dev:dev@localhost:5432/farcaster_audio",
        repr=False,
    )
    REDIS_URL: str = Field(default="redis://localhost:6379", repr=False)
    JWT_SECRET: str = Field(default="change-me-in-production", repr=False)
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRY_HOURS: int = 72
    JWT_REFRESH_EXPIRY_DAYS: int = 30
    NEYNAR_API_KEY: str = Field(default="", repr=False)
    NEYNAR_CLIENT_ID: str = ""
    GIPHY_API_KEY: str = Field(default="", repr=False)
    API_BASE_URL: str = "http://localhost:8000"
    LIVEKIT_API_KEY: str = Field(default="", repr=False)
    LIVEKIT_API_SECRET: str = Field(default="", repr=False)
    LIVEKIT_WS_URL: str = "wss://localhost.livekit.cloud"
    ENVIRONMENT: str = "development"
    CORS_ORIGINS: list[str] = []
    # Expected `domain` field in SIWF (EIP-4361) sign-in messages. Bound at
    # verify time so a SIWE message signed for someone else's app cannot
    # be replayed against this deployment. Operators MUST set this to their
    # own domain(s) — empty disables SIWF login entirely (no message will
    # match the empty allowlist). Accepts a comma-separated allowlist so
    # apex + www variants both work (e.g. "example.com,www.example.com").
    SIWF_DOMAIN: str = ""
    LOG_LEVEL: str = "INFO"
    AWS_S3_BUCKET_NAME: str = ""
    AWS_DEFAULT_REGION: str = "us-east-1"
    AWS_ACCESS_KEY_ID: str = ""
    AWS_SECRET_ACCESS_KEY: str = Field(default="", repr=False)
    # Custom S3-compatible endpoint (e.g. Tigris, Cloudflare R2, MinIO).
    # Leave empty to fall back to AWS default endpoints; set explicitly
    # for non-AWS object storage providers.
    AWS_ENDPOINT_URL: str = ""
    DEEPGRAM_API_KEY: str = Field(default="", repr=False)
    RECORDING_ENABLED: bool = False
    SENTRY_DSN: str = ""
    DEMO_LOGIN_ENABLED: bool = False
    DEMO_CAST_HASH: str = ""
    CLOUDINARY_CLOUD_NAME: str = ""
    CLOUDINARY_API_KEY: str = Field(default="", repr=False)
    CLOUDINARY_API_SECRET: str = Field(default="", repr=False)
    NEYNAR_WEBHOOK_SECRET_CAST: str = ""
    NEYNAR_WEBHOOK_SECRET_REACTION: str = ""
    NEYNAR_WEBHOOK_SECRET_FOLLOW: str = ""
    NEYNAR_WEBHOOK_ID_CAST: str = ""
    NEYNAR_WEBHOOK_ID_REACTION: str = ""
    NEYNAR_WEBHOOK_ID_FOLLOW: str = ""
    JUKEAUDIO_SIGNER_UUID: str = ""
    FARCASTER_APP_MNEMONIC: str = ""
    FARCASTER_APP_FID: int = 0
    MINIAPP_WEBHOOK_SECRET: str = Field(default="", repr=False)
    JUKE_API_KEY_PEPPER: str = ""
    JUKE_API_KEY_ENCRYPTION_KEY: str = Field(default="", repr=False)
    JUKE_API_AUDIT_SECRET: str = Field(default="", repr=False)
    # Dedicated AES-256 key for encrypting managed Farcaster-native bot
    # signer Ed25519 private keys at rest. Single-purpose-secret stance:
    # this is NOT reused from JUKE_API_KEY_ENCRYPTION_KEY so a compromise
    # of the developer-API-key blob cipher can't decrypt bot signing keys
    # (and vice versa). Must decode to exactly 32 bytes (base64url,
    # standard base64, or raw). Empty/unset → managed-signer provisioning
    # and bearer minting fail closed with an opaque 503. NEVER log this
    # value, NEVER include it in error messages or responses.
    JUKE_BOT_SIGNER_ENCRYPTION_KEY: str = Field(default="", repr=False)

    # Protocol Auth (``hqa1.`` Quick Auth tokens, verified locally).
    # Comma-separated list of SIWE domains a token may be issued for: prod +
    # any preview/staging domains that should be able to sign users in.
    # Empty disables Protocol Auth login (no domain will match).
    QUICKAUTH_ALLOWED_AUDIENCES: str = ""

    # Shared secret for ops endpoints invoked by external schedulers
    # (e.g. Railway cron jobs). Sent as the X-Admin-Secret header.
    ADMIN_SECRET: str = Field(default="", repr=False)

    # Spam filtering
    SPAM_FILTER_ENABLED: bool = True

    # ---------------------------------------------------------------------
    # Hypersnap (Farcaster fork) — replaces Neynar for reads and writes
    # ---------------------------------------------------------------------
    # Base URL of the Hypersnap node. Reads hit ``/v2/farcaster/*`` (Neynar-
    # shaped, unauthenticated) and ``/v1/*``; writes are protobuf Messages
    # POSTed to ``/v1/submitMessage``.
    HYPERSNAP_HTTP_URL: str = "https://haatz.quilibrium.com"
    # Optimism JSON-RPC endpoint for IdRegistry / KeyGateway reads and the
    # relayed ``KeyGateway.addFor`` transactions. May embed a provider API
    # key, so it is treated as a secret. Also read from the wallet work's
    # FARCASTER_VERIFICATION_OP_RPC_URL so one keyed URL serves both.
    OPTIMISM_RPC_URL: str = Field(
        default="",
        repr=False,
        validation_alias=AliasChoices(
            "OPTIMISM_RPC_URL", "FARCASTER_VERIFICATION_OP_RPC_URL"
        ),
    )
    # Hex secp256k1 key of the wallet that relays (and pays gas for)
    # ``KeyGateway.addFor``. Holds only gas money; it never owns an FID.
    # NEVER log this value, NEVER include it in error messages or responses.
    KEY_RELAYER_PRIVATE_KEY: str = Field(default="", repr=False)
    # Below this relayer balance (wei) each addFor logs a top-up warning.
    # Sends still proceed while the balance covers the transaction's max cost.
    KEY_RELAYER_MIN_BALANCE_WEI: int = 5 * 10**15  # 0.005 ETH
    # AES-256 key for user Ed25519 signer private keys at rest. Required for
    # user signers; there is deliberately no fallback to the bot key.
    SIGNER_ENCRYPTION_KEY: str = Field(default="", repr=False)
    # Optional keyring for the same blobs, enabling rotation:
    # ``"<kid>:<base64 key>,<kid>:<base64 key>"``. The FIRST entry is the
    # active key (new blobs are written as ``v2:<kid>:...``); every entry can
    # decrypt. Unversioned ``v1:`` blobs keep decrypting with
    # ``SIGNER_ENCRYPTION_KEY`` (then any keyring key), so it stays set until
    # every v1 blob has been re-encrypted. Unset: v1 behavior is unchanged.
    SIGNER_ENCRYPTION_KEYS: str = Field(default="", repr=False)
    # HMAC secrets for Hypersnap webhook deliveries (X-Hypersnap-Signature).
    # Comma-separate values: one per push shard, plus old+new while rotating.
    HYPERSNAP_WEBHOOK_SECRET_CAST: str = Field(default="", repr=False)
    HYPERSNAP_WEBHOOK_SECRET_MENTION: str = Field(default="", repr=False)
    HYPERSNAP_WEBHOOK_SECRET_REACTION: str = Field(default="", repr=False)
    HYPERSNAP_WEBHOOK_SECRET_FOLLOW: str = Field(default="", repr=False)
    HYPERSNAP_WEBHOOK_SECRET_ROOM_REPLY: str = Field(default="", repr=False)
    # Encrypted (signer_crypto blob) Ed25519 key of the @jukeaudio system
    # signer. Replaces JUKEAUDIO_SIGNER_UUID once writes are migrated.
    JUKEAUDIO_SIGNER_PRIVATE_KEY_ENCRYPTED: str = Field(default="", repr=False)
    # Mini-app search stays on Neynar until Hypersnap has an equivalent.
    MINIAPP_SEARCH_PROVIDER: str = "neynar"

    # ---------------------------------------------------------------------
    # Recognition leaderboard
    # ---------------------------------------------------------------------
    # FID of the @jukeaudio brand account, excluded from all leaderboard
    # scoring. When unset, the brand fid is resolved at runtime from the user
    # row owning ``JUKEAUDIO_SIGNER_UUID``; set this explicitly to avoid the
    # lookup or when the brand account has no local user row.
    BRAND_FID: int | None = None
    # Enables the nightly leaderboard aggregation background loop. Off in
    # tests (no Redis/Neynar); turn on in real deployments.
    LEADERBOARD_AGGREGATION_ENABLED: bool = False

    # x402 agent payment settings
    X402_ENABLED: bool = False
    X402_PAYMENT_ADDRESS: str = ""  # payTo address for receiving USDC
    X402_FACILITATOR_URL: str = "https://api.cdp.coinbase.com/platform/v2/x402"
    X402_NETWORK: str = "eip155:8453"  # Base mainnet (CAIP-2)
    X402_USDC_ASSET: str = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"  # USDC on Base
    AGENT_JOIN_TOLL: str = "1000"  # Amount in atomic units (1000 = 0.001 USDC)
    AGENT_FID_START: int = 9_000_000_000

    # ---------------------------------------------------------------------
    # Messaging (Direct Casts) — docs/messaging-design.md
    # ---------------------------------------------------------------------
    # Off → every /v1/messages/* route answers 404 (the WS closes 4404).
    MESSAGING_ENABLED: bool = False
    # Which DirectCastService implementation backs the routes. "farcaster"
    # proxies client.farcaster.xyz; "native" is the Juke-owned fallback
    # (section 8, not built yet → routes answer 503 when selected).
    MESSAGING_BACKEND: Literal["farcaster", "native"] = "farcaster"
    # Phase B upstream websocket relay. Not implemented yet: when on, the
    # events socket logs once and keeps using Phase A polling.
    MESSAGING_RELAY_ENABLED: bool = False
    # Per-room concurrent agent cap. Enforced by RoomService.join_room_as_agent.
    # Bounds participant-list pollution and synthetic-identity spam in the
    # presence of the partner-scoped (free) agent-join path. Real-world
    # legitimate use is ~1-3 agents per room (concierge, transcriber, recap).
    MAX_AGENTS_PER_ROOM: int = 5

    # ---------------------------------------------------------------------
    # Network edge: client IP trust, connection + pool bounds
    # (docs/backend-network-limits.md)
    # ---------------------------------------------------------------------
    # Comma-separated CIDRs of reverse proxies whose X-Forwarded-For /
    # X-Real-IP headers are honored. Empty -> private/loopback ranges plus
    # Railway's 100.0.0.0/8 edge (Railway, docker-compose nginx); "none" ->
    # never trust headers.
    TRUSTED_PROXY_IPS: str = ""
    # Upper bound on Redis connections per process for commands (HTTP
    # handlers, workers). Was unbounded. Websocket pubsub uses its own pool
    # below, so a socket flood can never starve HTTP requests. Keep the sum
    # of both pools x processes under Redis maxclients (default 10000).
    REDIS_MAX_CONNECTIONS: int = 500
    # Upper bound on pubsub connections per process: one per open websocket
    # (/v1/rooms/events, /v1/messages/events). When full, new sockets fail;
    # HTTP is unaffected.
    REDIS_PUBSUB_MAX_CONNECTIONS: int = 2000
    # How long a request waits for a free pooled Redis connection before
    # failing (instead of opening an unbounded number of new ones).
    REDIS_POOL_TIMEOUT_SECONDS: float = 5.0
    # Concurrent WS /v1/messages/events sockets per fid.
    MESSAGES_WS_MAX_PER_FID: int = 5
    # Concurrent unauthenticated WS /v1/rooms/events sockets per client IP.
    # Generous because mobile carriers put many users behind one CGNAT IP.
    ROOM_EVENTS_WS_MAX_PER_IP: int = 100

    # ---------------------------------------------------------------------
    # Farcaster-native spaces discovery (service-FID bearer)
    # ---------------------------------------------------------------------
    # Hex-encoded (0x-prefixed) secp256k1 EOA private key that owns the
    # Juke-operated service FID used for read-only discovery against
    # client.farcaster.xyz. The key signs the EIP-191 personal_sign
    # payload that mints a long-lived (~1000d) bearer at first use; the
    # bearer is cached in memory and refreshed lazily within
    # JUKE_FARCASTER_BEARER_REFRESH_THRESHOLD_HOURS of expiry. NEVER log
    # this value, NEVER include it in error messages or responses.
    # Empty/unset disables the discovery routes (router returns 503).
    JUKE_FARCASTER_CUSTODY_PRIVATE_KEY: str = Field(default="", repr=False)
    # FID of the Juke service account. Informational — used in logs /
    # observability only; not load-bearing for the mint flow itself
    # (the upstream API resolves the FID from the signing address).
    JUKE_FARCASTER_FID: int = 0
    # When the cached bearer expires within this many hours, the next
    # discovery call triggers a re-mint. 24h gives plenty of slack.
    JUKE_FARCASTER_BEARER_REFRESH_THRESHOLD_HOURS: int = 24
    # Admin-maintained allowlist for legacy ``custody_env`` developer bots:
    # comma-separated ``<app_uuid>:<ENV_VAR_NAME>`` pairs. A bot's
    # ``custody_key_ref`` (``env:<NAME>``) only resolves if its exact
    # (app_id, NAME) pair is listed here AND NAME starts with
    # ``JUKE_DEV_BOT_CUSTODY_`` so platform secrets can never be named.
    # Empty (the default) disables custody_env minting entirely.
    DEVELOPER_CUSTODY_KEY_REFS: str = ""

    def juke_farcaster_custody_private_key_resolved(self) -> str:
        """Return the service custody private key.

        Order of resolution:
          1. ``JUKE_FARCASTER_CUSTODY_PRIVATE_KEY`` — raw hex, takes precedence.
          2. ``FARCASTER_APP_MNEMONIC`` — derived at BIP44 path
             ``m/44'/60'/0'/0/0`` (Ethereum default; matches the
             quorum-mobile reference).

        Either form yields the same custody EOA when the mnemonic was
        used to register the FID on Optimism. Returns empty string when
        neither is set.

        Lazy import of ``eth_account`` avoids pulling the HD-wallet code
        path on startup for deployments that supply the raw key.
        """
        raw = self.JUKE_FARCASTER_CUSTODY_PRIVATE_KEY.strip()
        if raw:
            return raw if raw.startswith("0x") else f"0x{raw}"
        mnemonic = self.FARCASTER_APP_MNEMONIC.strip()
        if not mnemonic:
            return ""
        from eth_account import Account

        Account.enable_unaudited_hdwallet_features()
        acct = Account.from_mnemonic(mnemonic)
        # acct.key is bytes; hex() includes the 0x prefix via to_0x_hex.
        return (
            acct.key.hex() if acct.key.hex().startswith("0x") else f"0x{acct.key.hex()}"
        )

    def juke_farcaster_fid_resolved(self) -> int:
        """Return the service FID, preferring the explicit Juke var but
        falling back to ``FARCASTER_APP_FID`` for deployments configured
        with the mnemonic-style names.
        """
        if self.JUKE_FARCASTER_FID:
            return self.JUKE_FARCASTER_FID
        return self.FARCASTER_APP_FID

    # ---------------------------------------------------------------------
    # Phase-4 recording agents (per-FID bearer mints)
    # ---------------------------------------------------------------------
    # Comma-separated list of Juke-owned Farcaster FIDs that may join a
    # Farcaster-native room as a passive "listener" recording agent.
    # Each agent FID is a distinct Farcaster identity so its presence in
    # the upstream participant list is honest (not impersonating the
    # discovery/service account). Empty/unset disables native-room
    # recording (router returns 503 "no recording agents available").
    JUKE_RECORDING_AGENT_FIDS: list[int] = Field(default_factory=list)
    # JSON map ``{"<fid>": "0x<hex>"}`` of custody EOA private keys, one
    # per agent FID listed in ``JUKE_RECORDING_AGENT_FIDS``. Read from a
    # single env var (``JUKE_RECORDING_AGENT_CUSTODY_KEYS_JSON``) as raw
    # JSON because pydantic-settings can't natively parse a dict-of-
    # int-keys from env. Parsed lazily via
    # ``recording_agent_custody_keys``. NEVER log values.
    JUKE_RECORDING_AGENT_CUSTODY_KEYS_JSON: str = Field(default="", repr=False)

    # Path to the Node recording-agent worker script (Option A:
    # subprocess + stdin/stdout JSON-line protocol). Defaults to the
    # repo-local stub. Override for prod when the real
    # ``@livekit/rtc-node`` worker is wired up.
    JUKE_RECORDING_AGENT_WORKER_PATH: str = str(
        _backend_dir / "recording_agent" / "worker.mjs"
    )
    # Node binary to spawn the worker with. ``node`` is fine for dev;
    # prod ships a pinned version on PATH.
    JUKE_RECORDING_AGENT_NODE_BIN: str = "node"

    # Max seconds the lifespan shutdown spends finalizing in-flight native
    # recordings before the process exits. On redeploy the platform sends
    # SIGTERM; we use this window to flush + upload each active recording so
    # a redeploy can't orphan one. MUST stay below the platform's
    # SIGTERM->SIGKILL grace (Railway) and below uvicorn's
    # ``--timeout-graceful-shutdown`` so the drain actually completes.
    RECORDING_DRAIN_TIMEOUT_SECONDS: float = 35.0

    def recording_agent_fids_resolved(self) -> list[int]:
        """Return the recording-agent FID pool.

        Resolution:
          1. ``JUKE_RECORDING_AGENT_FIDS`` — explicit list, takes
             precedence.
          2. ``FARCASTER_APP_FID`` — fallback so single-agent
             deployments reuse the same identity they already use for
             casting + service-bearer mints. No new env vars required
             for the common case.

        Returns ``[]`` when nothing is configured, which keeps the
        router behavior of 503 "no recording agents available".
        """
        if self.JUKE_RECORDING_AGENT_FIDS:
            return list(self.JUKE_RECORDING_AGENT_FIDS)
        fallback = self.FARCASTER_APP_FID
        if fallback:
            return [fallback]
        return []

    def recording_agent_custody_keys(self) -> dict[int, str]:
        """Parse ``JUKE_RECORDING_AGENT_CUSTODY_KEYS_JSON`` lazily,
        with a sensible fallback for the common single-agent case.

        Resolution:
          1. ``JUKE_RECORDING_AGENT_CUSTODY_KEYS_JSON`` — explicit map,
             takes precedence (used when an operator runs multiple
             dedicated recording-agent identities).
          2. ``FARCASTER_APP_MNEMONIC`` (or
             ``JUKE_FARCASTER_CUSTODY_PRIVATE_KEY``) — derived for
             ``FARCASTER_APP_FID`` so single-agent deployments reuse
             the same custody key the service identity already mints
             from. No new env vars required for the common case.

        Returns ``{fid: "0x..."}``. On malformed JSON we log a warning
        and return ``{}`` so the recording-agent pool stays empty —
        callers see "no agents available" rather than a 500.

        Cached at the module level keyed by the raw JSON string so a
        single parse covers every call across Settings instances
        sharing the same input — and tests that build their own
        Settings still re-parse when they change the raw input.
        """
        raw = (self.JUKE_RECORDING_AGENT_CUSTODY_KEYS_JSON or "").strip()
        cached = _RECORDING_AGENT_KEY_CACHE.get(raw)
        if cached is not None:
            return cached
        if not raw:
            # Fallback: derive the custody key for FARCASTER_APP_FID
            # from the same source the service identity already uses
            # (FARCASTER_APP_MNEMONIC or JUKE_FARCASTER_CUSTODY_PRIVATE_KEY).
            # Keeps single-agent deployments from needing a duplicate
            # env var. Multi-agent operators use the JSON map directly.
            derived: dict[int, str] = {}
            fallback_fid = self.FARCASTER_APP_FID
            fallback_key = self.juke_farcaster_custody_private_key_resolved()
            if fallback_fid and fallback_key:
                derived[fallback_fid] = fallback_key
            _RECORDING_AGENT_KEY_CACHE[raw] = derived
            return derived
        try:
            decoded = json.loads(raw)
        except (json.JSONDecodeError, ValueError) as exc:
            # No values logged — only the failure mode.
            _log.warning(
                "JUKE_RECORDING_AGENT_CUSTODY_KEYS_JSON failed to parse "
                "(%s); recording-agent pool will be empty",
                type(exc).__name__,
            )
            _RECORDING_AGENT_KEY_CACHE[raw] = {}
            return {}
        if not isinstance(decoded, dict):
            _log.warning(
                "JUKE_RECORDING_AGENT_CUSTODY_KEYS_JSON did not decode to "
                "an object; recording-agent pool will be empty"
            )
            _RECORDING_AGENT_KEY_CACHE[raw] = {}
            return {}
        normalized: dict[int, str] = {}
        for k, v in decoded.items():
            try:
                fid_int = int(k)
            except (TypeError, ValueError):
                _log.warning(
                    "JUKE_RECORDING_AGENT_CUSTODY_KEYS_JSON has non-int "
                    "key; skipping entry"
                )
                continue
            if not isinstance(v, str) or not v:
                _log.warning(
                    "JUKE_RECORDING_AGENT_CUSTODY_KEYS_JSON has non-string "
                    "value for fid=%d; skipping",
                    fid_int,
                )
                continue
            normalized[fid_int] = v
        _RECORDING_AGENT_KEY_CACHE[raw] = normalized
        return normalized

    @model_validator(mode="after")
    def _validate_production_urls(self) -> "Settings":
        require_https_in_production(
            self.HYPERSNAP_HTTP_URL,
            setting_name="HYPERSNAP_HTTP_URL",
            environment=self.ENVIRONMENT,
        )
        # The RPC is a trust anchor (custody/idOf, KeyGateway nonces, addFor
        # simulation). Unset fails closed in ``key_gateway`` instead.
        if self.OPTIMISM_RPC_URL:
            require_https_in_production(
                self.OPTIMISM_RPC_URL,
                setting_name="OPTIMISM_RPC_URL",
                environment=self.ENVIRONMENT,
            )
        return self


settings = Settings()
