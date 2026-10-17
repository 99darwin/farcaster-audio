"""Pydantic schemas for the Farcaster sync opt-in handshake.

The Warpcast bearer secret stays in the iOS Keychain after worker B1/B2
complete the handshake. Only ``fid`` is ever posted to the backend, and
``LinkRequest`` deliberately rejects any extra fields so a future
regression cannot quietly start sending the secret over the wire.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

# Defensive upper bound — Farcaster FIDs are monotonically increasing
# integers; 10M is well above the current high-water mark and gives the
# protocol plenty of headroom without letting bogus values reach the DB.
MAX_FID = 10_000_000


class LinkRequest(BaseModel):
    """POST /v1/farcaster-sync/link body.

    ``extra="forbid"`` is load-bearing: it is the schema-level defense
    against a future PR mistakenly adding a `secret` (or any other
    sensitive) field. If that happens the request 422s before the
    router ever runs.
    """

    model_config = ConfigDict(extra="forbid")

    fid: int = Field(..., gt=0, le=MAX_FID, description="Warpcast FID to link.")


class SyncStatus(BaseModel):
    """GET /v1/farcaster-sync response body."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool
    fid: Optional[int] = None
    linked_at: Optional[datetime] = None
