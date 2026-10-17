from datetime import datetime

from pydantic import BaseModel


class TrustScoreResponse(BaseModel):
    fid: int
    score: float | None = None
    source: str | None = None
    warpcast_label: int | None = None
    composite: float
    is_spam: bool
    updated_at: datetime

    model_config = {"from_attributes": True}
