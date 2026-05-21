import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Juke Voice Note";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8000";

interface VoiceNote {
  id: string;
  duration_ms: number;
  waveform_peaks: number[] | null;
  transcript: string | null;
  caption: string | null;
}

interface Author {
  username: string;
  display_name: string;
  pfp_url: string | null;
}

interface VoiceNoteDetail {
  voice_note: VoiceNote;
  author: Author;
  play_count: number;
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}:${remainSecs.toString().padStart(2, "0")}`;
}

/** Downsample peaks to a target count for OG image display. */
function downsamplePeaks(peaks: number[], targetCount: number): number[] {
  if (peaks.length <= targetCount) return peaks;
  const result: number[] = [];
  const bucketSize = peaks.length / targetCount;
  for (let i = 0; i < targetCount; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.floor((i + 1) * bucketSize);
    let max = 0;
    for (let j = start; j < end; j++) {
      if (peaks[j] > max) max = peaks[j];
    }
    result.push(max);
  }
  return result;
}

/** Seeded pseudo-random for deterministic fallback bars. */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const OG_BAR_COUNT = 60;

const ALLOWED_PFP_HOSTS = ['i.imgur.com', 'imagedelivery.net', 'res.cloudinary.com', 'wrpcd.net', 'i.seadn.io'];
function isSafePfpUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return ALLOWED_PFP_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
  } catch { return false; }
}

export default async function Image({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let data: VoiceNoteDetail | null = null;
  try {
    const res = await fetch(`${API_BASE_URL}/v1/voice-notes/${id}`, {
      next: { revalidate: 60 },
    });
    if (res.ok) data = await res.json();
  } catch {
    // Fall through to fallback rendering
  }

  // Fallback: simple Juke branding if we can't fetch data
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
            Voice Note
          </span>
        </div>
      ),
      { ...size },
    );
  }

  const { voice_note, author } = data;

  const rawPeaks = voice_note.waveform_peaks;
  let peaks: number[];
  if (rawPeaks && rawPeaks.length > 0) {
    peaks = downsamplePeaks(rawPeaks, OG_BAR_COUNT);
  } else {
    const rand = seededRandom(id.charCodeAt(0) * 31 + id.length);
    peaks = Array.from({ length: OG_BAR_COUNT }, () => rand() * 0.6 + 0.15);
  }

  const snippet = voice_note.transcript
    ? voice_note.transcript.slice(0, 100) +
      (voice_note.transcript.length > 100 ? "..." : "")
    : voice_note.caption
      ? voice_note.caption.slice(0, 100) +
        (voice_note.caption.length > 100 ? "..." : "")
      : null;

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
        {/* Author row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 20,
            marginBottom: 40,
          }}
        >
          {isSafePfpUrl(author.pfp_url) ? (
            <img
              src={author.pfp_url!}
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
              {author.display_name.charAt(0).toUpperCase()}
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
              {author.display_name}
            </span>
            <span
              style={{
                color: "#7a7a9a",
                fontSize: 24,
                lineHeight: 1.3,
              }}
            >
              @{author.username}
            </span>
          </div>
        </div>

        {/* Waveform bars */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            height: 140,
            width: "100%",
            marginBottom: 12,
          }}
        >
          {peaks.map((peak, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: `${Math.max(6, peak * 100)}%`,
                backgroundColor: i < peaks.length * 0.4 ? "#D85A30" : "#2a2a4a",
                borderRadius: 3,
              }}
            />
          ))}
        </div>

        {/* Snippet if available */}
        {snippet && (
          <div
            style={{
              display: "flex",
              marginBottom: 12,
            }}
          >
            <span
              style={{
                color: "#a0a0c0",
                fontSize: 22,
                lineHeight: 1.4,
              }}
            >
              &ldquo;{snippet}&rdquo;
            </span>
          </div>
        )}

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
              {formatDuration(voice_note.duration_ms)}
            </span>
            <span style={{ color: "#3a3a5a", fontSize: 28 }}>&bull;</span>
            <span style={{ color: "#7a7a9a", fontSize: 24 }}>Voice Note</span>
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
