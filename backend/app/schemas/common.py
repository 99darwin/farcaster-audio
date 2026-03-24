from pydantic import BaseModel


class StatusResponse(BaseModel):
    status: str


class ErrorResponse(BaseModel):
    detail: str


class PaginatedResponse(BaseModel):
    next_cursor: str | None = None
