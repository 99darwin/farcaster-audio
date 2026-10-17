"""First-party "casted via Juke" ledger.

Records protocol-level attribution for every user-authored cast published
through a Juke surface (composer, voice note, draft, scheduled cast, room
announcement). Writes are strictly fail-soft: a ledger failure must never
break cast publishing.
"""

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cast_record import CastRecord

logger = logging.getLogger(__name__)


async def record_cast(
    db: AsyncSession, *, fid: int, cast_hash: str, source: str
) -> None:
    """Record a cast published via Juke. Never raises.

    Duplicate hashes (e.g. a retried publish) and any other DB failure are
    logged and swallowed — the ledger is best-effort attribution, not part
    of the publish transaction.
    """
    if not cast_hash:
        logger.warning(
            "[cast-ledger] Missing cast hash (fid=%s, source=%s)", fid, source
        )
        return

    try:
        db.add(CastRecord(fid=fid, cast_hash=cast_hash, source=source))
        await db.commit()
    except Exception:
        logger.warning(
            "[cast-ledger] Failed to record cast %s (fid=%s, source=%s)",
            cast_hash,
            fid,
            source,
            exc_info=True,
        )
        try:
            await db.rollback()
        except Exception:
            logger.warning("[cast-ledger] Rollback failed after ledger error")
