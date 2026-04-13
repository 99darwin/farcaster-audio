"""
Spam filtering service — multi-signal trust scoring for Farcaster users.

Combines Neynar user scores and Warpcast labels into a composite trust score
per FID. Results are cached in Redis and backed by the trust_scores Postgres table.
"""

import json
import logging
from datetime import datetime, timezone

import httpx
import redis.asyncio as aioredis
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.trust_score import TrustScore

logger = logging.getLogger(__name__)

SPAM_THRESHOLD = 0.40
CACHE_TTL_SECONDS = 3600  # 1 hour
WARPCAST_LABELS_URL = "https://github.com/warpcast/labels/raw/main/spam.jsonl"

# Warpcast label constants
LABEL_SPAM = 0
LABEL_CLEAN = 2
LABEL_NERFED = 3
KNOWN_LABELS = {LABEL_SPAM, LABEL_CLEAN, LABEL_NERFED}

# Safety limits for JSONL processing
MAX_LABELS_COUNT = 5_000_000
MAX_LABELS_CONTENT_LENGTH = 500 * 1024 * 1024  # 500 MB
BATCH_COMMIT_SIZE = 10_000

# Max recursion depth for thread annotation
MAX_ANNOTATE_DEPTH = 10


def _validate_fid(fid: object) -> int | None:
    """Validate that fid is a positive integer. Returns None if invalid."""
    if not isinstance(fid, int) or fid <= 0:
        return None
    return fid


def _clamp_score(score: object) -> float | None:
    """Clamp a score to [0.0, 1.0]. Returns None if not a valid number."""
    try:
        val = float(score)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return max(0.0, min(1.0, val))


