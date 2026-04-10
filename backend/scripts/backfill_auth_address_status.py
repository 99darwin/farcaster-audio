"""Backfill `auth_addresses` rows from existing Redis ownership mappings.

One-time (idempotent) management script. Run AFTER `alembic upgrade head`
has created the `auth_addresses` table.

Iterates every `auth_addr:<address> -> <fid>` mapping in Redis, calls
Neynar once per address to fetch current status, and upserts a row into
`auth_addresses`. Safe to re-run.

Usage:

    cd backend
    python -m scripts.backfill_auth_address_status

Environment: requires the same env as the API server.
"""

import asyncio
import logging

import httpx
import redis.asyncio as aioredis

from app.config import settings
from app.database import async_session
from app.services.auth_address_service import (
    check_auth_address_status,
    upsert_auth_address_from_registration,
)

logger = logging.getLogger("backfill_auth_address_status")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")

OWNERSHIP_KEY_PREFIX = "auth_addr:"


async def _iter_ownership_keys(redis: aioredis.Redis):
    """Yield (address, fid) tuples from Redis ownership mappings."""
    cursor = 0
    while True:
        cursor, keys = await redis.scan(
            cursor=cursor, match=f"{OWNERSHIP_KEY_PREFIX}*", count=100
        )
        for key in keys:
            key_str = key.decode() if isinstance(key, bytes) else key
            if not key_str.startswith(OWNERSHIP_KEY_PREFIX):
                continue
            address = key_str[len(OWNERSHIP_KEY_PREFIX):]
            # Skip rate-limit keys that share the prefix.
            if address.startswith("invalidate_rate") or address.startswith("rate"):
                continue
            fid_raw = await redis.get(key_str)
            if fid_raw is None:
                continue
            try:
                fid = int(fid_raw)
            except (TypeError, ValueError):
                logger.warning("Skipping malformed fid for %s", address)
                continue
            yield address, fid
        if cursor == 0:
            break


async def main() -> None:
    redis = aioredis.from_url(settings.REDIS_URL)
    processed = 0
    failed = 0

    try:
        async with async_session() as db:
            async for address, fid in _iter_ownership_keys(redis):
                try:
                    upstream = await check_auth_address_status(address)
                except httpx.HTTPError as exc:
                    failed += 1
                    logger.warning(
                        "Neynar status fetch failed for %s: %s", address, exc
                    )
                    continue

                try:
                    await upsert_auth_address_from_registration(
                        db=db,
                        address=address,
                        fid=fid,
                        status=upstream.get("status", "unknown"),
                        approval_url=upstream.get("auth_address_approval_url"),
                    )
                    processed += 1
                    if processed % 10 == 0:
                        logger.info("Backfilled %s rows", processed)
                except Exception as exc:
                    failed += 1
                    logger.exception(
                        "DB upsert failed for %s: %s", address, exc
                    )
    finally:
        await redis.close()

    logger.info(
        "Backfill complete: processed=%s failed=%s", processed, failed
    )


if __name__ == "__main__":
    asyncio.run(main())
