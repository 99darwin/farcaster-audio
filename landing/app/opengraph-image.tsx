import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Juke — Live Audio on Farcaster";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  // Diamond/chevron pattern: bars ascend from edges to a tall center peak
  const waveformHeights = [
    16, 28, 40, 52, 64, 76, 88, 100, 108, 116, 124, 130, 134,
    130, 124, 116, 108, 100, 88, 76, 64, 52, 40, 28, 16,
  ];

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
        {/* Subtle radial glow behind the text */}
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: 800,
            height: 400,
            borderRadius: "50%",
            background:
              "radial-gradient(ellipse at center, rgba(216,90,48,0.08) 0%, transparent 70%)",
            display: "flex",
          }}
        />

        {/* JUKE title */}
        <div
          style={{
            display: "flex",
            fontSize: 128,
            fontWeight: 800,
            color: "#ffffff",
            letterSpacing: "0.12em",
            lineHeight: 1,
            marginBottom: 16,
          }}
        >
          JUKE
        </div>

        {/* Subtitle */}
        <div
          style={{
            display: "flex",
            fontSize: 32,
            color: "#9898b8",
            fontWeight: 400,
            letterSpacing: "0.04em",
            marginBottom: 56,
          }}
        >
          Live audio on Farcaster
        </div>

        {/* Waveform bars */}
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            height: 134,
          }}
        >
          {waveformHeights.map((h, i) => (
            <div
              key={i}
              style={{
                width: 10,
                height: h,
                borderRadius: 5,
                background: `rgba(216, 90, 48, ${0.5 + (h / 134) * 0.5})`,
              }}
            />
          ))}
        </div>
      </div>
    ),
    { ...size },
  );
}
