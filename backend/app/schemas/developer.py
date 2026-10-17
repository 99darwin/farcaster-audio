import re
from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import urlparse
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.config import settings

# The per-entry constraint here only caps the upper bound; lower-bound
# (non-empty) and format checks live in _validate_allowed_origins so that
# leading/trailing whitespace and empty strings can be normalized away
# rather than producing a 422.
AllowedOrigin = Annotated[str, Field(max_length=500)]

_MAX_ALLOWED_ORIGINS = 20
_ALLOWED_ORIGIN_SCHEMES = {"http", "https"}
_FORBIDDEN_ORIGIN_HOSTS_IN_PROD = {"localhost", "127.0.0.1", "0.0.0.0"}


def _validate_allowed_origins(value: list[str] | None) -> list[str] | None:
    """Normalize and validate developer app `allowed_origins` entries.

    Rules:
    - Cap at 20 entries.
    - Strip whitespace; drop empty strings.
    - Reject wildcard / null / empty origins.
    - Each entry must be `scheme://host[:port]` — no path, query, or fragment.
    - Scheme must be `http` or `https`.
    - In production (`settings.ENVIRONMENT == "production"`), require `https`
      and reject `localhost`, `127.0.0.1`, `0.0.0.0`.
    """
    if value is None:
        return None
    cleaned: list[str] = []
    for raw in value:
        if not isinstance(raw, str):
            raise ValueError("allowed_origins entries must be strings")
        stripped = raw.strip()
        if not stripped:
            continue
        lowered = stripped.lower()
        if lowered in ("*", "null"):
            raise ValueError("allowed_origins cannot contain wildcard or null values")
        parsed = urlparse(stripped)
        if parsed.scheme not in _ALLOWED_ORIGIN_SCHEMES:
            raise ValueError("allowed_origins entries must use http or https scheme")
        if not parsed.netloc:
            raise ValueError("allowed_origins entries must include a host")
        if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            raise ValueError(
                "allowed_origins entries must not include path, query, or fragment"
            )
        host = (parsed.hostname or "").lower()
        if settings.ENVIRONMENT == "production":
            if parsed.scheme != "https":
                raise ValueError("allowed_origins must use https in production")
            if host in _FORBIDDEN_ORIGIN_HOSTS_IN_PROD:
                raise ValueError(
                    "allowed_origins cannot reference localhost in production"
                )
        cleaned.append(stripped)
    if len(cleaned) > _MAX_ALLOWED_ORIGINS:
        raise ValueError(
            f"allowed_origins cannot exceed {_MAX_ALLOWED_ORIGINS} entries"
        )
    return cleaned


class DeveloperApplicationResponse(BaseModel):
    fid: int
    project_name: str
    website_url: str | None
    use_case: str
    status: str
    reviewed_by_fid: int | None = None
    reviewed_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class DeveloperStatusResponse(BaseModel):
    developer_access_status: str
    application: DeveloperApplicationResponse | None = None


class DeveloperAccessUpdate(BaseModel):
    status: str = Field(pattern="^(none|pending|approved|suspended)$")


class DeveloperUserResponse(BaseModel):
    fid: int
    username: str | None = None
    display_name: str | None = None
    developer_access_status: str
    application: DeveloperApplicationResponse | None = None


class DeveloperUserListResponse(BaseModel):
    users: list[DeveloperUserResponse]


class DeveloperAppCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    website_url: str | None = Field(default=None, max_length=500)
    allowed_origins: list[AllowedOrigin] = Field(default_factory=list, max_length=20)

    @field_validator("allowed_origins")
    @classmethod
    def _check_allowed_origins(cls, value: list[str]) -> list[str]:
        return _validate_allowed_origins(value) or []


class DeveloperAppUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    website_url: str | None = Field(default=None, max_length=500)
    allowed_origins: list[AllowedOrigin] | None = Field(default=None, max_length=20)

    @field_validator("allowed_origins")
    @classmethod
    def _check_allowed_origins(cls, value: list[str] | None) -> list[str] | None:
        return _validate_allowed_origins(value)


class DeveloperAppResponse(BaseModel):
    id: UUID
    owner_fid: int
    name: str
    description: str | None
    website_url: str | None
    allowed_origins: list[str]
    status: str
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class DeveloperAppListResponse(BaseModel):
    apps: list[DeveloperAppResponse]


class DeveloperKeyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class DeveloperKeyResponse(BaseModel):
    app_id: UUID
    key_id: str
    name: str
    public_key: str | None = None
    secret_key: str | None = None
    reveal_token: str | None = None
    reveal_expires_at: datetime | None = None
    revealed_at: datetime | None = None
    last_used_at: datetime | None = None
    revoked_at: datetime | None = None
    rotated_from_key_id: str | None = None
    created_at: datetime | None = None

    model_config = {"from_attributes": True}


class DeveloperKeyListResponse(BaseModel):
    keys: list[DeveloperKeyResponse]


class DeveloperKeyRevealResponse(BaseModel):
    secret_key: str
    reveal_expires_at: datetime


class DeveloperKeyRevealRequest(BaseModel):
    reveal_token: str = Field(min_length=32, max_length=256)


class DeveloperApplicationRequest(BaseModel):
    project_name: str = Field(min_length=1, max_length=120)
    website_url: str | None = Field(default=None, max_length=500)
    use_case: str = Field(min_length=1, max_length=2000)


# JFS Bearer wire shape: three non-empty base64url segments. The value
# flows verbatim into an upstream ``Authorization: Bearer ...`` header, so
# restricting to ``[A-Za-z0-9_-]`` (base64url, no padding) rules out
# control characters (CRLF) and other header-smuggling vectors before the
# value reaches the httpx client — defense in depth alongside httpx's own
# control-char rejection. Mirrors the validator on
# ``schemas/room.py:CreateNativeRoomRequest``.
_JFS_BEARER_PATTERN = re.compile(r"^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$")


def _check_jfs_bearer_shape(value: str | None) -> str | None:
    if value is None:
        return value
    if not _JFS_BEARER_PATTERN.fullmatch(value):
        raise ValueError("must be base64url-encoded header.payload.signature")
    return value


class DeveloperSpaceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(..., min_length=1, max_length=256)
    scheduled_at: str | None = None
    announce_cast: bool = False
    allow_agents: bool = True
    # Phase-4 part 2 — partner can elect to create a Farcaster-native
    # space (host == "farcaster") with one of their registered bots as
    # the upstream host. Defaults to the existing Juke-hosted path so
    # existing integrations are unchanged.
    host: Literal["juke", "farcaster"] = "juke"
    host_bot_fid: int | None = Field(
        default=None,
        ge=1,
        le=2_000_000_000,
        description=(
            "Bot-hosted mode (host == 'farcaster'). The FID of a bot the "
            "calling developer app has registered via "
            "POST /v1/developer/bots. Provide EXACTLY ONE of host_bot_fid "
            "or user_jfs_bearer."
        ),
    )
    # User-hosted mode: a JFS Bearer signed by the end user's on-device
    # Ed25519 app key (audience ``https://client.farcaster.xyz``). The
    # upstream room is hosted by that user's FID directly. ``repr=False``
    # keeps the secret out of tracebacks / structured logs.
    user_jfs_bearer: str | None = Field(
        default=None,
        min_length=16,
        max_length=4096,
        repr=False,
        description=(
            "User-hosted mode (host == 'farcaster'). A user-signed JFS "
            "Bearer (header.payload.signature) for client.farcaster.xyz. "
            "Provide EXACTLY ONE of host_bot_fid or user_jfs_bearer."
        ),
    )
    channel_key: str | None = Field(
        default=None,
        max_length=128,
        description=(
            "Optional Farcaster channel slug. Only consulted when "
            "host == 'farcaster'."
        ),
    )

    @field_validator("user_jfs_bearer")
    @classmethod
    def _check_bearer_shape(cls, v: str | None) -> str | None:
        return _check_jfs_bearer_shape(v)


