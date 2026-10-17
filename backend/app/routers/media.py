import hashlib
import tempfile
import time

import httpx
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Request, status
from starlette.datastructures import FormData, UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import settings
from app.dependencies import get_current_user, get_redis
from app.services.media_embed import build_video_hls_url
from app.services.rate_limit import RateLimit, enforce_rate_limits

router = APIRouter(prefix="/v1/media", tags=["media"])

ALLOWED_IMAGE_TYPES = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
}

ALLOWED_VIDEO_TYPES = {
    "video/mp4",
    "video/quicktime",
    "video/webm",
}

ALLOWED_CONTENT_TYPES = ALLOWED_IMAGE_TYPES | ALLOWED_VIDEO_TYPES

MAX_IMAGE_SIZE = 10 * 1024 * 1024  # 10 MB
MAX_VIDEO_SIZE = 50 * 1024 * 1024  # 50 MB

UPLOAD_FIELD_NAME = "file"
# The only multipart part we accept is the file; bound the parser's work on
# junk fields so an authenticated client can't make it spool many parts.
MAX_FORM_FILES = 1
MAX_FORM_FIELDS = 4
# A cast carries at most a few media attachments.
UPLOAD_RATE_LIMITS = (
    ("media_upload:rl:min:{fid}", RateLimit(limit=20, window_seconds=60)),
    ("media_upload:rl:day:{fid}", RateLimit(limit=300, window_seconds=24 * 60 * 60)),
)

# Magic byte signatures for allowed image types
_IMAGE_MAGIC_BYTES = {
    b"\xff\xd8\xff": "image/jpeg",
    b"\x89PNG\r\n\x1a\n": "image/png",
    b"GIF87a": "image/gif",
    b"GIF89a": "image/gif",
    b"RIFF": "image/webp",  # WebP: RIFF....WEBP (check 4 bytes + offset)
}


def _detect_media_type(data: bytes) -> str | None:
    """Detect media type from magic bytes. Returns MIME type or None."""
    if len(data) < 12:
        return None

    # Check image signatures
    for magic, mime in _IMAGE_MAGIC_BYTES.items():
        if data[: len(magic)] == magic:
            if magic == b"RIFF" and data[8:12] != b"WEBP":
                continue
            return mime

    # Check video signatures
    # MP4/MOV: 'ftyp' at offset 4
    if data[4:8] == b"ftyp":
        return "video/mp4"

    # WebM: starts with EBML header 0x1A45DFA3
    if data[:4] == b"\x1a\x45\xdf\xa3":
        return "video/webm"

    return None


def _generate_signature(params: dict[str, str], api_secret: str) -> str:
    """Generate Cloudinary signed upload signature."""
    sorted_params = "&".join(f"{k}={v}" for k, v in sorted(params.items()))
    raw = sorted_params + api_secret
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


async def _read_upload_file(request: Request) -> tuple[FormData, UploadFile]:
    """Parse the multipart body (only after auth + rate limit have passed)."""
    try:
        form = await request.form(max_files=MAX_FORM_FILES, max_fields=MAX_FORM_FIELDS)
    except StarletteHTTPException:
        # Includes the body-size cap's 413 and Starlette's own 400 for a
        # malformed multipart body (FastAPI's HTTPException subclasses it).
        raise
    except Exception as exc:  # anything else the parser trips over
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Expected a multipart/form-data body with a 'file' part",
        ) from exc
    file = form.get(UPLOAD_FIELD_NAME)
    if not isinstance(file, UploadFile):
        await form.close()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Missing 'file' upload",
        )
    return form, file


