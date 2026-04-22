import { View, Text, Pressable, StyleSheet, Share } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useVoiceNotePlayback } from "@/hooks/useVoiceNotePlayback";
import { colors } from "@/constants/theme";
import type { RecordingItem } from "@/services/api";

interface RecordingFeedItemProps {
  item: RecordingItem;
}

function formatTime(ms: number): string {
  const totalSecs = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatDate(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(dateStr).toLocaleDateString();
}

export function RecordingFeedItem({ item }: RecordingFeedItemProps) {
  // Reuse the voice-note playback hook — it handles OGG, audio session,
  // background audio, and the "single active player" coordination store.
  // We use the room_id as the playback key so only one recording plays at a time.
  //
  // Note: `item.recording_url` is a short-lived presigned GET (~15 min TTL)
  // minted per list request. The hook reads it when the user taps play, so
  // as long as the list itself was fetched recently we're fine. If the app
  // has been backgrounded for a long stretch the profile page should refetch
  // before a play attempt — callers should re-hit the recordings endpoint
  // when the profile screen regains focus.
  const durationMs = (item.duration_seconds ?? 0) * 1000;
  const { isPlaying, positionMs, togglePlay, progress, cycleSpeed, speed } =
    useVoiceNotePlayback(
      `recording:${item.room_id}`,
      item.recording_url,
      durationMs,
    );

  const displayTime = durationMs > 0
    ? `${formatTime(positionMs)} / ${formatTime(durationMs)}`
    : formatTime(positionMs);

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <Pressable
          onPress={togglePlay}
          style={styles.playButton}
          accessibilityRole="button"
          accessibilityLabel={isPlaying ? "Pause recording" : "Play recording"}
        >
          <Ionicons
            name={isPlaying ? "pause" : "play"}
            size={22}
            color={colors.text.primary}
          />
        </Pressable>
        <View style={styles.info}>
          <Text numberOfLines={1} style={styles.title}>
            {item.title}
          </Text>
          <View style={styles.metaRow}>
            <Text style={styles.meta}>{displayTime}</Text>
            <Text style={styles.metaDot}>·</Text>
            <Text style={styles.meta}>{formatDate(item.started_at)}</Text>
          </View>
        </View>
        <Pressable
          onPress={cycleSpeed}
          style={styles.speedButton}
          accessibilityRole="button"
          accessibilityLabel={`Playback speed ${speed}x`}
        >
          <Text style={styles.speedText}>{speed}x</Text>
        </Pressable>
        <Pressable
          onPress={() => Share.share({ url: item.recording_url })}
          style={styles.shareButton}
          accessibilityRole="button"
          accessibilityLabel="Share recording"
        >
          <Ionicons
            name="share-outline"
            size={18}
            color={colors.text.secondary}
          />
        </Pressable>
      </View>
      <View style={styles.progressTrack}>
        <View
          style={[
            styles.progressFill,
            { width: `${Math.min(100, Math.max(0, progress * 100))}%` },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.background.border,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  playButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.background.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  info: { flex: 1 },
  title: {
    color: colors.text.primary,
    fontSize: 15,
    fontWeight: "600",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
  },
  meta: {
    color: colors.text.secondary,
    fontSize: 13,
  },
  metaDot: { color: colors.text.secondary, fontSize: 13 },
  speedButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: colors.background.surface,
    minWidth: 36,
    alignItems: "center",
  },
  speedText: {
    color: colors.text.secondary,
    fontSize: 12,
    fontWeight: "600",
  },
  shareButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  progressTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.background.border,
    marginTop: 10,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: colors.purple,
  },
});
