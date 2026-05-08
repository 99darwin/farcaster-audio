export type VideoMedia = {
  hlsUrl: string;
  posterUrl: string;
  mp4Url: string;
  title: string;
  description: string;
};

const CLOUDINARY_HOST = "res.cloudinary.com";
const CLOUDINARY_CLOUD_NAME =
  process.env.CLOUDINARY_CLOUD_NAME ?? "durbgdsd3";

function decodeToken(token: string): string | null {
  try {
    const normalized = token.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function normalizePublicPath(value: string): string | null {
  const parts = value.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [cloudName, ...deliveryPathParts] = parts;
  if (cloudName !== CLOUDINARY_CLOUD_NAME) return null;
  return deliveryPathParts.join("/");
}

export function decodeVideoMedia(token: string): VideoMedia | null {
  const tokenValue = decodeToken(token);
  if (!tokenValue) return null;

  const deliveryPath = normalizePublicPath(tokenValue);
  if (!deliveryPath) return null;

  const pathWithoutExt = deliveryPath.replace(/\.[^/.]+$/, "");
  const base = `https://${CLOUDINARY_HOST}/${CLOUDINARY_CLOUD_NAME}/video/upload`;

  return {
    hlsUrl: `${base}/sp_auto/${pathWithoutExt}.m3u8`,
    posterUrl: `${base}/so_0,w_1200,h_800,c_fill,q_auto,f_jpg/${pathWithoutExt}.jpg`,
    mp4Url: `${base}/${pathWithoutExt}.mp4`,
    title: "Juke video",
    description: "A video shared from Juke.",
  };
}
