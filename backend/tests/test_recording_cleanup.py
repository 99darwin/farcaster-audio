"""Unit tests for recording retention cleanup helpers."""

from unittest.mock import patch

from app.services.storage_service import extract_recording_s3_key as _extract_s3_key


def test_extract_s3_key_bare_key():
    """Already-a-key input should round-trip unchanged."""
    key = "recordings/room-abc/20260101T120000Z.ogg"
    assert _extract_s3_key(key) == key


def test_extract_s3_key_path_style_url():
    """Path-style URL against the configured endpoint strips the bucket prefix."""
    with patch("app.services.storage_service.settings") as mock_settings:
        mock_settings.AWS_S3_BUCKET_NAME = "juke-recordings"
        mock_settings.AWS_ENDPOINT_URL = "https://your-s3-endpoint.example.com"
        mock_settings.AWS_DEFAULT_REGION = "us-east-1"
        url = (
            "https://your-s3-endpoint.example.com/juke-recordings/"
            "recordings/room-abc/20260101T120000Z.ogg"
        )
        assert (
            _extract_s3_key(url)
            == "recordings/room-abc/20260101T120000Z.ogg"
        )


def test_extract_s3_key_virtual_hosted_url():
    """Virtual-hosted URL on a bucket-prefixed S3 host strips the leading slash."""
    with patch("app.services.storage_service.settings") as mock_settings:
        mock_settings.AWS_S3_BUCKET_NAME = "juke-recordings"
        mock_settings.AWS_ENDPOINT_URL = "https://your-s3-endpoint.example.com"
        mock_settings.AWS_DEFAULT_REGION = "us-east-1"
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


def test_extract_s3_key_rejects_untrusted_host():
    """URLs whose host isn't our configured endpoint/bucket must be rejected."""
    with patch("app.services.storage_service.settings") as mock_settings:
        mock_settings.AWS_S3_BUCKET_NAME = "juke-recordings"
        mock_settings.AWS_ENDPOINT_URL = "https://your-s3-endpoint.example.com"
        mock_settings.AWS_DEFAULT_REGION = "us-east-1"
        # Attacker-controlled host pointing at a lookalike path — must fail.
        url = (
            "https://attacker.example.com/juke-recordings/"
            "recordings/room-abc/20260101T120000Z.ogg"
        )
        assert _extract_s3_key(url) is None


def test_extract_s3_key_rejects_non_recordings_key():
    """Even on a trusted host, keys outside ``recordings/`` must be rejected."""
    with patch("app.services.storage_service.settings") as mock_settings:
        mock_settings.AWS_S3_BUCKET_NAME = "juke-recordings"
        mock_settings.AWS_ENDPOINT_URL = "https://your-s3-endpoint.example.com"
        mock_settings.AWS_DEFAULT_REGION = "us-east-1"
        url = (
            "https://your-s3-endpoint.example.com/juke-recordings/"
            "secrets/credentials.env"
        )
        assert _extract_s3_key(url) is None


def test_extract_s3_key_rejects_non_http_scheme():
    """file:// or other schemes must be rejected."""
    with patch("app.services.storage_service.settings") as mock_settings:
        mock_settings.AWS_S3_BUCKET_NAME = "juke-recordings"
        mock_settings.AWS_ENDPOINT_URL = "https://your-s3-endpoint.example.com"
        mock_settings.AWS_DEFAULT_REGION = "us-east-1"
        assert _extract_s3_key("file:///etc/passwd") is None
