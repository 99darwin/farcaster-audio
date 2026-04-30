import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import { radii, spacing, typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { searchChannels } from "@/services/api";
import type { ChannelSearchItem } from "@/types/api";

interface ChannelSuggestionsProps {
  enabled: boolean;
  text: string;
  cursorPosition: number;
  onSelect: (channelId: string, tokenStart: number) => void;
}

function extractChannelQuery(
  text: string,
  cursor: number,
): { query: string; start: number } | null {
  let i = cursor - 1;
  while (i >= 0) {
    const char = text[i];
    if (char === "/") {
      if (i === 0 || /\s/.test(text[i - 1])) {
        const query = text.slice(i + 1, cursor);
        if (/^[a-zA-Z0-9_-]*$/.test(query)) {
          return { query, start: i };
        }
      }
      return null;
    }
    if (/\s/.test(char)) return null;
    i--;
  }
  return null;
}

function formatFollowers(count: number | null): string | null {
  if (count == null) return null;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M followers`;
  if (count >= 1_000) return `${Math.round(count / 100) / 10}K followers`;
  return `${count} ${count === 1 ? "follower" : "followers"}`;
}

export function ChannelSuggestions({
  enabled,
  text,
  cursorPosition,
  onSelect,
}: ChannelSuggestionsProps) {
  const [channels, setChannels] = useState<ChannelSearchItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQueryRef = useRef("");
  const channel = enabled ? extractChannelQuery(text, cursorPosition) : null;
  const { colors } = useTheme();
  const styles = useStyles();

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!channel || channel.query.length === 0) {
      setChannels([]);
      lastQueryRef.current = "";
      return;
    }

    const query = channel.query;
    if (query === lastQueryRef.current) return;

    debounceRef.current = setTimeout(async () => {
      lastQueryRef.current = query;
      setIsLoading(true);
      try {
        const data = await searchChannels(query);
        setChannels(data.channels);
      } catch {
        setChannels([]);
      } finally {
        setIsLoading(false);
      }
    }, 200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [channel?.query]);

  if (!channel || (channels.length === 0 && !isLoading)) return null;

  return (
    <View style={styles.container}>
      {isLoading && channels.length === 0 ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={colors.text.secondary} />
        </View>
      ) : (
        <FlatList
          data={channels}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="always"
          renderItem={({ item }) => {
            const followers = formatFollowers(item.follower_count);
            return (
              <Pressable
                style={styles.row}
                onPress={() => onSelect(item.id, channel.start)}
                accessibilityRole="button"
                accessibilityLabel={`Post to channel ${item.id}`}
              >
                {item.image_url ? (
                  <Image
                    source={{ uri: item.image_url }}
                    style={styles.avatar}
                    contentFit="cover"
                  />
                ) : (
                  <View style={[styles.avatar, styles.avatarFallback]}>
                    <Text style={styles.avatarInitial}>
                      {item.id[0]?.toUpperCase()}
                    </Text>
                  </View>
                )}
                <View style={styles.channelInfo}>
                  <Text style={styles.channelName} numberOfLines={1}>
                    /{item.id}
                  </Text>
                  <Text style={styles.channelMeta} numberOfLines={1}>
                    {item.name || followers || "Channel"}
                  </Text>
                </View>
                {followers ? (
                  <Text style={styles.followers} numberOfLines={1}>
                    {followers}
                  </Text>
                ) : null}
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      maxHeight: 220,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.background.border,
      backgroundColor: colors.background.surface,
    },
    loadingRow: {
      paddingVertical: spacing.md,
      alignItems: "center",
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      gap: spacing.md,
    },
    avatar: {
      width: 32,
      height: 32,
      borderRadius: radii.sm,
    },
    avatarFallback: {
      backgroundColor: colors.background.subtle,
      justifyContent: "center",
      alignItems: "center",
    },
    avatarInitial: {
      color: colors.text.primary,
      fontSize: typography.size.sm,
      fontWeight: typography.weight.semibold,
    },
    channelInfo: {
      flex: 1,
    },
    channelName: {
      color: colors.text.primary,
      fontSize: typography.size.body,
      fontWeight: typography.weight.semibold,
    },
    channelMeta: {
      color: colors.text.secondary,
      fontSize: typography.size.sm,
    },
    followers: {
      maxWidth: 100,
      color: colors.text.secondary,
      fontSize: typography.size.sm,
    },
  }));
