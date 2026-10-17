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


# Presigned upload URLs are short-lived: clients request one immediately
# before uploading, and a long-lived URL lets anyone holding it keep
# (re)writing the object.
PRESIGNED_UPLOAD_TTL_SECONDS = 300

# Only keys under this prefix are considered recording artifacts. Rejecting
# everything else blocks a malicious webhook from pointing us at arbitrary
# objects in our bucket (or any other bucket).
_RECORDINGS_KEY_PREFIX = "recordings/"


def _virtual_hosted_bucket_hosts(bucket: str, endpoint_host: str) -> set[str]:
    region = (settings.AWS_DEFAULT_REGION or "").lower()
    hosts = {f"{bucket}.s3.amazonaws.com"}
    if region:
        hosts.add(f"{bucket}.s3.{region}.amazonaws.com")
    if endpoint_host:
        hosts.add(f"{bucket}.{endpoint_host}")
    return hosts


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

    # Virtual-hosted: exact match against the hosts our bucket can actually
    # be served from — "{bucket}.s3.{region}.amazonaws.com", the legacy
    # global "{bucket}.s3.amazonaws.com", or "{bucket}.{endpoint_host}" for
    # S3-compatible providers. Never a prefix match: "{bucket}.s3.evil.com"
    # must not pass.
    elif bucket and host in _virtual_hosted_bucket_hosts(bucket, endpoint_host):
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
        # boto3 distinguishes endpoint_url=None (fall back to AWS-default
        # regional endpoint) from endpoint_url="" (use a literal empty
        # endpoint, which raises). Normalize empty config to None so
        # operators using AWS S3 don't need to set this variable.
        endpoint_url = settings.AWS_ENDPOINT_URL or None
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint_url,
            aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
            aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
            region_name=settings.AWS_DEFAULT_REGION,
        )

    def generate_presigned_upload_url(
        self,
        key: str,
        content_type: str,
        expires_in: int = PRESIGNED_UPLOAD_TTL_SECONDS,
    ) -> str:
        """Generate a short-lived presigned PUT URL for client-side upload.

        The URL can rewrite ``key`` until it expires, so callers must treat
        ``key`` as a staging location and copy it to a key no URL was ever
        issued for before trusting its contents (see ``copy_object``).
        """
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

    def copy_object(self, source_key: str, dest_key: str) -> None:
        """Server-side copy within the bucket (a snapshot of the source)."""
        bucket = settings.AWS_S3_BUCKET_NAME
        self._client.copy_object(
            Bucket=bucket,
            Key=dest_key,
            CopySource={"Bucket": bucket, "Key": source_key},
        )

    def object_exists(self, key: str) -> bool:
        """Return True if a non-empty object exists at ``key``.

        Used to recover orphaned native recordings: the Node worker
        self-finalizes (flushes ffmpeg + PutObject) when the LiveKit room
        disconnects, but the Python side only persists the URL if someone
        calls stop. A HEAD lets us detect a file the worker already
        uploaded and re-link it. Treats any client error (404, 403) as
        "not present" — recovery is best-effort, never a hard failure.
        """
        from botocore.exceptions import BotoCoreError, ClientError

        try:
            return self.get_object_size(key) > 0
        except (ClientError, BotoCoreError):
            return False

    def complete_orphaned_multipart_upload(self, key: str) -> bool:
        """Complete an incomplete multipart upload left at ``key`` by a
        crashed recording worker, turning its uploaded parts into a
        readable object.

        The worker checkpoints encoded audio as multipart parts during
        recording (crash insurance). A hard kill leaves the upload
        *incomplete* — the parts persist in S3 but aren't a fetchable
        object until completed. This finds that upload and completes it
        from whatever parts made it, so recovery gets the audio up to the
        last checkpoint instead of nothing.

        Returns True if it completed an upload (an object now exists at
        ``key``), False otherwise. Never raises — recovery is best-effort.
        Only call this once the worker is confirmed gone, so we don't race
        a live worker's own completion.
        """
        from botocore.exceptions import BotoCoreError, ClientError

        bucket = settings.AWS_S3_BUCKET_NAME
        try:
            listing = self._client.list_multipart_uploads(Bucket=bucket, Prefix=key)
            uploads = [u for u in listing.get("Uploads", []) if u.get("Key") == key]
            if not uploads:
                return False
            # Most recently initiated wins if a key was (re)recorded.
            uploads.sort(key=lambda u: u.get("Initiated"), reverse=True)
            upload_id = uploads[0]["UploadId"]

            parts_resp = self._client.list_parts(
                Bucket=bucket, Key=key, UploadId=upload_id
            )
            parts = parts_resp.get("Parts", [])
            if not parts:
                # No bytes ever landed — nothing to recover. Abort so the
                # empty upload doesn't linger.
                self._client.abort_multipart_upload(
                    Bucket=bucket, Key=key, UploadId=upload_id
                )
                return False

            self._client.complete_multipart_upload(
                Bucket=bucket,
                Key=key,
                UploadId=upload_id,
                MultipartUpload={
                    "Parts": [
                        {"PartNumber": p["PartNumber"], "ETag": p["ETag"]}
                        for p in sorted(parts, key=lambda p: p["PartNumber"])
                    ]
                },
            )
            logger.info(
                "Completed orphaned multipart upload for key=%s (%d parts)",
                key,
                len(parts),
            )
            return True
        except (ClientError, BotoCoreError, KeyError):
            logger.warning(
                "Failed to complete orphaned multipart upload for key=%s", key
            )
            return False

    def build_object_url(self, key: str) -> str:
        """Construct the canonical object URL for ``key``.

        Mirrors the format the recording worker emits and that
        ``extract_recording_s3_key`` round-trips: path-style against the
        configured endpoint when one is set (S3-compatible providers),
        else AWS virtual-hosted style.
        """
        bucket = settings.AWS_S3_BUCKET_NAME
        if settings.AWS_ENDPOINT_URL:
            return f"{settings.AWS_ENDPOINT_URL.rstrip('/')}/{bucket}/{key}"
        region = settings.AWS_DEFAULT_REGION
        return f"https://{bucket}.s3.{region}.amazonaws.com/{key}"

    def generate_presigned_get_url(self, key: str, expires_in: int = 3600) -> str:
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
