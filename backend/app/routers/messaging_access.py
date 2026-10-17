"""``POST /v1/messages/enable``: store the custody-minted DC upstream token.

``DELETE /v1/messages/token`` forgets it (first-party JWT; not gated by
``MESSAGING_ENABLED`` so the credential can always be removed).

Kept apart from ``routers/messages.py`` (the Direct Casts proxy) because
it manages the credential rather than proxying with it; token state is
reported by the existing ``GET /v1/messages/status``. Same gate:
``MESSAGING_ENABLED`` off answers 404, partner JWTs are refused, and every
route acts strictly as the JWT's fid.

The enable body is parsed by hand so a malformed request answers an opaque
400 instead of FastAPI's 422, which would echo the signature back.
"""

from __future__ import annotations

import logging
from typing import Any

import redis.asyncio as aioredis
from fastapi import APIRouter, Body, Depends, HTTPException, Response, status
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, get_farcaster_spaces_service, get_redis
from app.middleware.auth import require_first_party_user
from app.routers.messages import require_messaging_enabled
from app.routing import RedactedValidationRoute
from app.schemas.farcaster_token import EnableMessagingRequest, EnableMessagingResponse
from app.services import farcaster_token_service, user_signer_service
from app.services.farcaster_spaces_service import FarcasterSpacesService
from app.services.farcaster_token_service import (
    DirectCastTokenStatus,
    FarcasterTokenError,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/v1/messages",
    tags=["messages"],
    route_class=RedactedValidationRoute,
    dependencies=[Depends(require_messaging_enabled)],
)


# Deleting the credential is never gated: with MESSAGING_ENABLED off a user
# must still be able to make the server forget their custody-minted token.
token_router = APIRouter(
    prefix="/v1/messages",
    tags=["messages"],
    route_class=RedactedValidationRoute,
)


def _response(token: DirectCastTokenStatus) -> EnableMessagingResponse:
    return EnableMessagingResponse(
        token_status=token.token_status, expires_at=token.expires_at
    )


@router.post("/enable", response_model=EnableMessagingResponse)
async def enable_messaging(
    body: Any = Body(...),
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
    redis: aioredis.Redis = Depends(get_redis),
    spaces_service: FarcasterSpacesService = Depends(get_farcaster_spaces_service),
) -> EnableMessagingResponse:
    """Exchange a custody-signed ``generateToken`` request for the DC token.

    The signature must recover to the JWT fid's custody address. Only the
    resulting token is stored (encrypted); the signature is discarded.
    """
    await user_signer_service.enforce_rate_limit(
        redis,
        f"{farcaster_token_service.ENABLE_RATE_KEY_PREFIX}{fid}",
        limit=farcaster_token_service.ENABLE_RATE_LIMIT,
        window=farcaster_token_service.ENABLE_RATE_WINDOW_SECONDS,
    )
    try:
        parsed = EnableMessagingRequest.model_validate(body)
    except ValidationError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="invalid_auth_request"
        ) from None
    try:
        token = await farcaster_token_service.enable_direct_casts(
            db,
            fid=fid,
            auth_request=parsed.dc_auth_request,
            signature=parsed.dc_auth_signature,
            spaces_service=spaces_service,
        )
    except FarcasterTokenError as exc:
        logger.warning("dc_token_enable_failed fid=%s code=%s", fid, exc.code)
        raise HTTPException(status_code=exc.status_code, detail=exc.code) from None
    return _response(token)


@token_router.delete("/token", status_code=status.HTTP_204_NO_CONTENT)
async def delete_messaging_token(
    fid: int = Depends(require_first_party_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Forget the caller's stored Direct Casts token. Idempotent.

    Revokes nothing upstream (the custody-minted token can't be revoked
    from here); it guarantees Juke no longer holds it.
    """
    await farcaster_token_service.delete_direct_cast_token(db, fid)
    logger.info("dc_token_deleted fid=%s", fid)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
