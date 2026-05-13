import { useCallback } from "react";
import { View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { CastCard } from "@/components/feed/CastCard";
import { NotificationHeader } from "@/components/notifications/NotificationHeader";
import { getTypeMeta } from "@/components/notifications/NotificationTypeBadge";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import type { NeynarCast, NeynarNotification } from "@/types/neynar";

interface NotificationItemProps {
  notification: NeynarNotification;
  isUnread: boolean;
  myFid: number;
  onLike: (hash: string, isLiked: boolean) => void;
  onRecast: (hash: string, isRecasted: boolean) => void;
  onBookmark: (hash: string, isBookmarked: boolean) => void;
  onReply: (cast: NeynarCast) => void;
  onQuoteCast: (cast: NeynarCast) => void;
}

export function NotificationItem({
  notification,
  isUnread,
  myFid,
  onLike,
  onRecast,
  onBookmark,
  onReply,
  onQuoteCast,
}: NotificationItemProps) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useStyles();
  const { type, cast } = notification;

  const handleCastPress = useCallback(() => {
    if (!cast) return;
    const threadHash = cast.thread_hash ?? cast.parent_hash ?? cast.hash;
    const focusHash = cast.hash !== threadHash ? cast.hash : undefined;
    router.push(
      focusHash
        ? `/cast/${threadHash}?focusHash=${focusHash}`
        : `/cast/${threadHash}`,
    );
  }, [cast, router]);

  // Spam guards — mirror NotificationHeader so the row collapses cleanly.
  if (type === "likes" || type === "recasts") {
    const liveReactors =
      notification.reactions?.filter((r) => !r.user.is_spam) ?? [];
    if (liveReactors.length === 0) return null;
  }
  if (type === "follows") {
    const liveFollows =
      notification.follows?.filter((f) => !f.user.is_spam) ?? [];
    if (liveFollows.length === 0) return null;
  }
  if (
    (type === "reply" || type === "mention" || type === "quote") &&
    (!cast || cast.author?.is_spam)
  ) {
    return null;
  }

  const meta = getTypeMeta(type, colors);
  const rowBackground = isUnread
    ? colors.background.surface
    : colors.background.main;

  return (
    <View style={[styles.container, { backgroundColor: rowBackground }]}>
      {isUnread ? (
        <View style={[styles.unreadBar, { backgroundColor: meta.color }]} />
      ) : null}
      <View style={styles.inner}>
        <NotificationHeader
          notification={notification}
          rowBackgroundColor={rowBackground}
        />
        {type !== "follows" && cast ? (
          <CastCard
            cast={cast}
            myFid={myFid}
            onLike={onLike}
            onRecast={onRecast}
            onBookmark={onBookmark}
            onReply={onReply}
            onQuoteCast={onQuoteCast}
            onPress={handleCastPress}
          />
        ) : null}
      </View>
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flexDirection: "row" as const,
      alignItems: "stretch" as const,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
    },
    unreadBar: {
      position: "absolute" as const,
      left: 0,
      top: 0,
      bottom: 0,
      width: 3,
    },
    inner: {
      flex: 1,
    },
  }));
