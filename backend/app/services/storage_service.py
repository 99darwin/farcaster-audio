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
