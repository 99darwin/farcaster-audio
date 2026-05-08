import hashlib
import tempfile
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile, status

from app.config import settings
from app.dependencies import get_current_user
from app.services.media_embed import build_video_hls_url

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


@router.post("/upload")
async def upload_media(
    file: UploadFile,
    fid: int = Depends(get_current_user),
):
    """Upload an image or video to Cloudinary. Returns the public URL."""
    if not settings.CLOUDINARY_CLOUD_NAME:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Media uploads are not configured",
        )

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
