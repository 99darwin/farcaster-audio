"""
StorageService — thin boto3 wrapper for S3-compatible object storage.

Handles presigned URL generation for uploads/downloads and basic object ops.
"""

import boto3

from app.config import settings


class StorageService:
    def __init__(self) -> None:
        self._client = boto3.client(
            "s3",
            endpoint_url=settings.S3_ENDPOINT_URL,
            aws_access_key_id=settings.S3_ACCESS_KEY,
            aws_secret_access_key=settings.S3_SECRET_KEY,
            region_name=settings.S3_REGION,
        )

    def generate_presigned_upload_url(
        self, key: str, content_type: str, expires_in: int = 3600
    ) -> str:
        """Generate a presigned PUT URL for client-side upload."""
        return self._client.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": settings.S3_BUCKET,
                "Key": key,
                "ContentType": content_type,
            },
            ExpiresIn=expires_in,
        )

    def get_object_size(self, key: str) -> int:
        """Return the size in bytes of an S3 object via HEAD request."""
        resp = self._client.head_object(Bucket=settings.S3_BUCKET, Key=key)
        return resp["ContentLength"]

    def generate_presigned_get_url(
        self, key: str, expires_in: int = 3600
    ) -> str:
        """Generate a presigned GET URL (default 1 hour)."""
        return self._client.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": settings.S3_BUCKET,
                "Key": key,
            },
            ExpiresIn=expires_in,
        )

    def delete_object(self, key: str) -> None:
        """Delete an object from the bucket."""
        self._client.delete_object(Bucket=settings.S3_BUCKET, Key=key)

    def download_file(self, key: str, local_path: str) -> None:
        """Download an object to a local file path."""
        self._client.download_file(settings.S3_BUCKET, key, local_path)
