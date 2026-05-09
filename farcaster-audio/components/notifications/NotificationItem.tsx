import { View, Text, Pressable, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { Avatar } from "@/components/common/Avatar";
import { CastActions } from "@/components/feed/CastActions";
import {
  NotificationTypeBadge,
  getTypeMeta,
} from "@/components/notifications/NotificationTypeBadge";
import { QuotedCastInline } from "@/components/notifications/QuotedCastInline";
import { typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import type {
  NeynarCast,
  NeynarCastAuthor,
  NeynarNotification,
} from "@/types/neynar";

function getRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}

function getLongRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24)
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
}

const ACTION_TEXT: Record<string, string> = {
  likes: "liked your cast",
  recasts: "recasted your cast",
  follows: "followed you",
  reply: "replied to your cast",
  mention: "mentioned you",
  quote: "quoted your cast",
};

function getActor(notification: NeynarNotification): NeynarCastAuthor | null {
  const { type } = notification;
  if (
    (type === "likes" || type === "recasts") &&
    notification.reactions?.length
  ) {
    return notification.reactions[0].user;
  }
  if (type === "follows" && notification.follows?.length) {
    return notification.follows[0].user;
  }
  if (
    (type === "reply" || type === "mention" || type === "quote") &&
    notification.cast
  ) {
    return notification.cast.author;
  }
  return null;
}

interface NotificationItemProps {
  notification: NeynarNotification;
  isUnread: boolean;
  onLike?: (hash: string, isLiked: boolean) => void;
  onRecast?: (hash: string, isRecasted: boolean) => void;
  onBookmark?: (hash: string, isBookmarked: boolean) => void;
  onReply?: (cast: NeynarCast) => void;
  onQuoteCast?: (cast: NeynarCast) => void;
}

export function NotificationItem({
  notification,
  isUnread,
  onLike,
  onRecast,
  onBookmark,
  onReply,
  onQuoteCast,
}: NotificationItemProps) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useStyles();
  const { type, cast, most_recent_timestamp } = notification;
  const actor = getActor(notification);
  const extraCount = Math.max(0, (notification.count ?? 0) - 1);

  if (!actor) return null;

  const meta = getTypeMeta(type, colors);
  const rowBackground = isUnread
    ? colors.background.surface
    : colors.background.main;

  const handlePress = () => {
    if (type === "follows") {
      router.push(`/profile/${actor.fid}`);
    } else if (cast?.hash) {
      // Open the full thread so parent context is visible, and pass
      // focusHash so the tapped reply is highlighted + scrolled to.
      const threadHash = cast.thread_hash ?? cast.parent_hash ?? cast.hash;
      const focusHash = cast.hash !== threadHash ? cast.hash : undefined;
      router.push(
        focusHash
          ? `/cast/${threadHash}?focusHash=${focusHash}`
          : `/cast/${threadHash}`,
      );
    }
  };

  const displayName = actor.display_name || actor.username;
  const othersText =
    extraCount > 0
      ? ` and ${extraCount} other${extraCount > 1 ? "s" : ""}`
      : "";
  const actionText = ACTION_TEXT[type] ?? type;
  const quotedCast =
    type === "quote" ? (cast?.embeds?.find((e) => e.cast)?.cast ?? null) : null;

  const showActions = type === "reply" && cast?.hash;

  return (
    <Pressable
      style={[styles.container, { backgroundColor: rowBackground }]}
      onPress={handlePress}
      accessibilityLabel={`${displayName}${othersText} ${actionText}, ${getLongRelativeTime(most_recent_timestamp)}`}
    >
      {isUnread ? (
        <View style={[styles.unreadBar, { backgroundColor: meta.color }]} />
      ) : null}
      <View style={styles.avatarWrap}>
        <Avatar pfpUrl={actor.pfp_url} displayName={displayName} size="md" />
        <View style={styles.badgeAnchor}>
          <NotificationTypeBadge type={type} ringColor={rowBackground} />
        </View>
      </View>
      <View style={styles.content}>
        <Text style={styles.actionLine} numberOfLines={2}>
          <Text style={styles.username}>{displayName}</Text>
          {othersText ? <Text style={styles.action}>{othersText}</Text> : null}
          <Text style={styles.action}> {actionText}</Text>
          <Text style={styles.time}>
            {"  ·  "}
            {getRelativeTime(most_recent_timestamp)}
          </Text>
        </Text>
        {type !== "follows" && cast?.text ? (
          <Text style={styles.preview} numberOfLines={2}>
            {cast.text}
          </Text>
        ) : null}
        {quotedCast ? <QuotedCastInline cast={quotedCast} /> : null}
        {showActions && cast ? (
          <CastActions
            likesCount={cast.reactions.likes_count}
            recastsCount={cast.reactions.recasts_count}
            repliesCount={cast.replies.count}
            isLiked={cast.viewer_context?.liked ?? false}
            isRecasted={cast.viewer_context?.recasted ?? false}
            isBookmarked={cast.viewer_context?.bookmarked ?? false}
            onLike={() =>
              onLike?.(cast.hash, cast.viewer_context?.liked ?? false)
            }
            onRecast={() =>
              onRecast?.(cast.hash, cast.viewer_context?.recasted ?? false)
            }
            onBookmark={() =>
              onBookmark?.(cast.hash, cast.viewer_context?.bookmarked ?? false)
            }
            onQuoteCast={() => onQuoteCast?.(cast)}
            onReply={() => onReply?.(cast)}
            authorUsername={cast.author.username}
            castHash={cast.hash}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flexDirection: "row",
      alignItems: "flex-start",
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
      gap: 12,
    },
    unreadBar: {
      position: "absolute",
      left: 0,
      top: 0,
      bottom: 0,
      width: 3,
    },
    avatarWrap: {
      position: "relative",
    },
    badgeAnchor: {
      position: "absolute",
      right: -2,
      bottom: -2,
    },
    content: {
      flex: 1,
      gap: 2,
    },
    actionLine: {
      fontSize: typography.size.body,
      color: colors.text.body,
    },
    username: {
      fontWeight: "600",
      color: colors.text.primary,
    },
    action: {
      color: colors.text.secondary,
    },
    time: {
      color: colors.text.placeholder,
      fontSize: typography.size.sm,
    },
    preview: {
      color: colors.text.secondary,
      fontSize: typography.size.body2,
      lineHeight: 18,
    },
  }));
