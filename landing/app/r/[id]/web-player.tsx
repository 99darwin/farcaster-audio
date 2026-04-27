"use client";

import { RecordingAudioPlayer } from "@/components/recording-audio-player";

interface WebRecordingPlayerProps {
  audioUrl: string;
  title: string;
  hostName: string;
  artworkUrl?: string | null;
}

export function WebRecordingPlayer({
  audioUrl,
  title,
  hostName,
  artworkUrl,
}: WebRecordingPlayerProps) {
  return (
    <RecordingAudioPlayer
      audioUrl={audioUrl}
      title={title}
      hostName={hostName}
      artworkUrl={artworkUrl}
      className="w-full"
    />
  );
}
