"""
Spam filtering service — multi-signal trust scoring for Farcaster users.

Hypersnap exposes no ``neynar_user_score``, so trust is scored locally from
signals present on every Hypersnap (Neynar-shaped) user object:

  - follower count (log-scaled) and follow-farming ratio
  - FID age (``registered_at``)
  - profile completeness: pfp, a non-default username, verified addresses
  - ``power_badge`` when an upstream happens to provide it

The heuristic score is combined with Warpcast labels into a composite trust
score per FID. Results are cached in Redis and backed by the trust_scores
Postgres table.
"""

import json
import logging
import math
import re
from collections.abc import Mapping
from datetime import datetime, timezone

import httpx
import redis.asyncio as aioredis
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.trust_score import TrustScore

logger = logging.getLogger(__name__)

SPAM_THRESHOLD = 0.35
CACHE_TTL_SECONDS = 3600  # 1 hour
WARPCAST_LABELS_URL = "https://github.com/warpcast/labels/raw/main/spam.jsonl"

# Composite weights: heuristic score vs. Warpcast label bonus
SCORE_WEIGHT = 0.65
WARPCAST_WEIGHT = 0.35

# Values for trust_scores.source
SOURCE_HEURISTIC = "heuristic"
SOURCE_NEYNAR_LEGACY = "neynar"

# Warpcast label constants
LABEL_SPAM = 0
LABEL_CLEAN = 2
LABEL_NERFED = 3
KNOWN_LABELS = {LABEL_SPAM, LABEL_CLEAN, LABEL_NERFED}

# Heuristic weights (sum to 1.0)
FOLLOWER_WEIGHT = 0.50
AGE_WEIGHT = 0.20
PROFILE_WEIGHT = 0.30
# Value used for any heuristic signal the user object doesn't carry
NEUTRAL_SIGNAL = 0.5
# Follower count at which the follower signal saturates (log10 scale)
FOLLOWER_SATURATION = 1_000
# FID age (days) at which the age signal saturates
AGE_SATURATION_DAYS = 365
# Follow-farming: following many accounts with almost no one following back
FOLLOW_FARM_MIN_FOLLOWING = 500
FOLLOW_FARM_RATIO = 10
FOLLOW_FARM_PENALTY = 0.5
# Auto-generated usernames ("user1234567", "!1234567", "fid-1234567")
DEFAULT_USERNAME_RE = re.compile(r"^(?:user|!|fid-?)\d+$", re.IGNORECASE)

# Safety limits for JSONL processing
MAX_LABELS_COUNT = 5_000_000
MAX_LABELS_CONTENT_LENGTH = 500 * 1024 * 1024  # 500 MB
BATCH_COMMIT_SIZE = 10_000

# Max recursion depth for thread annotation
MAX_ANNOTATE_DEPTH = 10


def _validate_fid(fid: object) -> int | None:
    """Validate that fid is a positive integer. Returns None if invalid."""
    if not isinstance(fid, int) or isinstance(fid, bool) or fid <= 0:
        return None
    return fid


def _clamp_score(score: object) -> float | None:
    """Clamp a score to [0.0, 1.0]. Returns None if not a valid number."""
    try:
        val = float(score)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if math.isnan(val):
        return None
    return max(0.0, min(1.0, val))


