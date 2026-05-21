import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Juke — Live Audio Space";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

type RoomData = {
  room: {
    title: string;
    status: string;
    host: {
      display_name: string;
    };
    speaker_count: number;
    listener_count: number;
    scheduled_at: string | null;
  };
};

async function fetchRoom(id: string): Promise<RoomData | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/v1/rooms/${id}`, {
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function formatScheduledTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }) + " UTC";
}

function getRelativeTime(iso: string): string {
  const now = Date.now();
  const target = new Date(iso).getTime();
  const diffMs = target - now;
  if (diffMs <= 0) return 'starting soon';
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `in ${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

export default async function Image({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await fetchRoom(id);

  const title = data?.room.title ?? "Audio Space";
  const hostName = data?.room.host.display_name ?? "";
  const isLive = data?.room.status === "active";
  const isScheduled = data?.room.status === "scheduled";
  const scheduledAt = data?.room.scheduled_at;

  // Diamond/chevron waveform pattern
  const waveformHeights = [
    16, 28, 40, 52, 64, 76, 88, 100, 108, 116, 124, 130, 134, 130, 124, 116,
    108, 100, 88, 76, 64, 52, 40, 28, 16,
  ];

  // Dim waveform for scheduled spaces
  const waveOpacity = isScheduled ? 0.35 : 1;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0f0f23",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Radial glow */}
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: 800,
            height: 400,
            borderRadius: "50%",
            background: isScheduled
              ? "radial-gradient(ellipse at center, rgba(133,93,205,0.08) 0%, transparent 70%)"
              : "radial-gradient(ellipse at center, rgba(216,90,48,0.08) 0%, transparent 70%)",
            display: "flex",
          }}
        />

        {/* JUKE branding */}
        <div
          style={{
            display: "flex",
            fontSize: 48,
            fontWeight: 800,
            color: "#7a7a9a",
            letterSpacing: "0.2em",
            lineHeight: 1,
            marginBottom: 32,
          }}
        >
          JUKE
        </div>

        {/* Status indicator + title */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 16,
          }}
        >
          {isLive && (
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: 6,
                backgroundColor: "#D85A30",
                display: "flex",
              }}
            />
          )}
          <div
            style={{
              display: "flex",
              fontSize: 56,
              fontWeight: 700,
              color: "#ffffff",
              lineHeight: 1.2,
              textAlign: "center",
              maxWidth: 900,
            }}
          >
            {title}
          </div>
        </div>

        {/* Host name */}
        {hostName && (
          <div
            style={{
              display: "flex",
              fontSize: 28,
              color: "#a0a0c0",
              fontWeight: 400,
              marginBottom: isScheduled ? 16 : 48,
            }}
          >
            Hosted by {hostName}
          </div>
        )}

        {/* Scheduled date/time badge */}
        {isScheduled && scheduledAt && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              backgroundColor: "rgba(133, 93, 205, 0.15)",
              borderRadius: 24,
              paddingLeft: 20,
              paddingRight: 20,
              paddingTop: 10,
              paddingBottom: 10,
              marginBottom: 48,
            }}
          >
            <div
              style={{
                display: "flex",
                fontSize: 26,
                fontWeight: 600,
                color: "#855DCD",
              }}
            >
              {formatScheduledTime(scheduledAt)}
            </div>
            <div
              style={{
                display: "flex",
                fontSize: 20,
                fontWeight: 400,
                color: "#855DCD",
                opacity: 0.7,
              }}
            >
              {getRelativeTime(scheduledAt)}
            </div>
          </div>
        )}

        {/* Waveform bars */}
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            height: 80,
            opacity: waveOpacity,
          }}
        >
          {waveformHeights.map((h, i) => {
            const scaled = Math.round(h * 0.6);
            const barColor = isScheduled
              ? `rgba(133, 93, 205, ${0.4 + (h / 134) * 0.5})`
              : `rgba(216, 90, 48, ${0.4 + (h / 134) * 0.5})`;
            return (
              <div
                key={i}
                style={{
                  width: 8,
                  height: scaled,
                  borderRadius: 4,
                  background: barColor,
                }}
              />
            );
          })}
        </div>
      </div>
    ),
    { ...size },
  );
}
