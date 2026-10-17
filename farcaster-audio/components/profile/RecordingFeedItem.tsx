import { View, Text, Pressable, StyleSheet, Share } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useVoiceNotePlayback } from "@/hooks/useVoiceNotePlayback";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { buildRecordingUrl } from "@/utils/shareLinks";
import type { RecordingItem } from "@/services/api";

interface RecordingFeedItemProps {
  item: RecordingItem;
  // Optional "Part N of M" hint, populated by the profile screen only
  // when a space has more than one finalized segment. Single-segment
  // recordings render without the badge to keep the common case clean.
  partInfo?: { index: number; total: number };
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

export function RecordingFeedItem({ item, partInfo }: RecordingFeedItemProps) {
  // Reuse the voice-note playback hook — it handles OGG, audio session,
  // background audio, and the "single active player" coordination store.
  // Playback key prefers the segment UUID so two segments of the same
  // space don't share a player slot (which would cause tapping play on
  // one to scrub the other). Falls back to room_id for legacy rows.
  //
  // Note: `item.recording_url` is a short-lived presigned GET (~15 min TTL)
  // minted per list request. The hook reads it when the user taps play, so
  // as long as the list itself was fetched recently we're fine. If the app
  // has been backgrounded for a long stretch the profile page should refetch
  // before a play attempt — callers should re-hit the recordings endpoint
  // when the profile screen regains focus.
  const { colors } = useTheme();
  const styles = useStyles();
  const durationMs = (item.duration_seconds ?? 0) * 1000;
  const playbackKey = `recording:${item.id ?? item.room_id}`;
  const { isPlaying, positionMs, togglePlay, progress, cycleSpeed, speed } =
    useVoiceNotePlayback(playbackKey, item.recording_url, durationMs);

  const displayTime =
    durationMs > 0
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
          <View style={styles.titleRow}>
            <Text numberOfLines={1} style={styles.title}>
              {item.title}
            </Text>
            {partInfo ? (
              <View style={styles.partBadge}>
                <Text style={styles.partBadgeText}>
                  Part {partInfo.index} of {partInfo.total}
                </Text>
              </View>
            ) : null}
          </View>
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
          // Share the durable web-player link, NOT `item.recording_url` —
          // that's a ~15-min presigned URL that yields "Request has expired"
          // once shared and opened later. The player page re-presigns on
          // load and exposes a Download action.
          onPress={() => Share.share({ url: buildRecordingUrl(item.room_id) })}
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

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
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
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    title: {
      color: colors.text.primary,
      fontSize: 15,
      fontWeight: "600",
      flexShrink: 1,
    },
    partBadge: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      backgroundColor: colors.background.surface,
    },
    partBadgeText: {
      color: colors.text.secondary,
      fontSize: 11,
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
  }));
