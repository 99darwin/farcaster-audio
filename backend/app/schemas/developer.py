from datetime import datetime
from typing import Annotated
from urllib.parse import urlparse
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

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


class DeveloperSpaceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(..., min_length=1, max_length=256)
    scheduled_at: str | None = None
    announce_cast: bool = False
    allow_agents: bool = True
