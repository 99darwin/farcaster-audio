from app.schemas.common import (
    ErrorResponse,
    PaginatedResponse,
    StatusResponse,
)
from app.schemas.auth import (
    AuthUrlResponse,
    LoginRequest,
    LoginResponse,
    RefreshRequest,
    UserResponse,
)
from app.schemas.participant import (
    BanRequest,
    BanResponse,
    JoinResponse,
    ParticipantResponse,
    PromoteResponse,
    RaiseHandRequest,
    RaiseHandResponse,
    TokenRefreshResponse,
)
from app.schemas.room import (
    RoomCreate,
    RoomCreateResponse,
    RoomDetailResponse,
    RoomListResponse,
    RoomResponse,
)

_namespace = {
    "RoomResponse": RoomResponse,
    "ParticipantResponse": ParticipantResponse,
}

JoinResponse.model_rebuild(_types_namespace=_namespace)
RoomDetailResponse.model_rebuild(_types_namespace=_namespace)

__all__ = [
    # common
    "ErrorResponse",
    "PaginatedResponse",
    "StatusResponse",
    # auth
    "AuthUrlResponse",
    "LoginRequest",
    "LoginResponse",
    "RefreshRequest",
    "UserResponse",
    # participant
    "BanRequest",
    "BanResponse",
    "JoinResponse",
    "ParticipantResponse",
    "PromoteResponse",
    "RaiseHandRequest",
    "RaiseHandResponse",
    "TokenRefreshResponse",
    # room
    "RoomCreate",
    "RoomCreateResponse",
    "RoomDetailResponse",
    "RoomListResponse",
    "RoomResponse",
]
