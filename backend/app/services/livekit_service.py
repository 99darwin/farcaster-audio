import json
from datetime import datetime, timedelta, timezone

from livekit import api

from app.config import settings


# 10 speakers (host + 9 guests) + 500 listener cap. Bumping this requires a
# corresponding check on LiveKit plan limits.
DEFAULT_MAX_PARTICIPANTS = 510


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
                max_participants=DEFAULT_MAX_PARTICIPANTS,
            )
        )

    def generate_token(
        self,
        room_id: str,
        fid: int,
        display_name: str,
        role: str,
        pfp_url: str | None = None,
        is_agent: bool = False,
        can_publish_data_override: bool | None = None,
    ) -> str:
        """Generate a LiveKit access token for a participant.

        Args:
            is_agent: If True, sets is_agent in participant metadata.
            can_publish_data_override: If set, overrides the default
                can_publish_data grant (which normally matches can_publish).
                Used for agents that need to send data messages as listeners.
        """
        can_publish = role in ("host", "co_host", "speaker")
        can_publish_data = can_publish_data_override if can_publish_data_override is not None else can_publish

        metadata: dict = {"fid": fid, "role": role}
        if pfp_url:
            metadata["pfp_url"] = pfp_url
        if is_agent:
            metadata["is_agent"] = True

        token = api.AccessToken(
            api_key=settings.LIVEKIT_API_KEY,
            api_secret=settings.LIVEKIT_API_SECRET,
        )
        token.with_identity(str(fid))
        token.with_name(display_name)
        token.with_metadata(json.dumps(metadata))
        token.with_ttl(timedelta(hours=6))

        grant = api.VideoGrants(
            room_join=True,
            room=room_id,
            can_publish=can_publish,
            can_subscribe=True,
            can_publish_data=can_publish_data,
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
        self, room_id: str, identity: str, can_publish: bool, role: str | None = None
    ) -> None:
        """Update participant permissions and metadata (promote/demote)."""
        request = api.UpdateParticipantRequest(
            room=room_id,
            identity=identity,
            permission=api.ParticipantPermission(
                can_publish=can_publish,
                can_subscribe=True,
                can_publish_data=can_publish,
            ),
        )
        if role:
            participant = await self.api.room.get_participant(
                api.RoomParticipantIdentity(room=room_id, identity=identity)
            )
            current_metadata = {}
            try:
                current_metadata = json.loads(participant.metadata) if participant.metadata else {}
            except (json.JSONDecodeError, TypeError):
                pass
            current_metadata["role"] = role
            request.metadata = json.dumps(current_metadata)
        await self.api.room.update_participant(request)

    async def send_data(self, room_id: str, payload: bytes, topic: str = "") -> None:
        """Broadcast a data message to all participants in a room."""
        await self.api.room.send_data(
            api.SendDataRequest(
                room=room_id,
                data=payload,
                topic=topic,
            )
        )

    async def delete_room(self, room_id: str) -> None:
        """Delete a LiveKit room, disconnecting all participants."""
        await self.api.room.delete_room(
            api.DeleteRoomRequest(room=room_id)
        )

    # ------------------------------------------------------------------
    # Egress (recording)
    # ------------------------------------------------------------------

    async def start_room_composite_egress(self, room_id: str) -> str:
        """Start an audio-only room-composite egress writing OGG to S3.

        Returns the egress_id so callers can stop it later. The final file
        location is reported back via the ``egress_ended`` LiveKit webhook,
        which persists the URL onto ``rooms.recording_url``.
        """
        timestamp = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        filepath = f"recordings/{room_id}/{timestamp}.ogg"

        # Tigris (and most non-AWS S3-compatible storage) require path-style
        # addressing — virtual-hosted-style produces a malformed URL like
        # `bucket.https://endpoint/key` because LiveKit naively prepends the
        # bucket as a subdomain to whatever string is in `endpoint`. Strip the
        # protocol prefix as defense-in-depth in case force_path_style ever
        # silently falls back to the legacy mode.
        endpoint = settings.AWS_ENDPOINT_URL
        if endpoint.startswith("https://"):
            endpoint = endpoint[len("https://"):]
        elif endpoint.startswith("http://"):
            endpoint = endpoint[len("http://"):]

        output = api.EncodedFileOutput(
            file_type=api.EncodedFileType.OGG,
            filepath=filepath,
            s3=api.S3Upload(
                access_key=settings.AWS_ACCESS_KEY_ID,
                secret=settings.AWS_SECRET_ACCESS_KEY,
                region=settings.AWS_DEFAULT_REGION,
                bucket=settings.AWS_S3_BUCKET_NAME,
                endpoint=endpoint,
                force_path_style=True,
            ),
        )

        request = api.RoomCompositeEgressRequest(
            room_name=room_id,
            audio_only=True,
            file_outputs=[output],
        )

        egress_info = await self.api.egress.start_room_composite_egress(request)
        return egress_info.egress_id

    async def stop_egress(self, egress_id: str) -> None:
        """Stop a running egress. Safe to call if egress already ended."""
        await self.api.egress.stop_egress(
            api.StopEgressRequest(egress_id=egress_id)
        )

    async def close(self) -> None:
        """Cleanup API client."""
        await self.api.aclose()
