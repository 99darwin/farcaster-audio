"""Unit tests for recording retention cleanup helpers."""

from unittest.mock import patch

from app.services.recording_cleanup import _extract_s3_key


def test_extract_s3_key_bare_key():
    """Already-a-key input should round-trip unchanged."""
    key = "recordings/room-abc/20260101T120000Z.ogg"
    assert _extract_s3_key(key) == key


def test_extract_s3_key_path_style_url():
    """Path-style URL should strip the bucket prefix."""
    with patch("app.services.recording_cleanup.settings") as mock_settings:
        mock_settings.AWS_S3_BUCKET_NAME = "juke-recordings"
        url = (
            "https://your-s3-endpoint.example.com/juke-recordings/"
            "recordings/room-abc/20260101T120000Z.ogg"
        )
        assert (
            _extract_s3_key(url)
            == "recordings/room-abc/20260101T120000Z.ogg"
        )


def test_extract_s3_key_virtual_hosted_url():
    """Virtual-hosted-style URL should just strip the leading slash."""
    with patch("app.services.recording_cleanup.settings") as mock_settings:
        mock_settings.AWS_S3_BUCKET_NAME = "juke-recordings"
        url = (
            "https://juke-recordings.s3.us-east-1.amazonaws.com/"
            "recordings/room-abc/20260101T120000Z.ogg"
        )
        assert (
            _extract_s3_key(url)
            == "recordings/room-abc/20260101T120000Z.ogg"
        )


def test_extract_s3_key_empty_returns_none():
    assert _extract_s3_key("") is None


def test_extract_s3_key_malformed_returns_none():
    assert _extract_s3_key("https://example.com/") is None
