import { Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { radii, spacing, typography } from "@/constants/theme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import type { ChannelSearchItem } from "@/types/api";

interface ChannelResultRowProps {
  channel: ChannelSearchItem;
  onPress?: (channel: ChannelSearchItem) => void;
}

function formatFollowers(count: number | null): string | null {
  if (count == null) return null;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M followers`;
  if (count >= 1_000) return `${Math.round(count / 100) / 10}K followers`;
  return `${count} ${count === 1 ? "follower" : "followers"}`;
}

export function ChannelResultRow({ channel, onPress }: ChannelResultRowProps) {
  const router = useRouter();
  const styles = useStyles();

  const handlePress = () => {
    if (onPress) {
      onPress(channel);
      return;
    }
    router.push(`/channel/${channel.id}`);
  };

  const followers = formatFollowers(channel.follower_count);
  const description = channel.description?.trim() || channel.name || null;

  return (
    <Pressable
      onPress={handlePress}
      style={styles.row}
      accessibilityRole="button"
      accessibilityLabel={`Open channel ${channel.id}`}
    >
      {channel.image_url ? (
        <Image
          source={{ uri: channel.image_url }}
          style={styles.avatar}
          contentFit="cover"
        />
      ) : (
        <View style={[styles.avatar, styles.avatarFallback]}>
          <Text style={styles.avatarInitial}>
            {channel.id[0]?.toUpperCase()}
          </Text>
        </View>
      )}
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>
          /{channel.id}
        </Text>
        {description ? (
          <Text style={styles.description} numberOfLines={1}>
            {description}
          </Text>
        ) : null}
        {followers ? (
          <Text style={styles.followers} numberOfLines={1}>
            {followers}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      gap: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
    },
    avatar: {
      width: 48,
      height: 48,
      borderRadius: radii.md,
    },
    avatarFallback: {
      backgroundColor: colors.background.subtle,
      justifyContent: "center" as const,
      alignItems: "center" as const,
    },
    avatarInitial: {
      color: colors.text.primary,
      fontSize: typography.size.md,
      fontWeight: typography.weight.semibold,
    },
    info: {
      flex: 1,
      minWidth: 0,
    },
    name: {
      color: colors.text.primary,
      fontSize: typography.size.body,
      fontWeight: typography.weight.semibold,
    },
    description: {
      color: colors.text.secondary,
      fontSize: typography.size.sm,
      marginTop: 2,
    },
    followers: {
      color: colors.text.secondary,
      fontSize: typography.size.sm,
      marginTop: 2,
    },
  }));