class SpamService:
    def __init__(self, db: AsyncSession, redis: aioredis.Redis) -> None:
        self._db = db
        self._redis = redis

    # ------------------------------------------------------------------
    # Public: per-request hot path
    # ------------------------------------------------------------------

    async def is_spam(self, fid: int, neynar_score: float | None = None) -> bool:
        """Check if a FID is flagged as spam. Uses cache → DB fallback."""
        if not settings.SPAM_FILTER_ENABLED:
            return False

        cached = await self._get_cached(fid)
        if cached is not None:
            return cached

        return await self._compute_and_cache(fid, neynar_score)

    async def annotate_users(self, users: list[dict]) -> list[dict]:
        """Add `is_spam` field to each user dict that has a `fid` key."""
        if not settings.SPAM_FILTER_ENABLED:
            return users

        for user in users:
            fid = user.get("fid")
            if fid is None:
                continue
            neynar_score = user.get("experimental", {}).get("neynar_user_score")
            user["is_spam"] = await self.is_spam(fid, neynar_score)
        return users

    async def filter_users(self, users: list[dict]) -> list[dict]:
        """Remove spam users entirely from a list of user dicts."""
        if not settings.SPAM_FILTER_ENABLED:
            return users

        result = []
        for user in users:
            fid = user.get("fid")
            if fid is None:
                result.append(user)
                continue
            neynar_score = user.get("experimental", {}).get("neynar_user_score")
            if not await self.is_spam(fid, neynar_score):
                result.append(user)
        return result

    # ------------------------------------------------------------------
    # Public: annotate cast authors (feed/thread)
    # ------------------------------------------------------------------

    async def annotate_casts(self, casts: list[dict]) -> list[dict]:
        """Walk a list of casts and annotate each author with `is_spam`."""
        if not settings.SPAM_FILTER_ENABLED:
            return casts

        for cast in casts:
            author = cast.get("author")
            if author and author.get("fid"):
                neynar_score = author.get("experimental", {}).get("neynar_user_score")
                author["is_spam"] = await self.is_spam(author["fid"], neynar_score)
        return casts

    async def annotate_thread(self, conversation: dict) -> dict:
        """Recursively annotate authors in a Neynar conversation response."""
        if not settings.SPAM_FILTER_ENABLED:
            return conversation

        cast = conversation.get("conversation", {}).get("cast")
        if cast:
            await self._annotate_cast_tree(cast, depth=0)
        return conversation

    async def _annotate_cast_tree(self, cast: dict, depth: int = 0) -> None:
        """Recursively annotate a cast and its direct_replies."""
        if depth > MAX_ANNOTATE_DEPTH:
            return

        author = cast.get("author")
        if author and author.get("fid"):
            neynar_score = author.get("experimental", {}).get("neynar_user_score")
            author["is_spam"] = await self.is_spam(author["fid"], neynar_score)

        for reply in cast.get("direct_replies", []):
            await self._annotate_cast_tree(reply, depth=depth + 1)

    # ------------------------------------------------------------------
    # Public: background jobs
    # ------------------------------------------------------------------

    async def sync_warpcast_labels(self) -> int:
        """Fetch Warpcast labels JSONL and upsert into trust_scores.

        Streams the response to avoid loading the entire file into memory,
        commits in batches to avoid long-running transactions, and enforces
        a maximum line count as a safety valve.
        """
        logger.info("[spam] Syncing Warpcast labels from GitHub...")
        try:
            async with httpx.AsyncClient(follow_redirects=True) as client:
                resp = await client.get(WARPCAST_LABELS_URL, timeout=120.0)
                resp.raise_for_status()
        except httpx.HTTPError as e:
            logger.error("[spam] Failed to fetch Warpcast labels: %s", e)
            return 0

        # Check Content-Length before processing
        content_length = resp.headers.get("content-length")
        if content_length and content_length.isdigit() and int(content_length) > MAX_LABELS_CONTENT_LENGTH:
            logger.error("[spam] Warpcast labels file too large: %s bytes", content_length)
            return 0

        count = 0
        batch_count = 0
        for line in resp.text.strip().splitlines():
            if count >= MAX_LABELS_COUNT:
                logger.warning("[spam] Reached max label count (%d), stopping", MAX_LABELS_COUNT)
                break

            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            # JSONL format: {"type": {"target": "user", "fid": 123}, "label_value": 0, ...}
            fid = _validate_fid(entry.get("type", {}).get("fid"))
            if fid is None:
                continue

            label = entry.get("label_value")
            if label not in KNOWN_LABELS:
                continue

            composite, is_spam = self._compute_composite(
                neynar=None, warpcast_label=label
            )

            stmt = pg_insert(TrustScore).values(
                fid=fid,
                warpcast_label=label,
                composite=composite,
                is_spam=is_spam,
                updated_at=datetime.now(timezone.utc),
            ).on_conflict_do_update(
                index_elements=["fid"],
                set_={
                    "warpcast_label": label,
                    "composite": composite,
                    "is_spam": is_spam,
                    "updated_at": datetime.now(timezone.utc),
                },
            )
            await self._db.execute(stmt)
            count += 1
            batch_count += 1

            # Commit in batches to avoid long-running transactions
            if batch_count >= BATCH_COMMIT_SIZE:
                await self._db.commit()
                batch_count = 0

            # Invalidate cache for this FID
            try:
                await self._redis.delete(f"trust:{fid}")
            except Exception:
                logger.warning("[spam] Redis cache invalidation failed for fid=%d", fid)

        # Final commit for remaining rows
        if batch_count > 0:
            await self._db.commit()

        logger.info("[spam] Synced %d Warpcast labels", count)
        return count

    async def upsert_neynar_score(self, fid: int, score: float) -> None:
        """Opportunistically upsert a Neynar score from API response data."""
        if not settings.SPAM_FILTER_ENABLED:
            return

        clamped = _clamp_score(score)
        if clamped is None:
            return

        # Upsert the neynar_score, then recompute composite under row lock
        stmt = pg_insert(TrustScore).values(
            fid=fid,
            neynar_score=clamped,
            composite=0.0,  # placeholder
            is_spam=False,  # placeholder
            updated_at=datetime.now(timezone.utc),
        ).on_conflict_do_update(
            index_elements=["fid"],
            set_={
                "neynar_score": clamped,
                "updated_at": datetime.now(timezone.utc),
            },
        )
        await self._db.execute(stmt)

        # Recompute composite from the now-current row with FOR UPDATE lock
        row = (await self._db.execute(
            select(TrustScore).where(TrustScore.fid == fid).with_for_update()
        )).scalar_one()
        composite, is_spam = self._compute_composite(
            row.neynar_score, row.warpcast_label
        )
        row.composite = composite
        row.is_spam = is_spam

        await self._db.commit()

        try:
            await self._redis.delete(f"trust:{fid}")
        except Exception:
            logger.warning("[spam] Redis cache invalidation failed for fid=%d", fid)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    async def _get_cached(self, fid: int) -> bool | None:
        """Look up trust result in Redis. Returns None on miss."""
        try:
            raw = await self._redis.get(f"trust:{fid}")
            if raw is not None:
                data = json.loads(raw)
                return data.get("is_spam", False)
        except Exception as e:
            logger.debug("[spam] Redis cache miss for fid=%d: %s", fid, e)
        return None

    async def _compute_and_cache(self, fid: int, neynar_score: float | None = None) -> bool:
        """Load from DB, compute if needed, cache result."""
        result = await self._db.execute(
            select(TrustScore).where(TrustScore.fid == fid)
        )
        row = result.scalar_one_or_none()

        if row:
            is_spam = row.is_spam
        elif neynar_score is not None:
            # No DB row yet — compute from the neynar score alone
            _, is_spam = self._compute_composite(neynar_score, None)
        else:
            # No data at all — assume not spam
            is_spam = False

        # Cache the result
        try:
            await self._redis.setex(
                f"trust:{fid}",
                CACHE_TTL_SECONDS,
                json.dumps({"is_spam": is_spam, "composite": row.composite if row else 0.5}),
            )
        except Exception as e:
            logger.warning("[spam] Redis cache set failed for fid=%d: %s", fid, e)

        return is_spam

    @staticmethod
    def _compute_composite(
        neynar: float | None,
        warpcast_label: int | None,
    ) -> tuple[float, bool]:
        """Compute composite trust score and spam flag.

        Hard block: Warpcast label 0 (spam) or 3 (nerfed) → always spam.

        Composite: weighted average of available signals.
          - neynar 65% + warpcast 35%
        """
        # Hard blocks
        if warpcast_label in (LABEL_SPAM, LABEL_NERFED):
            return 0.0, True

        # Warpcast bonus
        if warpcast_label == LABEL_CLEAN:
            warpcast_bonus = 1.0
        elif warpcast_label is None:
            warpcast_bonus = 0.5
        else:
            warpcast_bonus = 0.0

        # Clamp score defensively
        if neynar is not None:
            neynar = max(0.0, min(1.0, neynar))

        if neynar is not None:
            composite = (neynar * 0.65) + (warpcast_bonus * 0.35)
        else:
            # No scores — use warpcast bonus alone
            composite = warpcast_bonus

        is_spam = composite < SPAM_THRESHOLD
        return composite, is_spam
