from pydantic import BaseModel

# 0x-prefixed hex cast hash. Farcaster hashes are 20 bytes; storage columns
# allow up to 32, so the pattern is bounded to reject oversized junk at parse
# time. Single source of truth for drafts, feed and room schemas.
CAST_HASH_PATTERN = r"^0x[a-fA-F0-9]{1,64}$"


class StatusResponse(BaseModel):
    status: str


class ErrorResponse(BaseModel):
    detail: str


class PaginatedResponse(BaseModel):
    next_cursor: str | None = None
