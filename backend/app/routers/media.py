import hashlib
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile, status

from app.config import settings
from app.dependencies import get_current_user

router = APIRouter(prefix="/v1/media", tags=["media"])

ALLOWED_CONTENT_TYPES = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
}
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB

# Magic byte signatures for allowed image types
_MAGIC_BYTES = {
    b"\xff\xd8\xff": "image/jpeg",
    b"\x89PNG\r\n\x1a\n": "image/png",
    b"GIF87a": "image/gif",
    b"GIF89a": "image/gif",
    b"RIFF": "image/webp",  # WebP: RIFF....WEBP (check 4 bytes + offset)
}


def _detect_image_type(data: bytes) -> str | None:
    """Detect image type from magic bytes. Returns MIME type or None."""
    if len(data) < 12:
        return None
    for magic, mime in _MAGIC_BYTES.items():
        if data[: len(magic)] == magic:
            # WebP needs additional check: bytes 8-12 should be 'WEBP'
            if magic == b"RIFF" and data[8:12] != b"WEBP":
                continue
            return mime
    return None


def _generate_signature(params: dict[str, str], api_secret: str) -> str:
    """Generate Cloudinary signed upload signature."""
    sorted_params = "&".join(
        f"{k}={v}" for k, v in sorted(params.items())
    )
    raw = sorted_params + api_secret
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


@router.post("/upload")
async def upload_media(
    file: UploadFile,
    fid: int = Depends(get_current_user),
):
    """Upload an image to Cloudinary. Returns the public URL."""
    if not settings.CLOUDINARY_CLOUD_NAME:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Media uploads are not configured",
        )

    # Validate declared content type
    if file.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported file type. Allowed: jpeg, png, gif, webp",
        )

    # Read file in chunks with early abort on size limit
    CHUNK_SIZE = 256 * 1024  # 256 KB
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_FILE_SIZE:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="File exceeds 10 MB limit",
            )
        chunks.append(chunk)
    contents = b"".join(chunks)

    if not contents:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty file",
        )

    # Validate actual file content via magic bytes
    detected_type = _detect_image_type(contents)
    if detected_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File content does not match a supported image format",
        )

    # Build signed upload params
    timestamp = str(int(time.time()))
    params = {
        "timestamp": timestamp,
        "transformation": "q_auto,f_auto,w_1600,c_limit",
    }
    signature = _generate_signature(params, settings.CLOUDINARY_API_SECRET)

    upload_url = (
        f"https://api.cloudinary.com/v1_1/{settings.CLOUDINARY_CLOUD_NAME}/image/upload"
    )

    # Use a generated filename instead of client-supplied one
    ext = detected_type.split("/")[1]
    safe_filename = f"cast_{fid}_{timestamp}.{ext}"

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            upload_url,
            data={
                "api_key": settings.CLOUDINARY_API_KEY,
                "timestamp": timestamp,
                "signature": signature,
                "transformation": "q_auto,f_auto,w_1600,c_limit",
            },
            files={"file": (safe_filename, contents, detected_type)},
        )

    if response.status_code != 200:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to upload image to storage provider",
        )

    data = response.json()
    return {"url": data["secure_url"]}
