from urllib.parse import urlparse, urlunparse

from app.config import settings


def _cloudinary_delivery_path(url: str) -> tuple[str, str, str] | None:
    parsed = urlparse(url)
    path_parts = [part for part in parsed.path.split("/") if part]
    if (
        parsed.scheme != "https"
        or parsed.netloc != "res.cloudinary.com"
        or len(path_parts) < 4
    ):
        return None

    cloud_name, resource_type, delivery_type = path_parts[:3]
    if settings.CLOUDINARY_CLOUD_NAME and cloud_name != settings.CLOUDINARY_CLOUD_NAME:
        return None
    if delivery_type != "upload":
        return None

    return cloud_name, resource_type, "/".join(path_parts[3:])


def build_video_hls_url(asset_url: str) -> str:
    """Convert a Juke Cloudinary video URL into FC-native HLS delivery."""
    parsed = urlparse(asset_url)
    cloudinary_path = _cloudinary_delivery_path(asset_url)
    if not cloudinary_path:
        return asset_url

    cloud_name, resource_type, delivery_path = cloudinary_path
    if resource_type != "video":
        return asset_url
    if delivery_path.startswith("sp_auto/") and delivery_path.endswith(".m3u8"):
        return asset_url

    if "." in delivery_path.rsplit("/", 1)[-1]:
        delivery_path = delivery_path.rsplit(".", 1)[0] + ".m3u8"
    else:
        delivery_path = f"{delivery_path}.m3u8"

    path = f"/{cloud_name}/video/upload/sp_auto/{delivery_path}"
    return urlunparse(parsed._replace(path=path, query="", fragment=""))


def normalize_media_embed_url(url: str) -> str:
    return build_video_hls_url(url)
