"use client";

interface WebRecordingPlayerProps {
  audioUrl: string;
}

export function WebRecordingPlayer({ audioUrl }: WebRecordingPlayerProps) {
  return (
    <audio
      controls
      preload="none"
      src={audioUrl}
      className="w-full"
      controlsList="nodownload"
    />
  );
}
