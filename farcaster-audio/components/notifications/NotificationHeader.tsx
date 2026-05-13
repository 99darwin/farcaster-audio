import { useEffect, useState, type JSX } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { getTypeMeta } from "@/components/notifications/NotificationTypeBadge";
import { ReactorStack } from "@/components/notifications/ReactorStack";
import { typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { getUserProfile } from "@/services/api";
import type { NeynarCastAuthor, NeynarNotification } from "@/types/neynar";

const usernameByFidCache = new Map<number, string>();
const inflightByFid = new Map<number, Promise<string | undefined>>();

function useUsernameByFid(fid: number | undefined): string | undefined {
  const [username, setUsername] = useState<string | undefined>(() =>
    fid ? usernameByFidCache.get(fid) : undefined,
  );

  useEffect(() => {
    if (!fid) return;
    const cached = usernameByFidCache.get(fid);
    if (cached) {
      setUsername(cached);
      return;
    }
    let cancelled = false;
    let pending = inflightByFid.get(fid);
    if (!pending) {
      pending = getUserProfile(fid)
        .then((data: { user?: { username?: string } }) => {
          const name = data?.user?.username;
          if (name) usernameByFidCache.set(fid, name);
          return name;
        })
        .catch(() => undefined)
        .finally(() => {
          inflightByFid.delete(fid);
        });
      inflightByFid.set(fid, pending);
    }
    pending.then((name) => {
      if (!cancelled && name) setUsername(name);
    });
    return () => {
      cancelled = true;
    };
  }, [fid]);

  return username;
}

const AGGREGATE_ACTION_TEXT: Record<
  "likes" | "recasts" | "follows",
  string
> = {
  likes: "liked your cast",
  recasts: "recasted your cast",
  follows: "followed you",
};

const SINGLE_ACTION_TEXT: Record<"reply" | "mention" | "quote", string> = {
  reply: "replied to your cast",
  mention: "mentioned you",
  quote: "quoted your cast",
};

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

function getDisplayName(user: NeynarCastAuthor): string {
  return user.display_name || user.username;
}

interface NotificationHeaderProps {
  notification: NeynarNotification;
  rowBackgroundColor: string;
}

export function NotificationHeader({
  notification,
  rowBackgroundColor,
}: NotificationHeaderProps): JSX.Element | null {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useStyles();
  const { type, most_recent_timestamp } = notification;
  const meta = getTypeMeta(type, colors);
  const timestamp = getRelativeTime(most_recent_timestamp);

  if (type === "likes" || type === "recasts" || type === "follows") {
    const reactorUsers: NeynarCastAuthor[] =
      type === "follows"
        ? (notification.follows
            ?.map((f) => f.user)
            .filter((u) => !u.is_spam) ?? [])
        : (notification.reactions
            ?.map((r) => r.user)
            .filter((u) => !u.is_spam) ?? []);

    if (reactorUsers.length === 0) return null;

    const first = reactorUsers[0];
    const firstDisplayName = getDisplayName(first);
    const totalCount = notification.count ?? reactorUsers.length;
    const extraCount = Math.max(0, totalCount - 1);
    const actionText = AGGREGATE_ACTION_TEXT[type];

    const handleFirstPress = () => {
      router.push(`/profile/${first.fid}`);
    };

    return (
      <View style={styles.container}>
        <ReactorStack
          users={reactorUsers}
          maxVisible={6}
          size={24}
          ringColor={rowBackgroundColor}
        />
        <View style={styles.actionRow}>
          <Pressable
            onPress={handleFirstPress}
            accessibilityRole="button"
            accessibilityLabel={firstDisplayName}
          >
            <Text style={styles.username}>{firstDisplayName}</Text>
          </Pressable>
          {extraCount > 0 ? (
            <Text style={styles.secondary}>
              and {extraCount} other{extraCount > 1 ? "s" : ""}
            </Text>
          ) : null}
          <Ionicons name={meta.icon} size={14} color={meta.color} />
          <Text style={styles.secondary}>{actionText}</Text>
          <Text style={styles.time}> · {timestamp}</Text>
        </View>
      </View>
    );
  }

  // Single-actor variants: reply, mention, quote
  const actor = notification.cast?.author;
  if (!actor || actor.is_spam) return null;

  const actorDisplayName = getDisplayName(actor);
  const actionText = SINGLE_ACTION_TEXT[type];
  const parentAuthor = notification.cast?.parent_author;
  const resolvedParentUsername = useUsernameByFid(
    type === "reply" && parentAuthor && !parentAuthor.username
      ? parentAuthor.fid
      : undefined,
  );
  const parentUsername = parentAuthor?.username ?? resolvedParentUsername;
  const showReplyingTo = type === "reply" && parentAuthor && parentUsername;

  const handleActorPress = () => {
    router.push(`/profile/${actor.fid}`);
  };

  const handleParentPress = () => {
    if (parentAuthor) {
      router.push(`/profile/${parentAuthor.fid}`);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.actionRow}>
        <Pressable
          onPress={handleActorPress}
          accessibilityRole="button"
          accessibilityLabel={actorDisplayName}
        >
          <Text style={styles.username}>{actorDisplayName}</Text>
        </Pressable>
        <Ionicons name={meta.icon} size={14} color={meta.color} />
        <Text style={styles.secondary}>{actionText}</Text>
        <Text style={styles.time}> · {timestamp}</Text>
      </View>
      {showReplyingTo && parentUsername ? (
        <Text style={styles.replyingTo}>
          Replying to{" "}
          <Text
            style={styles.replyingToLink}
            onPress={handleParentPress}
            accessibilityRole="link"
            accessibilityLabel={`@${parentUsername}`}
          >
            @{parentUsername}
          </Text>
        </Text>
      ) : null}
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flexDirection: "column" as const,
      gap: 6,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
    },
    actionRow: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      alignItems: "center" as const,
      gap: 4,
    },
    username: {
      fontWeight: "600" as const,
      color: colors.text.primary,
      fontSize: typography.size.body,
    },
    secondary: {
      color: colors.text.secondary,
      fontSize: typography.size.body,
    },
    time: {
      color: colors.text.placeholder,
      fontSize: typography.size.sm,
    },
    replyingTo: {
      fontSize: typography.size.body2,
      color: colors.text.secondary,
      marginTop: 2,
    },
    replyingToLink: {
      fontSize: typography.size.body2,
      color: colors.text.secondary,
      fontWeight: "600" as const,
    },
  }));
