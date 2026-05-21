import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Juke Recording";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8000";

interface Recording {
  room_id: string;
  title: string;
  duration_seconds: number | null;
}

interface Host {
  username: string;
  display_name: string;
  pfp_url: string | null;
}

interface RecordingDetail {
  recording: Recording;
  host: Host;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const mins = Math.floor(seconds / 60);
  const remainSecs = seconds % 60;
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hours}h ${remainMins}m`;
  }
  return `${mins}:${remainSecs.toString().padStart(2, "0")}`;
}

const ALLOWED_PFP_HOSTS = [
  "i.imgur.com",
  "imagedelivery.net",
  "res.cloudinary.com",
  "wrpcd.net",
  "i.seadn.io",
];
function isSafePfpUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return ALLOWED_PFP_HOSTS.some(
      (h) => hostname === h || hostname.endsWith("." + h),
    );
  } catch {
    return false;
  }
}

export default async function Image({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let data: RecordingDetail | null = null;
  try {
    const res = await fetch(`${API_BASE_URL}/v1/recordings/${id}`, {
      next: { revalidate: 60 },
    });
    if (res.ok) data = await res.json();
  } catch {
    // Fall through to fallback rendering
  }

  // Fallback if we can't fetch data
  if (!data) {
    return new ImageResponse(
      (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            width: "100%",
            height: "100%",
            backgroundColor: "#0f0f23",
            padding: 60,
          }}
        >
          <span
            style={{
              color: "#855DCD",
              fontSize: 48,
              fontWeight: 700,
              letterSpacing: "0.15em",
            }}
          >
            JUKE
          </span>
          <span
            style={{ color: "#9898b8", fontSize: 28, marginTop: 16 }}
          >
            Recording
          </span>
        </div>
      ),
      { ...size },
    );
  }

  const { recording, host } = data;
  const safeTitle =
    recording.title.length > 80
      ? recording.title.slice(0, 80) + "…"
      : recording.title;

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          backgroundColor: "#0f0f23",
          padding: "60px 80px",
        }}
      >
        {/* Host row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 20,
            marginBottom: 40,
          }}
        >
          {isSafePfpUrl(host.pfp_url) ? (
            <img
              src={host.pfp_url!}
              width={80}
              height={80}
              style={{
                borderRadius: 40,
                objectFit: "cover",
              }}
            />
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 80,
                height: 80,
                borderRadius: 40,
                backgroundColor: "#2a2a4a",
                color: "#e8e8f0",
                fontSize: 36,
                fontWeight: 700,
              }}
            >
              {host.display_name.charAt(0).toUpperCase()}
            </div>
          )}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
            }}
          >
            <span
              style={{
                color: "#e8e8f0",
                fontSize: 36,
                fontWeight: 700,
                lineHeight: 1.2,
              }}
            >
              {host.display_name}
            </span>
            <span
              style={{
                color: "#7a7a9a",
                fontSize: 24,
                lineHeight: 1.3,
              }}
            >
              @{host.username}
            </span>
          </div>
        </div>

        {/* Title */}
        <div
          style={{
            display: "flex",
            flex: 1,
            alignItems: "center",
          }}
        >
          <span
            style={{
              color: "#e8e8f0",
              fontSize: 56,
              fontWeight: 700,
              lineHeight: 1.15,
              letterSpacing: "-0.01em",
            }}
          >
            {safeTitle}
          </span>
        </div>

        {/* Bottom row: duration + branding */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            width: "100%",
            marginTop: "auto",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span
              style={{
                color: "#D85A30",
                fontSize: 28,
                fontWeight: 600,
              }}
            >
              {formatDuration(recording.duration_seconds)}
            </span>
            <span style={{ color: "#3a3a5a", fontSize: 28 }}>&bull;</span>
            <span style={{ color: "#7a7a9a", fontSize: 24 }}>Recording</span>
          </div>
          <span
            style={{
              color: "#855DCD",
              fontSize: 30,
              fontWeight: 700,
              letterSpacing: "0.1em",
            }}
          >
            JUKE
          </span>
        </div>
      </div>
    ),
    { ...size },
  );
}
