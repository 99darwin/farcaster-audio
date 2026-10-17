"""Tests for StorageService.complete_orphaned_multipart_upload.

The recording worker checkpoints encoded audio as multipart parts during
recording. A hard crash leaves the upload incomplete — the parts persist
but aren't a readable object until completed. This method finds and
completes that upload so a crashed recording is recoverable.
"""

from __future__ import annotations

from datetime import datetime, timezone

from botocore.exceptions import ClientError

from app.services.storage_service import StorageService


class _FakeS3:
    def __init__(self, *, uploads, parts):
        self._uploads = uploads
        self._parts = parts
        self.completed = None
        self.aborted = None

    def list_multipart_uploads(self, Bucket, Prefix):
        return {"Uploads": self._uploads}

    def list_parts(self, Bucket, Key, UploadId):
        return {"Parts": self._parts}

    def complete_multipart_upload(self, Bucket, Key, UploadId, MultipartUpload):
        self.completed = {
            "Key": Key,
            "UploadId": UploadId,
            "Parts": MultipartUpload["Parts"],
        }

    def abort_multipart_upload(self, Bucket, Key, UploadId):
        self.aborted = {"Key": Key, "UploadId": UploadId}


def _storage_with(fake) -> StorageService:
    s = StorageService.__new__(StorageService)  # skip boto3 client construction
    s._client = fake
    return s


KEY = "recordings/room-1/native-1.ogg"


def test_completes_incomplete_upload_with_its_parts():
    fake = _FakeS3(
        uploads=[
            {
                "Key": KEY,
                "UploadId": "u-1",
                "Initiated": datetime(2026, 6, 22, tzinfo=timezone.utc),
            }
        ],
        parts=[
            {"PartNumber": 2, "ETag": '"etag2"'},
            {"PartNumber": 1, "ETag": '"etag1"'},
        ],
    )
    assert _storage_with(fake).complete_orphaned_multipart_upload(KEY) is True
    # Parts must be sent in ascending PartNumber order.
    assert [p["PartNumber"] for p in fake.completed["Parts"]] == [1, 2]
    assert fake.completed["UploadId"] == "u-1"


def test_picks_most_recently_initiated_upload():
    fake = _FakeS3(
        uploads=[
            {
                "Key": KEY,
                "UploadId": "old",
                "Initiated": datetime(2026, 6, 20, tzinfo=timezone.utc),
            },
            {
                "Key": KEY,
                "UploadId": "new",
                "Initiated": datetime(2026, 6, 22, tzinfo=timezone.utc),
            },
        ],
        parts=[{"PartNumber": 1, "ETag": '"e"'}],
    )
    assert _storage_with(fake).complete_orphaned_multipart_upload(KEY) is True
    assert fake.completed["UploadId"] == "new"


def test_no_uploads_returns_false():
    fake = _FakeS3(uploads=[], parts=[])
    assert _storage_with(fake).complete_orphaned_multipart_upload(KEY) is False
    assert fake.completed is None


def test_ignores_uploads_for_other_keys():
    fake = _FakeS3(
        uploads=[
            {
                "Key": "recordings/other/x.ogg",
                "UploadId": "u",
                "Initiated": datetime(2026, 6, 22, tzinfo=timezone.utc),
            }
        ],
        parts=[],
    )
    assert _storage_with(fake).complete_orphaned_multipart_upload(KEY) is False


def test_upload_with_no_parts_is_aborted():
    fake = _FakeS3(
        uploads=[
            {
                "Key": KEY,
                "UploadId": "u-empty",
                "Initiated": datetime(2026, 6, 22, tzinfo=timezone.utc),
            }
        ],
        parts=[],
    )
    assert _storage_with(fake).complete_orphaned_multipart_upload(KEY) is False
    assert fake.aborted == {"Key": KEY, "UploadId": "u-empty"}


def test_client_error_returns_false_never_raises():
    class _Boom:
        def list_multipart_uploads(self, **_):
            raise ClientError(
                {"Error": {"Code": "AccessDenied"}}, "ListMultipartUploads"
            )

    assert _storage_with(_Boom()).complete_orphaned_multipart_upload(KEY) is False
