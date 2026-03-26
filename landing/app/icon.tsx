import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  const barWidth = 4;
  const gap = 2;
  const totalWidth = barWidth * 4 + gap * 3;
  const offsetX = (32 - totalWidth) / 2;
  const barHeights = [10, 20, 16, 18];
  const baseY = 16;

  return new ImageResponse(
    (
      <div
        style={{
          width: "32px",
          height: "32px",
          backgroundColor: "#855DCD",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "6px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: `${gap}px`,
          }}
        >
          {barHeights.map((h, i) => (
            <div
              key={i}
              style={{
                width: `${barWidth}px`,
                height: `${h}px`,
                backgroundColor: "#D85A30",
                borderRadius: "2px",
              }}
            />
          ))}
        </div>
      </div>
    ),
    { ...size }
  );
}
