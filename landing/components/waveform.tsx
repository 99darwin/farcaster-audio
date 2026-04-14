"use client";

export const BAR_COUNT = 60;
export const BAR_GAP = 2;
export const BAR_MIN_HEIGHT = 2;
export const WAVEFORM_HEIGHT = 64;

/** Downsample peaks to a target bar count for display. */
export function downsamplePeaks(peaks: number[], targetCount: number): number[] {
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

interface WaveformProps {
  peaks: number[];
  progress: number;
  onSeek?: (fraction: number) => void;
  barCount?: number;
  height?: number;
  activeColor?: string;
  inactiveColor?: string;
  className?: string;
}

export function Waveform({
  peaks,
  progress,
  onSeek,
  barCount = BAR_COUNT,
  height = WAVEFORM_HEIGHT,
  activeColor = "#D85A30",
  inactiveColor = "#2a2a4a",
  className = "h-16 w-full cursor-pointer",
}: WaveformProps) {
  const displayPeaks = downsamplePeaks(peaks, barCount);

  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!onSeek) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const fraction = Math.max(0, Math.min(1, clickX / rect.width));
    onSeek(fraction);
  };

  return (
    <svg
      viewBox={`0 0 ${barCount * (4 + BAR_GAP)} ${height}`}
      preserveAspectRatio="none"
      className={className}
      onClick={handleClick}
      role="slider"
      aria-label="Audio progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
    >
      {displayPeaks.map((peak, i) => {
        const barHeight = Math.max(BAR_MIN_HEIGHT, peak * (height - 4));
        const x = i * (4 + BAR_GAP);
        const y = (height - barHeight) / 2;
        const barProgress = i / displayPeaks.length;
        const isPlayed = barProgress < progress;

        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={4}
            height={barHeight}
            rx={1.5}
            fill={isPlayed ? activeColor : inactiveColor}
            className="transition-[fill] duration-75"
          />
        );
      })}
    </svg>
  );
}
