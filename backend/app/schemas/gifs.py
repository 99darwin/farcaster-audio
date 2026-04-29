from pydantic import BaseModel


class GifResult(BaseModel):
    id: str
    gifUrl: str
    previewUrl: str
    width: int
    height: int


class GifSearchResponse(BaseModel):
    results: list[GifResult]
    next_offset: int | None = None
