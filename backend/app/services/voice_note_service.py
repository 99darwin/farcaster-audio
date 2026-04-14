"""
VoiceNoteService — coordinates DB operations for voice notes.

Handles CRUD, feed queries, play tracking, and reactions.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import delete, func as sa_func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.voice_note import VoiceNote, VoiceNotePlay, VoiceNoteReaction
from app.schemas.voice_note import (
    VoiceNoteAuthor,
    VoiceNoteDetailResponse,
    VoiceNoteResponse,
)
from app.services.storage_service import StorageService

logger = logging.getLogger(__name__)

_storage: StorageService | None = None


def _get_storage() -> StorageService:
    global _storage
    if _storage is None:
        _storage = StorageService()
    return _storage


def _voice_note_to_response(vn: VoiceNote) -> VoiceNoteResponse:
    """Convert a VoiceNote model to a response schema with a presigned GET URL."""
    storage = _get_storage()
    return VoiceNoteResponse(
        id=str(vn.id),
        fid=vn.fid,
        duration_ms=vn.duration_ms,
        audio_url=storage.generate_presigned_get_url(vn.audio_url),
        audio_size=vn.audio_size,
        waveform_peaks=vn.waveform_peaks,
        transcript=vn.transcript,
        transcript_lang=vn.transcript_lang,
        transcript_words=vn.transcript_words,
        cast_hash=vn.cast_hash,
        cast_url=vn.cast_url,
        caption=vn.caption,
        created_at=vn.created_at.isoformat(),
        deleted_at=vn.deleted_at.isoformat() if vn.deleted_at else None,
    )


def _user_to_author(user: User) -> VoiceNoteAuthor:
    return VoiceNoteAuthor(
        fid=user.fid,
        username=user.username or "",
        display_name=user.display_name or "",
        pfp_url=user.pfp_url,
    )


async def create_voice_note(
    db: AsyncSession,
    fid: int,
    upload_id: str,
    duration_ms: int,
    audio_size: int,
    caption: str | None,
    object_key: str,
) -> VoiceNote:
    """Create a new voice note record."""
    vn = VoiceNote(
        id=uuid.uuid4(),
        fid=fid,
        duration_ms=duration_ms,
        audio_url=object_key,
        audio_size=audio_size,
        caption=caption if caption else None,
    )
    db.add(vn)
    await db.commit()
    await db.refresh(vn)
    return vn


async def get_voice_note(
    db: AsyncSession,
    voice_note_id: uuid.UUID,
    viewer_fid: int | None = None,
) -> VoiceNoteDetailResponse:
    """Fetch a single voice note with author, reaction counts, and play count."""
    result = await db.execute(
        select(VoiceNote, User)
        .join(User, User.fid == VoiceNote.fid)
        .where(VoiceNote.id == voice_note_id, VoiceNote.deleted_at.is_(None))
    )
    row = result.one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Voice note not found")

    vn, user = row.tuple()

    # Reaction counts
    count_result = await db.execute(
        select(VoiceNoteReaction.reaction_type, sa_func.count())
        .where(VoiceNoteReaction.voice_note_id == voice_note_id)
        .group_by(VoiceNoteReaction.reaction_type)
    )
    reaction_counts: dict[str, int] = {row[0]: row[1] for row in count_result.all()}

    # Viewer reactions
    viewer_reactions: list[str] = []
    if viewer_fid:
        vr_result = await db.execute(
            select(VoiceNoteReaction.reaction_type).where(
                VoiceNoteReaction.voice_note_id == voice_note_id,
                VoiceNoteReaction.fid == viewer_fid,
            )
        )
        viewer_reactions = [r[0] for r in vr_result.all()]

    # Play count
    play_result = await db.execute(
        select(sa_func.count()).where(VoiceNotePlay.voice_note_id == voice_note_id)
    )
    play_count = play_result.scalar() or 0

    return VoiceNoteDetailResponse(
        voice_note=_voice_note_to_response(vn),
        author=_user_to_author(user),
        reaction_counts=reaction_counts,
        viewer_reactions=viewer_reactions,
        play_count=play_count,
    )


async def get_feed(
    db: AsyncSession,
    fid: int,
    following_fids: list[int],
    cursor: str | None,
    limit: int,
) -> tuple[list[VoiceNoteDetailResponse], str | None]:
    """Fetch a paginated feed of voice notes from followed users + self."""
    all_fids = list(set(following_fids + [fid]))

    query = (
        select(VoiceNote, User)
        .join(User, User.fid == VoiceNote.fid)
        .where(VoiceNote.fid.in_(all_fids), VoiceNote.deleted_at.is_(None))
        .order_by(VoiceNote.created_at.desc())
        .limit(limit + 1)
    )

    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid cursor")
        query = query.where(VoiceNote.created_at < cursor_dt)

    result = await db.execute(query)
    rows = result.all()

    next_cursor: str | None = None
    if len(rows) > limit:
        rows = rows[:limit]
        last_vn = rows[-1][0]
        next_cursor = last_vn.created_at.isoformat()

    items: list[VoiceNoteDetailResponse] = []
    for row in rows:
        vn, user = row.tuple()

        # Batch reaction counts per voice note
        count_result = await db.execute(
            select(VoiceNoteReaction.reaction_type, sa_func.count())
            .where(VoiceNoteReaction.voice_note_id == vn.id)
            .group_by(VoiceNoteReaction.reaction_type)
        )
        reaction_counts = {r[0]: r[1] for r in count_result.all()}

        # Viewer reactions
        vr_result = await db.execute(
            select(VoiceNoteReaction.reaction_type).where(
                VoiceNoteReaction.voice_note_id == vn.id,
                VoiceNoteReaction.fid == fid,
            )
        )
        viewer_reactions = [r[0] for r in vr_result.all()]

        # Play count
        play_result = await db.execute(
            select(sa_func.count()).where(VoiceNotePlay.voice_note_id == vn.id)
        )
        play_count = play_result.scalar() or 0

        items.append(
            VoiceNoteDetailResponse(
                voice_note=_voice_note_to_response(vn),
                author=_user_to_author(user),
                reaction_counts=reaction_counts,
                viewer_reactions=viewer_reactions,
                play_count=play_count,
            )
        )

    return items, next_cursor


async def get_user_voice_notes(
    db: AsyncSession,
    fid: int,
    viewer_fid: int | None,
    cursor: str | None,
    limit: int,
) -> tuple[list[VoiceNoteDetailResponse], str | None]:
    """Fetch voice notes by a specific user, paginated."""
    query = (
        select(VoiceNote, User)
        .join(User, User.fid == VoiceNote.fid)
        .where(VoiceNote.fid == fid, VoiceNote.deleted_at.is_(None))
        .order_by(VoiceNote.created_at.desc())
        .limit(limit + 1)
    )

    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid cursor")
        query = query.where(VoiceNote.created_at < cursor_dt)

    result = await db.execute(query)
    rows = result.all()

    next_cursor: str | None = None
    if len(rows) > limit:
        rows = rows[:limit]
        last_vn = rows[-1][0]
        next_cursor = last_vn.created_at.isoformat()

    items: list[VoiceNoteDetailResponse] = []
    for row in rows:
        vn, user = row.tuple()

        count_result = await db.execute(
            select(VoiceNoteReaction.reaction_type, sa_func.count())
            .where(VoiceNoteReaction.voice_note_id == vn.id)
            .group_by(VoiceNoteReaction.reaction_type)
        )
        reaction_counts = {r[0]: r[1] for r in count_result.all()}

        viewer_reactions: list[str] = []
        if viewer_fid:
            vr_result = await db.execute(
                select(VoiceNoteReaction.reaction_type).where(
                    VoiceNoteReaction.voice_note_id == vn.id,
                    VoiceNoteReaction.fid == viewer_fid,
                )
            )
            viewer_reactions = [r[0] for r in vr_result.all()]

        play_result = await db.execute(
            select(sa_func.count()).where(VoiceNotePlay.voice_note_id == vn.id)
        )
        play_count = play_result.scalar() or 0

        items.append(
            VoiceNoteDetailResponse(
                voice_note=_voice_note_to_response(vn),
                author=_user_to_author(user),
                reaction_counts=reaction_counts,
                viewer_reactions=viewer_reactions,
                play_count=play_count,
            )
        )

    return items, next_cursor


async def get_recent_voice_notes(
    db: AsyncSession,
    cursor: str | None,
    limit: int,
) -> tuple[list[VoiceNoteDetailResponse], str | None]:
    """Fetch all voice notes (public), ordered by created_at DESC with cursor pagination."""
    query = (
        select(VoiceNote, User)
        .join(User, User.fid == VoiceNote.fid)
        .where(VoiceNote.deleted_at.is_(None))
        .order_by(VoiceNote.created_at.desc())
        .limit(limit + 1)
    )

    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid cursor")
        query = query.where(VoiceNote.created_at < cursor_dt)

    result = await db.execute(query)
    rows = result.all()

    next_cursor: str | None = None
    if len(rows) > limit:
        rows = rows[:limit]
        last_vn = rows[-1][0]
        next_cursor = last_vn.created_at.isoformat()

    vn_ids = [row[0].id for row in rows]

    # Batch reaction counts (1 query instead of N)
    reaction_map: dict[uuid.UUID, dict[str, int]] = {vid: {} for vid in vn_ids}
    if vn_ids:
        rc_result = await db.execute(
            select(
                VoiceNoteReaction.voice_note_id,
                VoiceNoteReaction.reaction_type,
                sa_func.count(),
            )
            .where(VoiceNoteReaction.voice_note_id.in_(vn_ids))
            .group_by(VoiceNoteReaction.voice_note_id, VoiceNoteReaction.reaction_type)
        )
        for vid, rtype, cnt in rc_result.all():
            reaction_map[vid][rtype] = cnt

    # Batch play counts (1 query instead of N)
    play_map: dict[uuid.UUID, int] = {vid: 0 for vid in vn_ids}
    if vn_ids:
        pc_result = await db.execute(
            select(VoiceNotePlay.voice_note_id, sa_func.count())
            .where(VoiceNotePlay.voice_note_id.in_(vn_ids))
            .group_by(VoiceNotePlay.voice_note_id)
        )
        for vid, cnt in pc_result.all():
            play_map[vid] = cnt

    items: list[VoiceNoteDetailResponse] = []
    for row in rows:
        vn, user = row.tuple()
        items.append(
            VoiceNoteDetailResponse(
                voice_note=_voice_note_to_response(vn),
                author=_user_to_author(user),
                reaction_counts=reaction_map.get(vn.id, {}),
                viewer_reactions=[],
                play_count=play_map.get(vn.id, 0),
            )
        )

    return items, next_cursor


async def record_play(
    db: AsyncSession,
    voice_note_id: uuid.UUID,
    listener_fid: int | None,
    listened_ms: int,
    completed: bool,
    source: str,
    user_agent: str | None,
) -> None:
    """Insert a play tracking record."""
    # Verify voice note exists
    result = await db.execute(
        select(VoiceNote.id).where(
            VoiceNote.id == voice_note_id, VoiceNote.deleted_at.is_(None)
        )
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Voice note not found")

    play = VoiceNotePlay(
        voice_note_id=voice_note_id,
        listener_fid=listener_fid,
        listened_ms=listened_ms,
        completed=completed,
        source=source,
        user_agent=user_agent,
    )
    db.add(play)
    await db.commit()


async def add_reaction(
    db: AsyncSession,
    voice_note_id: uuid.UUID,
    fid: int,
    reaction_type: str,
) -> None:
    """Add a reaction (idempotent upsert via composite PK conflict)."""
    # Verify voice note exists
    result = await db.execute(
        select(VoiceNote.id).where(
            VoiceNote.id == voice_note_id, VoiceNote.deleted_at.is_(None)
        )
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Voice note not found")

    from sqlalchemy.dialects.postgresql import insert as pg_insert

    stmt = pg_insert(VoiceNoteReaction).values(
        voice_note_id=voice_note_id,
        fid=fid,
        reaction_type=reaction_type,
    ).on_conflict_do_nothing()
    await db.execute(stmt)
    await db.commit()


async def remove_reaction(
    db: AsyncSession,
    voice_note_id: uuid.UUID,
    fid: int,
    reaction_type: str,
) -> None:
    """Remove a reaction."""
    result = await db.execute(
        delete(VoiceNoteReaction).where(
            VoiceNoteReaction.voice_note_id == voice_note_id,
            VoiceNoteReaction.fid == fid,
            VoiceNoteReaction.reaction_type == reaction_type,
        )
    )
    await db.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Reaction not found")


async def soft_delete(
    db: AsyncSession,
    voice_note_id: uuid.UUID,
    fid: int,
) -> VoiceNote:
    """Soft-delete a voice note. Only the author can delete."""
    result = await db.execute(
        select(VoiceNote).where(
            VoiceNote.id == voice_note_id, VoiceNote.deleted_at.is_(None)
        )
    )
    vn = result.scalar_one_or_none()
    if not vn:
        raise HTTPException(status_code=404, detail="Voice note not found")
    if vn.fid != fid:
        raise HTTPException(status_code=403, detail="Only the author can delete this voice note")

    vn.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(vn)
    return vn
