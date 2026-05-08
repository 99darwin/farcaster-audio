from app.config import settings
from app.services.media_embed import (
    build_video_embed_page_url,
    build_video_hls_url,
    normalize_media_embed_url,
)


def test_build_video_hls_url_uses_cloudinary_streaming_profile(monkeypatch):
    monkeypatch.setattr(settings, "CLOUDINARY_CLOUD_NAME", "durbgdsd3")
    asset_url = (
        "https://res.cloudinary.com/durbgdsd3/video/upload/"
        "v1777929516/nzmv8im0wbekpnpi3mx3.mp4"
    )

    assert build_video_hls_url(asset_url) == (
        "https://res.cloudinary.com/durbgdsd3/video/upload/sp_auto/"
        "v1777929516/nzmv8im0wbekpnpi3mx3.m3u8"
    )


def test_build_video_embed_page_url_uses_juke_open_graph_page(monkeypatch):
    monkeypatch.setattr(settings, "CLOUDINARY_CLOUD_NAME", "durbgdsd3")
    monkeypatch.setattr(settings, "WEB_BASE_URL", "https://juke.audio")
    asset_url = (
        "https://res.cloudinary.com/durbgdsd3/video/upload/"
        "v1777929516/nzmv8im0wbekpnpi3mx3.mp4"
    )

    assert build_video_embed_page_url(asset_url).startswith(
        "https://juke.audio/m/video/"
    )


def test_normalize_media_embed_url_converts_juke_cloudinary_video(monkeypatch):
    monkeypatch.setattr(settings, "CLOUDINARY_CLOUD_NAME", "durbgdsd3")
    monkeypatch.setattr(settings, "WEB_BASE_URL", "https://juke.audio")
    asset_url = (
        "https://res.cloudinary.com/durbgdsd3/video/upload/"
        "v1777929516/nzmv8im0wbekpnpi3mx3.mp4"
    )

    assert normalize_media_embed_url(asset_url).endswith(
        "/m/video/ZHVyYmdkc2QzL3YxNzc3OTI5NTE2L256bXY4aW0wd2Jla3BucGkzbXgz"
    )


def test_normalize_media_embed_url_leaves_other_urls_unchanged(monkeypatch):
    monkeypatch.setattr(settings, "CLOUDINARY_CLOUD_NAME", "durbgdsd3")
    asset_url = "https://example.com/video.mp4"

    assert normalize_media_embed_url(asset_url) == asset_url


def test_normalize_media_embed_url_wraps_hls_urls(monkeypatch):
    monkeypatch.setattr(settings, "CLOUDINARY_CLOUD_NAME", "durbgdsd3")
    monkeypatch.setattr(settings, "WEB_BASE_URL", "https://juke.audio")
    asset_url = (
        "https://res.cloudinary.com/durbgdsd3/video/upload/sp_auto/"
        "v1777929516/example.m3u8"
    )

    assert normalize_media_embed_url(asset_url).endswith(
        "/m/video/ZHVyYmdkc2QzL3YxNzc3OTI5NTE2L2V4YW1wbGU"
    )


def test_normalize_media_embed_url_leaves_images_unchanged(monkeypatch):
    monkeypatch.setattr(settings, "CLOUDINARY_CLOUD_NAME", "durbgdsd3")
    asset_url = (
        "https://res.cloudinary.com/durbgdsd3/image/upload/"
        "v1777929516/example.jpg"
    )

    assert normalize_media_embed_url(asset_url) == asset_url
