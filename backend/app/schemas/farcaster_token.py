"""Direct Casts upstream token: the device-signed ``generateToken`` request.

``client.farcaster.xyz`` Direct Casts only accept the bearer minted by
``PUT /v2/onboarding-state`` from a custody EIP-191 signature over the
canonical (key-sorted, compact) JSON of this request. The device signs it
with the recovery phrase; the backend validates, exchanges and stores only
the resulting token (``farcaster_token_service``).
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt

GENERATE_TOKEN_METHOD = "generateToken"
# ``eip191:`` + base64 of a 65-byte signature is 96 chars; leave headroom.
MAX_DC_AUTH_SIGNATURE_CHARS = 200

TokenStatus = Literal["active", "missing", "expired"]


class GenerateTokenParams(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    timestamp: StrictInt = Field(gt=0)
    expires_at: StrictInt = Field(gt=0, alias="expiresAt")


class DirectCastAuthRequest(BaseModel):
    """``{"method": "generateToken", "params": {timestamp, expiresAt}}`` (ms)."""

    model_config = ConfigDict(extra="forbid")

    method: Literal["generateToken"]
    params: GenerateTokenParams

    def to_upstream(self) -> dict[str, object]:
        """The exact object that is canonicalized, verified and PUT."""
        return self.model_dump(by_alias=True)


class EnableMessagingRequest(BaseModel):
    """Body for ``POST /v1/messages/enable`` (the "Enable messages" flow)."""

    dc_auth_request: DirectCastAuthRequest
    # ``eip191:<base64>``; never logged or echoed.
    dc_auth_signature: str = Field(
        min_length=1, max_length=MAX_DC_AUTH_SIGNATURE_CHARS, repr=False
    )


class EnableMessagingResponse(BaseModel):
    """``POST /v1/messages/enable``: the stored token's state (no secret)."""

    token_status: TokenStatus
    expires_at: datetime | None = None
