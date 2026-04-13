import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useVoiceNotePlayback } from "@/hooks/useVoiceNotePlayback";
import { Waveform } from "./Waveform";
import { Transcript } from "./Transcript";
import { colors, radii, typography } from "@/constants/theme";
import type { VoiceNote } from "@/types/voiceNote";

const DEFAULT_PEAK_COUNT = 200;
const DEFAULT_PEAK_VALUE = 0.1;

interface VoiceNotePlayerProps {
  voiceNote: VoiceNote;
  variant?: "feed" | "fullscreen" | "compact";
}

function formatTime(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function VoiceNotePlayer({
  voiceNote,
  variant = "feed",
}: VoiceNotePlayerProps) {
  const {
    isPlaying,
    positionMs,
    speed,
    togglePlay,
    seekTo,
    cycleSpeed,
    progress,
  } = useVoiceNotePlayback(
    voiceNote.id,
    voiceNote.audio_url,
    voiceNote.duration_ms,
  );

  const handleSeek = (p: number) => {
    seekTo(Math.floor(p * voiceNote.duration_ms));
  };

  const peaks =
    voiceNote.waveform_peaks ||
    Array(DEFAULT_PEAK_COUNT).fill(DEFAULT_PEAK_VALUE);

  return (
    <View style={styles.container}>
      <View style={styles.playerRow}>
        <Pressable
          onPress={togglePlay}
          style={styles.playButton}
          accessibilityLabel={isPlaying ? "Pause" : "Play"}
          accessibilityRole="button"
        >
          <Ionicons
            name={isPlaying ? "pause" : "play"}
            size={22}
            color={colors.text.primary}
          />
        </Pressable>

        <View style={styles.waveformContainer}>
          <Waveform peaks={peaks} progress={progress} onSeek={handleSeek} />
        </View>
      </View>

      <View style={styles.infoRow}>
        <Text style={styles.time}>
          {formatTime(positionMs)} / {formatTime(voiceNote.duration_ms)}
        </Text>
        <Pressable
          onPress={cycleSpeed}
          style={styles.speedButton}
          accessibilityLabel={`Playback speed ${speed}x`}
          accessibilityRole="button"
        >
          <Text style={styles.speedText}>{speed}x</Text>
        </Pressable>
      </View>

      {voiceNote.transcript && variant !== "compact" && (
        <Transcript
          text={voiceNote.transcript}
          words={voiceNote.transcript_words}
          positionMs={positionMs}
        />
      )}

      {voiceNote.caption ? (
        <Text style={styles.caption}>{voiceNote.caption}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
  },
  playerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  playButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.background.subtle,
    alignItems: "center",
    justifyContent: "center",
  },
  waveformContainer: {
    flex: 1,
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  time: {
    color: colors.text.secondary,
    fontSize: typography.size.sm,
    fontVariant: ["tabular-nums"],
  },
  speedButton: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.xs,
    backgroundColor: colors.background.subtle,
  },
  speedText: {
    color: colors.text.secondary,
    fontSize: typography.size.sm,
    fontWeight: "600",
  },
  caption: {
    color: colors.text.body,
    fontSize: typography.size.body,
    lineHeight: 20,
  },
});