@router.post("/upload")
async def upload_media(
    request: Request,
    fid: int = Depends(get_current_user),
    redis: aioredis.Redis = Depends(get_redis),
):
    """Upload an image or video to Cloudinary. Returns the public URL.

    The body is deliberately not a declared ``UploadFile`` parameter:
    FastAPI parses (and spools) declared bodies before running
    dependencies, which would let unauthenticated clients make us buffer
    50 MB. Auth and the per-fid rate limit run first; the multipart body is
    read afterwards (and is capped globally by ``BodySizeLimitMiddleware``).
    """
    if not settings.CLOUDINARY_CLOUD_NAME:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Media uploads are not configured",
        )
    await enforce_rate_limits(
        redis,
        [(template.format(fid=fid), rule) for template, rule in UPLOAD_RATE_LIMITS],
        detail="Upload rate limit exceeded. Try again later.",
    )
    form, file = await _read_upload_file(request)
    try:
        return await _forward_upload(file, fid)
    finally:
        await form.close()


async def _forward_upload(file: UploadFile, fid: int) -> dict[str, str]:
    """Validate ``file`` and forward it to Cloudinary."""

    # Validate declared content type
    if file.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported file type. Allowed: jpeg, png, gif, webp, mp4, mov, webm",
        )

    is_video_declared = file.content_type in ALLOWED_VIDEO_TYPES
    max_size = MAX_VIDEO_SIZE if is_video_declared else MAX_IMAGE_SIZE

    # Read file in chunks with early abort on size limit. Keep data in a
    # spooled temp file so larger videos don't require one contiguous bytes
    # object in memory before forwarding to Cloudinary.
    CHUNK_SIZE = 256 * 1024  # 256 KB
    total = 0
    head = b""
    spooled = tempfile.SpooledTemporaryFile(max_size=2 * 1024 * 1024)
    try:
        while True:
            chunk = await file.read(CHUNK_SIZE)
            if not chunk:
                break
            if len(head) < 4096:
                head += chunk[: 4096 - len(head)]
            total += len(chunk)
            if total > max_size:
                limit_mb = max_size // (1024 * 1024)
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail=f"File exceeds {limit_mb} MB limit",
                )
            spooled.write(chunk)

        if total == 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Empty file",
            )

        # Validate actual file content via magic bytes
        detected_type = _detect_media_type(head)
        if detected_type not in ALLOWED_CONTENT_TYPES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="File content does not match a supported media format",
            )

        is_video = detected_type in ALLOWED_VIDEO_TYPES

        # Enforce video size limit even if declared content type was image
        if is_video and total > MAX_VIDEO_SIZE:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"File exceeds {MAX_VIDEO_SIZE // (1024 * 1024)} MB limit",
            )

        # Build signed upload params
        timestamp = str(int(time.time()))

        if is_video:
            transformation = "q_auto,f_auto,w_1280,c_limit"
            resource_type = "video"
        else:
            transformation = "q_auto,f_auto,w_1600,c_limit"
            resource_type = "image"

        params = {
            "timestamp": timestamp,
            "transformation": transformation,
        }
        signature = _generate_signature(params, settings.CLOUDINARY_API_SECRET)

        upload_url = f"https://api.cloudinary.com/v1_1/{settings.CLOUDINARY_CLOUD_NAME}/{resource_type}/upload"

        # Use a generated filename instead of client-supplied one
        ext = detected_type.split("/")[1]
        if ext == "quicktime":
            ext = "mov"
        safe_filename = f"cast_{fid}_{timestamp}.{ext}"

        timeout = 120.0 if is_video else 30.0
        spooled.seek(0)

        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                upload_url,
                data={
                    "api_key": settings.CLOUDINARY_API_KEY,
                    "timestamp": timestamp,
                    "signature": signature,
                    "transformation": transformation,
                },
                files={"file": (safe_filename, spooled, detected_type)},
            )
    finally:
        spooled.close()

    if response.status_code != 200:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to upload {resource_type} to storage provider",
        )

    data = response.json()
    asset_url = data["secure_url"]
    media_kind = "video" if is_video else "image"
    embed_url = build_video_hls_url(asset_url) if is_video else asset_url
    return {
        "url": asset_url,
        "asset_url": asset_url,
        "embed_url": embed_url,
        "media_type": media_kind,
    }
