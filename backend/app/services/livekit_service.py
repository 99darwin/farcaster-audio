import json
from datetime import timedelta

from livekit import api

from app.config import settings


class LiveKitService:
    def __init__(self):
        self._api: api.LiveKitAPI | None = None

    @property
    def api(self) -> api.LiveKitAPI:
        if self._api is None:
            self._api = api.LiveKitAPI(
                url=settings.LIVEKIT_WS_URL,
                api_key=settings.LIVEKIT_API_KEY,
                api_secret=settings.LIVEKIT_API_SECRET,
            )
        return self._api

    async def create_room(self, room_id: str, title: str, empty_timeout: int = 300) -> None:
        """Create a LiveKit room."""
        await self.api.room.create_room(
            api.CreateRoomRequest(
                name=room_id,
                metadata=json.dumps({"title": title}),
                empty_timeout=empty_timeout,
                max_participants=510,  # 10 speakers + 500 listeners
            )
        )

    def generate_token(
        self,
        room_id: str,
        fid: int,
        display_name: str,
        role: str,
    ) -> str:
        """Generate a LiveKit access token for a participant."""
        can_publish = role in ("host", "co_host", "speaker")

        token = api.AccessToken(
            api_key=settings.LIVEKIT_API_KEY,
            api_secret=settings.LIVEKIT_API_SECRET,
        )
        token.with_identity(str(fid))
        token.with_name(display_name)
        token.with_metadata(json.dumps({"fid": fid, "role": role}))
        token.with_ttl(timedelta(hours=6))

        grant = api.VideoGrants(
            room_join=True,
            room=room_id,
            can_publish=can_publish,
            can_subscribe=True,
            can_publish_data=can_publish,
        )
        token.with_grants(grant)
        return token.to_jwt()

    async def mute_participant(self, room_id: str, identity: str) -> None:
        """Server-side mute a participant's audio tracks."""
        participant = await self.api.room.get_participant(
            api.RoomParticipantIdentity(room=room_id, identity=identity)
        )
        for track in participant.tracks:
            if track.type == api.TrackType.AUDIO:
                await self.api.room.mute_published_track(
                    api.MuteRoomTrackRequest(
                        room=room_id,
                        identity=identity,
                        track_sid=track.sid,
                        muted=True,
                    )
                )

    async def kick_participant(self, room_id: str, identity: str) -> None:
        """Remove a participant from the LiveKit room."""
        await self.api.room.remove_participant(
            api.RoomParticipantIdentity(room=room_id, identity=identity)
        )

    async def update_permissions(
        self, room_id: str, identity: str, can_publish: bool
    ) -> None:
        """Update participant permissions (promote/demote)."""
        await self.api.room.update_participant(
            api.UpdateParticipantRequest(
                room=room_id,
                identity=identity,
                permission=api.ParticipantPermission(
                    can_publish=can_publish,
                    can_subscribe=True,
                    can_publish_data=can_publish,
                ),
            )
        )

    async def delete_room(self, room_id: str) -> None:
        """Delete a LiveKit room, disconnecting all participants."""
        await self.api.room.delete_room(
            api.DeleteRoomRequest(room=room_id)
        )

    async def close(self) -> None:
        """Cleanup API client."""
        await self.api.aclose()
