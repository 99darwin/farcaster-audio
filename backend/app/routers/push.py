"""
Push notification routes — device token registration and notification preferences.
"""

import logging

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_db, get_redis
from app.schemas.push import (
    DeviceTokenRequest,
    NotificationPreferencesResponse,
    NotificationPreferencesUpdate,
)
from app.services.push_service import PushService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/push", tags=["push"])


def _push_service(db: AsyncSession = Depends(get_db), redis=Depends(get_redis)) -> PushService:
    return PushService(db, redis)


@router.post("/token", status_code=201)
async def register_device_token(
    body: DeviceTokenRequest,
    current_user: int = Depends(get_current_user),
    push: PushService = Depends(_push_service),
):
    """Register an Expo push token for the authenticated user."""
    await push.register_token(
        fid=current_user,
        expo_push_token=body.expo_push_token,
        device_id=body.device_id,
    )
    return {"status": "ok"}


@router.delete("/token")
async def unregister_device_token(
    body: DeviceTokenRequest,
    current_user: int = Depends(get_current_user),
    push: PushService = Depends(_push_service),
):
    """Unregister an Expo push token."""
    await push.unregister_token(fid=current_user, expo_push_token=body.expo_push_token)
    return {"status": "ok"}


@router.get("/preferences", response_model=NotificationPreferencesResponse)
async def get_notification_preferences(
    current_user: int = Depends(get_current_user),
    push: PushService = Depends(_push_service),
):
    """Get the user's notification preferences."""
    return await push.get_preferences(fid=current_user)


@router.patch("/preferences", response_model=NotificationPreferencesResponse)
async def update_notification_preferences(
    body: NotificationPreferencesUpdate,
    current_user: int = Depends(get_current_user),
    push: PushService = Depends(_push_service),
):
    """Partially update notification preferences."""
    updates = body.model_dump(exclude_none=True)
    return await push.update_preferences(fid=current_user, updates=updates)