class DeveloperSpaceStartRequest(BaseModel):
    """Optional body for ``POST /v1/developer/spaces/{room_id}/start``.

    ``user_jfs_bearer`` is REQUIRED when the room's ``host_mode`` is
    ``"user_fid"`` (the upstream room is hosted by the end user, so only
    a fresh user-signed bearer can authorize the start-scheduled call);
    it is unused for bot-hosted rooms, which mint from the managed signer.
    """

    model_config = ConfigDict(extra="forbid")

    user_jfs_bearer: str | None = Field(
        default=None,
        min_length=16,
        max_length=4096,
        repr=False,
        description=(
            "User-signed JFS Bearer for client.farcaster.xyz. Required "
            "when host_mode == 'user_fid'; unused for bot-hosted rooms."
        ),
    )

    @field_validator("user_jfs_bearer")
    @classmethod
    def _check_bearer_shape(cls, v: str | None) -> str | None:
        return _check_jfs_bearer_shape(v)


class DeveloperSpaceEndRequest(BaseModel):
    """Optional body for ``POST /v1/developer/spaces/{room_id}/end``.

    Backward compatible: existing empty-body end calls (Juke-hosted rooms
    and bot-hosted native rooms) are unaffected. ``user_jfs_bearer`` is
    REQUIRED only when ending a native room whose ``host_mode`` is
    ``"user_fid"``.
    """

    model_config = ConfigDict(extra="forbid")

    user_jfs_bearer: str | None = Field(
        default=None,
        min_length=16,
        max_length=4096,
        repr=False,
        description=(
            "User-signed JFS Bearer for client.farcaster.xyz. Required "
            "when host_mode == 'user_fid'; unused otherwise."
        ),
    )

    @field_validator("user_jfs_bearer")
    @classmethod
    def _check_bearer_shape(cls, v: str | None) -> str | None:
        return _check_jfs_bearer_shape(v)


# ---------------------------------------------------------------------------
# Developer-app bot registry
# ---------------------------------------------------------------------------


# EVM checksummed / lowercase 0x-address. Accept either case; the model
# stores whatever the partner submitted (we don't re-checksum because
# eth-utils isn't a hard dependency at the schema layer).
_EVM_ADDRESS_PATTERN = re.compile(r"^0x[0-9a-fA-F]{40}$")

# Phase-4 only supports the ``env:<ENV_VAR_NAME>`` scheme — see
# ``FarcasterSpacesService._resolve_custody_key_ref``. The pattern is
# permissive on the env-var name (letters / digits / underscore) and
# capped at a sane upper bound so a malicious payload can't trigger a
# huge environ probe.
_CUSTODY_KEY_REF_PATTERN = re.compile(r"^env:[A-Za-z_][A-Za-z0-9_]{0,127}$")


class DeveloperBotCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fid: int = Field(
        ...,
        ge=1,
        le=2_000_000_000,
        description="Farcaster ID this bot identity is registered under.",
    )
    # Both custody fields are optional. Supplying BOTH selects the legacy
    # ``custody_env`` mode (the developer self-hosts the bot's custody EOA
    # private key and passes an ``env:<VAR>`` reference). Supplying NEITHER
    # selects the managed-signer (``app_key``) mode where Juke generates,
    # encrypts, and holds an Ed25519 app key. Supplying exactly one of the
    # pair is a malformed request → 422 (see ``_check_custody_pair``).
    custody_address: str | None = Field(
        default=None,
        description=(
            "EVM 0x-address of the bot's custody EOA. Display-only — "
            "never used for signing. Stored verbatim. Legacy custody-mode "
            "only; omit (along with custody_key_ref) for a managed signer."
        ),
    )
    custody_key_ref: str | None = Field(
        default=None,
        max_length=256,
        description=(
            "Opaque reference to the actual custody key. Phase-4 "
            "supports 'env:<ENV_VAR_NAME>'; in production this should "
            "be upgraded to a KMS or vault ref. NEVER pass the raw "
            "private key here. Legacy custody-mode only; omit (along "
            "with custody_address) for a managed signer."
        ),
    )
    label: str | None = Field(default=None, max_length=120)

    @field_validator("custody_address")
    @classmethod
    def _check_address(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not _EVM_ADDRESS_PATTERN.match(stripped):
            raise ValueError("custody_address must be a 0x-prefixed 40-hex EVM address")
        return stripped

    @field_validator("custody_key_ref")
    @classmethod
    def _check_key_ref(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not _CUSTODY_KEY_REF_PATTERN.match(stripped):
            raise ValueError(
                "custody_key_ref must match 'env:<ENV_VAR_NAME>' "
                "(letters / digits / underscore, ≤128 chars)"
            )
        return stripped

    @model_validator(mode="after")
    def _check_custody_pair(self) -> "DeveloperBotCreate":
        # The custody pair is all-or-nothing. A half-populated pair is
        # ambiguous (which mode did the caller intend?) so it's a hard
        # 422 rather than a silent coercion into one mode or the other.
        has_address = self.custody_address is not None
        has_key_ref = self.custody_key_ref is not None
        if has_address != has_key_ref:
            raise ValueError(
                "custody_address and custody_key_ref must be provided "
                "together (legacy custody mode) or both omitted "
                "(managed-signer mode)"
            )
        return self

    @property
    def is_managed_signer(self) -> bool:
        """True when the request selects the managed-signer (app_key) mode."""
        return self.custody_key_ref is None


class DeveloperBotResponse(BaseModel):
    id: UUID
    fid: int
    label: str | None = None
    is_active: bool
    # How this bot mints Farcaster JFS bearers: ``custody_env`` (legacy,
    # developer-held secret) or ``app_key`` (Juke-managed Ed25519 signer).
    auth_mode: str
    # Managed-signer lifecycle: ``pending_approval`` | ``approved`` |
    # ``revoked`` | ``fid_mismatch``. Null for legacy custody bots.
    signer_status: str | None = None
    # 0x-prefixed Ed25519 public key of the managed signer (safe to expose;
    # it's public by definition). Null for legacy custody bots.
    signer_public_key: str | None = None
    # Warpcast approval deep link — populated ONLY while the signer is
    # awaiting approval (status == pending_approval). Nulled the moment the
    # signer becomes approved/revoked/fid_mismatch so stale links aren't
    # presented. Never contains key material.
    approval_url: str | None = None
    # Single gate the dashboard/client reads to decide "can this bot host?".
    # custody_env bots are ready as soon as registered; app_key bots are
    # ready only once ``signer_status == "approved"``.
    ready: bool

    model_config = {"from_attributes": True}


class DeveloperBotListResponse(BaseModel):
    bots: list[DeveloperBotResponse]


# ---------------------------------------------------------------------------
# Extended agent-join body (developer router)
# ---------------------------------------------------------------------------


class PartnerAgentJoinRequest(BaseModel):
    """Body for ``POST /v1/developer/rooms/{room_id}/agent-join``.

    Mirrors :py:class:`AgentJoinRequest` from ``schemas/agent.py`` —
    same name + pfp constraints — plus the optional
    ``agent_bot_fid``. When the target room is Farcaster-native and
    ``agent_bot_fid`` is provided, the response is a thin
    ``{wsUrl, token}`` envelope so the partner's bot can connect via
    the LiveKit SDK directly. Otherwise we fall back to the existing
    Juke-hosted agent-join flow which returns a full session token.
    """

    model_config = ConfigDict(extra="forbid")

    agent_name: str = Field(..., min_length=1, max_length=128)
    agent_pfp_url: str | None = Field(default=None, max_length=512)
    agent_bot_fid: int | None = Field(
        default=None,
        ge=1,
        le=2_000_000_000,
        description=(
            "Only meaningful for native rooms. The FID of a bot the "
            "calling developer app has registered via "
            "POST /v1/developer/bots."
        ),
    )

    @field_validator("agent_name")
    @classmethod
    def _check_name(cls, v: str) -> str:
        if not re.match(r"^[\w\s\-\.]+$", v):
            raise ValueError(
                "agent_name must contain only letters, numbers, "
                "spaces, hyphens, underscores, and dots"
            )
        return v.strip()

    @field_validator("agent_pfp_url")
    @classmethod
    def _check_pfp(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not v.startswith("https://"):
            raise ValueError("agent_pfp_url must use HTTPS scheme")
        return v


class NativeAgentJoinResponse(BaseModel):
    """Response for the native-room branch of the dev agent-join.

    The partner's bot connects to LiveKit directly using these creds —
    Juke does not proxy the audio stream. Fields are wire-name aligned
    with what ``client.farcaster.xyz/v1/audio-room/join`` returns to
    keep partner SDK code minimal.
    """

    ws_url: str = Field(..., alias="wsUrl")
    token: str
    # Surface the room id back so the partner can correlate logs even
    # if they only have the Juke room UUID in their context.
    farcaster_room_id: str

    model_config = ConfigDict(populate_by_name=True)


WEBHOOK_EVENT_TYPES = frozenset(
    {
        "room.started",
        "room.finished",
        "participant.joined",
        "participant.left",
        "recording.ready",
    }
)


# Delivery only dials standard web ports (see dev_webhook_service).
_WEBHOOK_ALLOWED_PORTS = frozenset({80, 443})


def _validate_webhook_url(value: str) -> str:
    parsed = urlparse(value.strip())
    if parsed.scheme not in ("http", "https"):
        raise ValueError("Webhook URL must use http or https scheme")
    if not parsed.netloc:
        raise ValueError("Webhook URL must include a host")
    if parsed.fragment:
        raise ValueError("Webhook URL must not include a fragment")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Webhook URL must not include credentials")
    try:
        port = parsed.port
    except ValueError:
        raise ValueError("Webhook URL has an invalid port") from None
    if port is not None and port not in _WEBHOOK_ALLOWED_PORTS:
        raise ValueError("Webhook URL port must be 80 or 443")
    if settings.ENVIRONMENT == "production":
        if parsed.scheme != "https":
            raise ValueError("Webhook URL must use https in production")
        host = (parsed.hostname or "").lower()
        if host in _FORBIDDEN_ORIGIN_HOSTS_IN_PROD:
            raise ValueError("Webhook URL cannot reference localhost in production")
    return value.strip()


class DeveloperWebhookCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str = Field(..., min_length=1, max_length=2048)
    events: list[str] = Field(..., min_length=1, max_length=16)

    @field_validator("url")
    @classmethod
    def _check_url(cls, value: str) -> str:
        return _validate_webhook_url(value)

    @field_validator("events")
    @classmethod
    def _check_events(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("events must contain at least one event type")
        invalid = [e for e in value if e not in WEBHOOK_EVENT_TYPES]
        if invalid:
            raise ValueError(
                f"Unknown event types: {sorted(set(invalid))}. "
                f"Valid: {sorted(WEBHOOK_EVENT_TYPES)}"
            )
        # Dedupe while preserving order.
        seen: set[str] = set()
        deduped: list[str] = []
        for event in value:
            if event not in seen:
                seen.add(event)
                deduped.append(event)
        return deduped


class DeveloperWebhookResponse(BaseModel):
    id: UUID
    app_id: UUID
    url: str
    events: list[str]
    last_delivery_at: datetime | None = None
    # ``success`` or an error category from the last delivery; None if none yet.
    last_outcome: str | None = None
    # Deprecated: always null. The raw HTTP status code is withheld so the
    # API can't fingerprint what answered at the target URL.
    last_status: int | None = None
    # Coarse error category (fixed vocabulary), or null.
    last_error: str | None = None
    created_at: datetime


class DeveloperWebhookCreateResponse(DeveloperWebhookResponse):
    # Returned once, only on POST. The plaintext secret is never re-revealable;
    # to rotate, delete the webhook and create a new one.
    secret: str


class DeveloperWebhookListResponse(BaseModel):
    webhooks: list[DeveloperWebhookResponse]


# ---------------------------------------------------------------------------
# Partner SSO bridge
# ---------------------------------------------------------------------------


# 5-minute default + 10-minute hard cap. Long enough to render the iframe
# and join, short enough that a leaked token has near-zero residual value.
PARTNER_TOKEN_DEFAULT_TTL_SECONDS = 300
PARTNER_TOKEN_MAX_TTL_SECONDS = 600


_MAX_VALID_FID = 2_000_000_000


class PartnerTokenCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fid: int = Field(
        ...,
        ge=1,
        le=_MAX_VALID_FID,
        description="Farcaster ID of the partner-authenticated visitor",
    )
    ttl_seconds: int = Field(
        default=PARTNER_TOKEN_DEFAULT_TTL_SECONDS,
        ge=60,
        le=PARTNER_TOKEN_MAX_TTL_SECONDS,
    )


class PartnerTokenResponse(BaseModel):
    token: str
    fid: int
    expires_at: datetime
    partner_app_id: UUID
