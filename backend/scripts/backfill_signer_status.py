"""Backfill `snap_signers` rows from existing Redis ownership mappings.

One-time (idempotent) management script. Run AFTER `alembic upgrade head`
has created the `snap_signers` table.

Iterates every `snap_signer:<public_key> -> <fid>` mapping in Redis,
calls Neynar once per key to fetch current status, and upserts a row
into `snap_signers`. Safe to re-run; it will overwrite existing rows
with fresh status.

Usage:

    cd backend
    python -m scripts.backfill_signer_status

Environment: requires the same env as the API server (DATABASE_URL,
REDIS_URL, NEYNAR_API_KEY).
"""

import asyncio
import logging

import httpx
import redis.asyncio as aioredis

from app.config import settings
from app.database import async_session
from app.services.snap_signer_service import (
    check_ed25519_signer_status,
    upsert_signer_from_registration,
)

logger = logging.getLogger("backfill_signer_status")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")

OWNERSHIP_KEY_PREFIX = "snap_signer:"


async def _iter_ownership_keys(redis: aioredis.Redis):
    """Yield (public_key, fid) tuples from Redis ownership mappings."""
    cursor = 0
    while True:
        cursor, keys = await redis.scan(
            cursor=cursor, match=f"{OWNERSHIP_KEY_PREFIX}*", count=100
        )
        for key in keys:
            key_str = key.decode() if isinstance(key, bytes) else key
            if not key_str.startswith(OWNERSHIP_KEY_PREFIX):
                continue
            public_key = key_str[len(OWNERSHIP_KEY_PREFIX):]
            fid_raw = await redis.get(key_str)
            if fid_raw is None:
                continue
            try:
                fid = int(fid_raw)
            except (TypeError, ValueError):
                logger.warning("Skipping malformed fid for %s", public_key)
                continue
            yield public_key, fid
        if cursor == 0:
            break


async def main() -> None:
    redis = aioredis.from_url(settings.REDIS_URL)
    processed = 0
    failed = 0

    try:
        async with async_session() as db:
            async for public_key, fid in _iter_ownership_keys(redis):
                try:
                    upstream = await check_ed25519_signer_status(public_key)
                except httpx.HTTPError as exc:
                    failed += 1
                    logger.warning(
                        "Neynar status fetch failed for %s: %s", public_key, exc
                    )
                    continue

                try:
                    await upsert_signer_from_registration(
                        db=db,
                        public_key=public_key,
                        fid=fid,
                        status=upstream.get("status", "unknown"),
                        approval_url=upstream.get("signer_approval_url"),
                    )
                    processed += 1
                    if processed % 10 == 0:
                        logger.info("Backfilled %s rows", processed)
                except Exception as exc:
                    failed += 1
                    logger.exception(
                        "DB upsert failed for %s: %s", public_key, exc
                    )
    finally:
        await redis.close()

    logger.info(
        "Backfill complete: processed=%s failed=%s", processed, failed
    )


if __name__ == "__main__":
    asyncio.run(main())
