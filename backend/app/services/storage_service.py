"""
StorageService — thin boto3 wrapper for S3-compatible object storage.

Handles presigned URL generation for uploads/downloads and basic object ops.

Note: the recording bucket is expected to be effectively private. Public
listing / reads should be disabled at the bucket policy level. We gate all
client reads behind short-lived presigned URLs generated at response time
(see ``generate_presigned_get_url``) so recordings can't be enumerated or
hotlinked even if a URL leaks.
"""

import logging
from urllib.parse import urlparse

import boto3

from app.config import settings

logger = logging.getLogger(__name__)


# Only keys under this prefix are considered recording artifacts. Rejecting
# everything else blocks a malicious webhook from pointing us at arbitrary
# objects in our bucket (or any other bucket).
_RECORDINGS_KEY_PREFIX = "recordings/"


def extract_recording_s3_key(recording_url: str) -> str | None:
    """Extract and validate the S3 object key for a LiveKit recording URL.

    Hardened helper used by both the egress webhook and the retention
    cleanup job. Returns ``None`` (and logs a warning) for any URL we
    can't positively match to *our* configured bucket.

    Accepts two URL shapes:
      * Path-style:     ``{endpoint}/{bucket}/recordings/...``
      * Virtual-hosted: ``https://{bucket}.s3.{region}.amazonaws.com/recordings/...``

    Any other scheme/host — or a key that doesn't live under
    ``recordings/`` — is rejected so a spoofed webhook can't trick us into
    storing, presigning, or deleting something we don't own.
    """
    if not recording_url:
        return None

    # Already a bare key (defensive — internal callers only).
    if recording_url.startswith(_RECORDINGS_KEY_PREFIX):
        return recording_url

    try:
        parsed = urlparse(recording_url)
    except Exception:
        logger.warning("Failed to parse recording URL: %r", recording_url)
        return None

    if parsed.scheme not in ("http", "https"):
        logger.warning(
            "Rejecting recording URL with non-http scheme: %r", recording_url
        )
        return None

    host = (parsed.hostname or "").lower()
    if not host:
        logger.warning("Rejecting recording URL with no host: %r", recording_url)
        return None

    bucket = (settings.AWS_S3_BUCKET_NAME or "").lower()
    endpoint_host = ""
    if settings.AWS_ENDPOINT_URL:
        try:
            endpoint_host = (urlparse(settings.AWS_ENDPOINT_URL).hostname or "").lower()
        except Exception:
            endpoint_host = ""

    path = parsed.path.lstrip("/")
    if not path:
        return None

    key: str | None = None

    # Path-style: host matches the configured endpoint and path begins with
    # "{bucket}/...". Strip the bucket prefix to get the key.
    if endpoint_host and host == endpoint_host:
        if bucket and path.startswith(f"{bucket}/"):
            key = path[len(bucket) + 1 :]
        else:
            # Endpoint matches but bucket prefix doesn't — reject rather
            # than trust the remaining path.
            logger.warning(
                "Recording URL host matches endpoint but bucket prefix missing: %r",
                recording_url,
            )
            return None

    # Virtual-hosted: host starts with "{bucket}." (AWS or any S3-compatible
    # provider following the same convention). This covers
    # "{bucket}.s3.{region}.amazonaws.com" as well as
    # "{bucket}.{endpoint_host}" for path-less providers.
    elif bucket and (
        host == f"{bucket}.s3.{settings.AWS_DEFAULT_REGION}.amazonaws.com".lower()
        or host.startswith(f"{bucket}.s3.")
        or (endpoint_host and host == f"{bucket}.{endpoint_host}")
    ):
        key = path

    else:
        logger.warning(
            "Rejecting recording URL — host %r does not match configured bucket/endpoint",
            host,
        )
        return None

    if not key or not key.startswith(_RECORDINGS_KEY_PREFIX):
        logger.warning(
            "Rejecting recording URL — extracted key %r is not under %r",
            key,
            _RECORDINGS_KEY_PREFIX,
        )
        return None

    return key


class StorageService:
    def __init__(self) -> None:
        self._client = boto3.client(
            "s3",
            endpoint_url=settings.AWS_ENDPOINT_URL,
            aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
            aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
            region_name=settings.AWS_DEFAULT_REGION,
        )

    def generate_presigned_upload_url(
        self, key: str, content_type: str, expires_in: int = 3600
    ) -> str:
        """Generate a presigned PUT URL for client-side upload."""
        return self._client.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": settings.AWS_S3_BUCKET_NAME,
                "Key": key,
                "ContentType": content_type,
            },
            ExpiresIn=expires_in,
        )

    def get_object_size(self, key: str) -> int:
        """Return the size in bytes of an S3 object via HEAD request."""
        resp = self._client.head_object(Bucket=settings.AWS_S3_BUCKET_NAME, Key=key)
        return resp["ContentLength"]

    def generate_presigned_get_url(
        self, key: str, expires_in: int = 3600
    ) -> str:
        """Generate a presigned GET URL (default 1 hour)."""
        return self._client.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": settings.AWS_S3_BUCKET_NAME,
                "Key": key,
            },
            ExpiresIn=expires_in,
        )

    def delete_object(self, key: str) -> None:
        """Delete an object from the bucket."""
        self._client.delete_object(Bucket=settings.AWS_S3_BUCKET_NAME, Key=key)

    def download_file(self, key: str, local_path: str) -> None:
        """Download an object to a local file path."""
        self._client.download_file(settings.AWS_S3_BUCKET_NAME, key, local_path)
