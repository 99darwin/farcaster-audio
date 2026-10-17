"""Pydantic response/request schemas for the recognition leaderboard.

These shapes are a FROZEN public contract — web and mobile clients build
against them. Only fid, username, display_name, pfp_url, score, and rank are
ever exposed for a user; nothing sensitive (signer_uuid, internal ids) leaks.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class LeaderboardEntry(BaseModel):
    rank: int
    fid: int
    username: str | None = None
    display_name: str | None = None
    pfp_url: str | None = None
    score: float


class LeaderboardCategory(BaseModel):
    key: str
    label: str
    entries: list[LeaderboardEntry]


class LeaderboardResponse(BaseModel):
    cycle: str
    status: Literal["provisional", "final"]
    computed_at: datetime | None = None
    categories: list[LeaderboardCategory]


class MyCategoryStanding(BaseModel):
    key: str
    rank: int | None = None
    score: float


class MyLeaderboardResponse(BaseModel):
    cycle: str
    opt_out: bool
    categories: list[MyCategoryStanding]


class OptOutRequest(BaseModel):
    opt_out: bool


class OptOutResponse(BaseModel):
    opt_out: bool


class AwardItem(BaseModel):
    cycle: str
    category: str
    label: str
    rank: int


class AwardsResponse(BaseModel):
    fid: int
    awards: list[AwardItem] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Admin cycle-close review flow (additive — see leaderboard_admin.py)
# ---------------------------------------------------------------------------


class AdminStandingEntry(BaseModel):
    rank: int | None = None
    fid: int
    username: str | None = None
    display_name: str | None = None
    pfp_url: str | None = None
    score: float
    opt_out: bool = False
    # Surfaced so the reviewing human sees agent-flagged entries whose flag
    # postdates the nightly score snapshot (close re-excludes them
    # automatically, but the reviewer should see why a name will drop out).
    is_agent: bool = False


class AdminCategoryStandings(BaseModel):
    key: str
    label: str
    entries: list[AdminStandingEntry]


class AdminCycleStandingsResponse(BaseModel):
    cycle: str
    status: Literal["open", "final"]
    computed_at: datetime | None = None
    categories: list[AdminCategoryStandings]


class CloseCycleRequest(BaseModel):
    exclusions: list[int] = Field(default_factory=list)
    announce: bool = False


class CloseCycleAwardItem(BaseModel):
    fid: int
    category: str
    label: str
    rank: int


class CloseCycleResponse(BaseModel):
    cycle: str
    awards: list[CloseCycleAwardItem] = Field(default_factory=list)
    announce_cast_hash: str | None = None