def _non_negative_int(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _follower_signal(followers: int) -> float:
    return min(1.0, math.log10(followers + 1) / math.log10(FOLLOWER_SATURATION + 1))


def _age_signal(registered_at: datetime, now: datetime) -> float:
    age_days = max(0.0, (now - registered_at).total_seconds() / 86_400)
    return min(1.0, age_days / AGE_SATURATION_DAYS)


def _has_verifications(user: Mapping) -> bool:
    if user.get("verifications"):
        return True
    verified = user.get("verified_addresses")
    if not isinstance(verified, Mapping):
        return False
    return bool(verified.get("eth_addresses") or verified.get("sol_addresses"))


def _has_custom_username(user: Mapping) -> bool:
    username = user.get("username")
    return isinstance(username, str) and not DEFAULT_USERNAME_RE.match(username)


def _profile_signal(user: Mapping) -> float:
    """Average of the profile checks; a check whose key is absent is neutral.

    A present-but-empty field (``pfp_url: null``) is a real negative; an absent
    key just means the upstream object is sparse.
    """
    checks = (
        ("pfp_url" in user, bool(user.get("pfp_url"))),
        ("username" in user, _has_custom_username(user)),
        (
            "verifications" in user or "verified_addresses" in user,
            _has_verifications(user),
        ),
    )
    parts = [float(passed) if present else NEUTRAL_SIGNAL for present, passed in checks]
    return sum(parts) / len(parts)


def has_trust_signals(user: Mapping | None) -> bool:
    """True if the user object is complete enough to yield a verdict.

    Verdicts are cached per FID, so a sparse object (webhook stub, partial
    enrichment) must not be scored: it can land on the other side of the
    threshold from the full object for the same FID and pin that verdict for
    the cache TTL. Only ``power_badge`` or every scored field qualifies; a
    sparse object yields no verdict (not spam, uncached) until a full one
    arrives.
    """
    if not isinstance(user, Mapping):
        return False
    if user.get("power_badge") is True:
        return True
    return (
        _non_negative_int(user.get("follower_count")) is not None
        and _parse_timestamp(user.get("registered_at")) is not None
        and "pfp_url" in user
        and "username" in user
        and ("verifications" in user or "verified_addresses" in user)
    )


def compute_user_score(user: Mapping, now: datetime | None = None) -> float:
    """Score a Hypersnap user object in [0.0, 1.0]; higher is more trusted.

    Missing signals count as neutral (``NEUTRAL_SIGNAL``) rather than as
    failures. SpamService only scores objects passing ``has_trust_signals``.
    """
    if user.get("power_badge") is True:
        return 1.0

    now = now or datetime.now(timezone.utc)
    followers = _non_negative_int(user.get("follower_count"))
    following = _non_negative_int(user.get("following_count"))
    registered_at = _parse_timestamp(user.get("registered_at"))

    follower_part = NEUTRAL_SIGNAL if followers is None else _follower_signal(followers)
    age_part = (
        NEUTRAL_SIGNAL if registered_at is None else _age_signal(registered_at, now)
    )
    score = (
        FOLLOWER_WEIGHT * follower_part
        + AGE_WEIGHT * age_part
        + PROFILE_WEIGHT * _profile_signal(user)
    )

    is_follow_farming = (
        followers is not None
        and following is not None
        and following >= FOLLOW_FARM_MIN_FOLLOWING
        and followers * FOLLOW_FARM_RATIO < following
    )
    if is_follow_farming:
        score *= FOLLOW_FARM_PENALTY

    return _clamp_score(score) or 0.0


def compute_composite(
    score: float | None,
    warpcast_label: int | None,
) -> tuple[float, bool]:
    """Compute composite trust score and spam flag.

    Hard block: Warpcast label 0 (spam) or 3 (nerfed) → always spam.

    Composite: weighted average of available signals.
      - heuristic score 65% + warpcast 35%
    """
    if warpcast_label in (LABEL_SPAM, LABEL_NERFED):
        return 0.0, True

    if warpcast_label == LABEL_CLEAN:
        warpcast_bonus = 1.0
    elif warpcast_label is None:
        warpcast_bonus = 0.5
    else:
        warpcast_bonus = 0.0

    if score is not None:
        score = max(0.0, min(1.0, score))
        composite = (score * SCORE_WEIGHT) + (warpcast_bonus * WARPCAST_WEIGHT)
    else:
        composite = warpcast_bonus

    return composite, composite < SPAM_THRESHOLD


def _score_user(user: Mapping | None) -> float | None:
    """Heuristic score for a user dict, or None when it is too sparse to score."""
    if not has_trust_signals(user):
        return None
    return compute_user_score(user)  # type: ignore[arg-type]


class SpamService:
    def __init__(self, db: AsyncSession, redis: aioredis.Redis) -> None:
        self._db = db
        self._redis = redis

    # ------------------------------------------------------------------
    # Public: per-request hot path
    # ------------------------------------------------------------------

    async def is_spam(self, fid: int, user: Mapping | None = None) -> bool:
        """Check if a FID is flagged as spam. Uses cache → DB → heuristic.

        ``user`` is the Hypersnap user object for ``fid`` when the caller has
        one; it is scored only when no cached or stored verdict exists.
        """
        if not settings.SPAM_FILTER_ENABLED:
            return False

        cached = await self._get_cached(fid)
        if cached is not None:
            return cached

        return await self._compute_and_cache(fid, user)

    async def annotate_users(self, users: list[dict]) -> list[dict]:
        """Add `is_spam` field to each user dict that has a `fid` key."""
        if not settings.SPAM_FILTER_ENABLED:
            return users

        await self._annotate_author_list(users)
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
            if not await self.is_spam(fid, user):
                result.append(user)
        return result

    # ------------------------------------------------------------------
    # Public: annotate cast authors (feed/thread)
    # ------------------------------------------------------------------

    async def annotate_casts(self, casts: list[dict]) -> list[dict]:
        """Walk a list of casts and annotate each author with `is_spam`."""
        if not settings.SPAM_FILTER_ENABLED:
            return casts

        authors = [cast.get("author") for cast in casts if cast.get("author")]
        await self._annotate_author_list(authors)
        return casts

    async def annotate_thread(self, conversation: dict) -> dict:
        """Recursively annotate authors in a conversation response."""
        if not settings.SPAM_FILTER_ENABLED:
            return conversation

        thread = conversation.get("conversation", {})
        cast = thread.get("cast")
        if cast:
            await self._annotate_cast_tree(cast, depth=0)
        for ancestor in thread.get("chronological_parent_casts") or []:
            await self._annotate_cast_tree(ancestor, depth=MAX_ANNOTATE_DEPTH)
        return conversation

    async def _annotate_cast_tree(self, cast: dict, depth: int = 0) -> None:
        """Recursively annotate a cast and its direct_replies."""
        if depth > MAX_ANNOTATE_DEPTH:
            return

        author = cast.get("author")
        if author and author.get("fid"):
            author["is_spam"] = await self.is_spam(author["fid"], author)

        for reply in cast.get("direct_replies", []):
            await self._annotate_cast_tree(reply, depth=depth + 1)

    async def _annotate_author_list(self, authors: list[dict]) -> None:
        """Batch annotate author dicts to avoid sequential cache/DB lookups."""
        fid_to_authors: dict[int, list[dict]] = {}
        user_scores: dict[int, float | None] = {}

        for author in authors:
            fid = _validate_fid(author.get("fid"))
            if fid is None:
                continue
            fid_to_authors.setdefault(fid, []).append(author)
            score = _score_user(author)
            if score is not None or fid not in user_scores:
                user_scores[fid] = score

        if not fid_to_authors:
            return

        fids = list(fid_to_authors)
        results: dict[int, bool] = {}
        missed_fids: list[int] = []

        try:
            cached_values = await self._redis.mget([f"trust:{fid}" for fid in fids])
        except Exception as e:
            logger.debug("[spam] Redis batch cache read failed: %s", e)
            cached_values = [None] * len(fids)

        for fid, raw in zip(fids, cached_values):
            if raw is None:
                missed_fids.append(fid)
                continue
            try:
                data = json.loads(raw)
                results[fid] = data.get("is_spam", False)
            except Exception:
                missed_fids.append(fid)

        rows_by_fid: dict[int, TrustScore] = {}
        if missed_fids:
            db_rows = await self._db.execute(
                select(TrustScore).where(TrustScore.fid.in_(missed_fids))
            )
            rows_by_fid = {row.fid: row for row in db_rows.scalars().all()}

        cache_pipe = self._redis.pipeline()
        should_write_cache = False
        for fid in missed_fids:
            verdict = self._verdict(rows_by_fid.get(fid), user_scores.get(fid))
            if verdict is None:
                # No signals at all — not spam, but don't cache so a later
                # call carrying a full user object can still score it.
                results[fid] = False
                continue
            composite, is_spam = verdict
            results[fid] = is_spam
            cache_pipe.setex(
                f"trust:{fid}",
                CACHE_TTL_SECONDS,
                json.dumps({"is_spam": is_spam, "composite": composite}),
            )
            should_write_cache = True

        if should_write_cache:
            try:
                await cache_pipe.execute()
            except Exception as e:
                logger.warning("[spam] Redis batch cache set failed: %s", e)

        for fid, author_list in fid_to_authors.items():
            for author in author_list:
                author["is_spam"] = results.get(fid, False)

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
        if (
            content_length
            and content_length.isdigit()
            and int(content_length) > MAX_LABELS_CONTENT_LENGTH
        ):
            logger.error(
                "[spam] Warpcast labels file too large: %s bytes", content_length
            )
            return 0

        count = 0
        batch_count = 0
        for line in resp.text.strip().splitlines():
            if count >= MAX_LABELS_COUNT:
                logger.warning(
                    "[spam] Reached max label count (%d), stopping", MAX_LABELS_COUNT
                )
                break

            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            # JSONL format: {"type": {"target": "user", "fid": 123}, "label_value": 0}
            fid = _validate_fid(entry.get("type", {}).get("fid"))
            if fid is None:
                continue

            label = entry.get("label_value")
            if label not in KNOWN_LABELS:
                continue

            composite, is_spam = compute_composite(score=None, warpcast_label=label)

            stmt = (
                pg_insert(TrustScore)
                .values(
                    fid=fid,
                    warpcast_label=label,
                    composite=composite,
                    is_spam=is_spam,
                    updated_at=datetime.now(timezone.utc),
                )
                .on_conflict_do_update(
                    index_elements=["fid"],
                    set_={
                        "warpcast_label": label,
                        "composite": composite,
                        "is_spam": is_spam,
                        "updated_at": datetime.now(timezone.utc),
                    },
                )
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

    async def upsert_score(
        self, fid: int, score: float, source: str = SOURCE_HEURISTIC
    ) -> None:
        """Persist a trust score for ``fid`` and recompute its composite."""
        if not settings.SPAM_FILTER_ENABLED:
            return

        clamped = _clamp_score(score)
        if clamped is None:
            return

        # Upsert the score, then recompute composite under row lock
        stmt = (
            pg_insert(TrustScore)
            .values(
                fid=fid,
                score=clamped,
                source=source,
                composite=0.0,  # placeholder
                is_spam=False,  # placeholder
                updated_at=datetime.now(timezone.utc),
            )
            .on_conflict_do_update(
                index_elements=["fid"],
                set_={
                    "score": clamped,
                    "source": source,
                    "updated_at": datetime.now(timezone.utc),
                },
            )
        )
        await self._db.execute(stmt)

        row = (
            await self._db.execute(
                select(TrustScore).where(TrustScore.fid == fid).with_for_update()
            )
        ).scalar_one()
        composite, is_spam = compute_composite(row.score, row.warpcast_label)
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

    @staticmethod
    def _verdict(
        row: TrustScore | None, user_score: float | None
    ) -> tuple[float, bool] | None:
        """(composite, is_spam) from a stored row or a fresh heuristic score.

        A stored row wins: it carries Warpcast labels and any persisted score.
        Returns None when there is neither.
        """
        if row is not None:
            return row.composite, row.is_spam
        if user_score is not None:
            return compute_composite(user_score, None)
        return None

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

    async def _compute_and_cache(self, fid: int, user: Mapping | None) -> bool:
        """Load from DB, score from the user object if needed, cache result."""
        result = await self._db.execute(select(TrustScore).where(TrustScore.fid == fid))
        verdict = self._verdict(result.scalar_one_or_none(), _score_user(user))
        if verdict is None:
            # No data at all — assume not spam; leave uncached (see batch path)
            return False

        composite, is_spam = verdict
        try:
            await self._redis.setex(
                f"trust:{fid}",
                CACHE_TTL_SECONDS,
                json.dumps({"is_spam": is_spam, "composite": composite}),
            )
        except Exception as e:
            logger.warning("[spam] Redis cache set failed for fid=%d: %s", fid, e)

        return is_spam
