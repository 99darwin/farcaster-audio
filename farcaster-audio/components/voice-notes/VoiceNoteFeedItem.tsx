import React from "react";
import { View, Text, Pressable, Share, StyleSheet } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { VoiceNotePlayer } from "./VoiceNotePlayer";
import { ReactionBar } from "./ReactionBar";
import { colors, typography } from "@/constants/theme";
import type { VoiceNoteDetail } from "@/types/voiceNote";

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

interface VoiceNoteFeedItemProps {
  item: VoiceNoteDetail;
  onLike: (id: string, isLiked: boolean) => void;
  onRecast: (id: string, isRecasted: boolean) => void;
}

export const VoiceNoteFeedItem = React.memo(function VoiceNoteFeedItem({
  item,
  onLike,
  onRecast,
}: VoiceNoteFeedItemProps) {
  const router = useRouter();
  const { voice_note, author, reaction_counts, viewer_reactions, play_count } =
    item;
  const isLiked = viewer_reactions.includes("like");
  const isRecasted = viewer_reactions.includes("recast");

  const handleShare = () => {
    Share.share({ url: `https://juke.audio/v/${voice_note.id}` });
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable
          style={styles.authorRow}
          onPress={() => router.push(`/profile/${author.fid}`)}
          accessibilityRole="button"
          accessibilityLabel={`View ${author.display_name}'s profile`}
        >
          {author.pfp_url ? (
            <Image
              source={{ uri: author.pfp_url }}
              style={styles.avatar}
              accessibilityLabel={`${author.display_name}'s avatar`}
            />
          ) : (
            <View
              style={[styles.avatar, styles.avatarPlaceholder]}
              accessibilityLabel={`${author.display_name}'s avatar`}
            />
          )}
          <View>
            <Text style={styles.displayName}>{author.display_name}</Text>
            <Text style={styles.username}>@{author.username}</Text>
          </View>
        </Pressable>
        <Text style={styles.timestamp}>{timeAgo(voice_note.created_at)}</Text>
      </View>

      <VoiceNotePlayer voiceNote={voice_note} variant="feed" />

      <ReactionBar
        likeCount={reaction_counts.like || 0}
        recastCount={reaction_counts.recast || 0}
        playCount={play_count}
        isLiked={isLiked}
        isRecasted={isRecasted}
        onLike={() => onLike(voice_note.id, isLiked)}
        onRecast={() => onRecast(voice_note.id, isRecasted)}
        onShare={handleShare}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.background.border,
    gap: 12,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  authorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  avatarPlaceholder: {
    backgroundColor: colors.background.subtle,
  },
  displayName: {
    color: colors.text.primary,
    fontSize: typography.size.body,
    fontWeight: "600",
  },
  username: {
    color: colors.text.secondary,
    fontSize: typography.size.sm,
  },
  timestamp: {
    color: colors.text.secondary,
    fontSize: typography.size.sm,
  },
});
