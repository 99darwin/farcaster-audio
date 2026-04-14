import { useEffect, useState, useRef } from "react";
import {
  View,
  Text,
  Pressable,
  FlatList,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { Image } from "expo-image";
import { colors, spacing, radii, typography } from "@/constants/theme";
import { searchUsers } from "@/services/api";

interface MentionUser {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
}

interface MentionSuggestionsProps {
  text: string;
  cursorPosition: number;
  onSelect: (username: string, mentionStart: number) => void;
}

/**
 * Extracts the current @mention query based on cursor position.
 * Returns { query, start } or null if not in a mention context.
 */
function extractMentionQuery(
  text: string,
  cursor: number,
): { query: string; start: number } | null {
  // Walk backwards from cursor to find '@'
  let i = cursor - 1;
  while (i >= 0) {
    const char = text[i];
    if (char === "@") {
      // '@' must be at start of text or preceded by whitespace
      if (i === 0 || /\s/.test(text[i - 1])) {
        const query = text.slice(i + 1, cursor);
        // Only match if query looks like a partial username (no spaces)
        if (/^[a-zA-Z0-9._-]*$/.test(query)) {
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

export function MentionSuggestions({
  text,
  cursorPosition,
  onSelect,
}: MentionSuggestionsProps) {
  const [users, setUsers] = useState<MentionUser[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQueryRef = useRef("");

  const mention = extractMentionQuery(text, cursorPosition);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!mention || mention.query.length === 0) {
      setUsers([]);
      lastQueryRef.current = "";
      return;
    }

    const query = mention.query;
    if (query === lastQueryRef.current) return;

    debounceRef.current = setTimeout(async () => {
      lastQueryRef.current = query;
      setIsLoading(true);
      try {
        const data = await searchUsers(query);
        setUsers(data.users);
      } catch {
        setUsers([]);
      } finally {
        setIsLoading(false);
      }
    }, 200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [mention?.query]);

  if (!mention || (users.length === 0 && !isLoading)) return null;

  return (
    <View style={styles.container}>
      {isLoading && users.length === 0 ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={colors.text.secondary} />
        </View>
      ) : (
        <FlatList
          data={users}
          keyExtractor={(item) => String(item.fid)}
          keyboardShouldPersistTaps="always"
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => onSelect(item.username, mention.start)}
              accessibilityRole="button"
              accessibilityLabel={`Mention ${item.display_name}`}
            >
              {item.pfp_url ? (
                <Image
                  source={{ uri: item.pfp_url }}
                  style={styles.avatar}
                  contentFit="cover"
                />
              ) : (
                <View style={[styles.avatar, styles.avatarFallback]}>
                  <Text style={styles.avatarInitial}>
                    {(item.display_name || item.username)[0]?.toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={styles.userInfo}>
                <Text style={styles.displayName} numberOfLines={1}>
                  {item.display_name}
                </Text>
                <Text style={styles.username} numberOfLines={1}>
                  @{item.username}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    maxHeight: 200,
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
    borderRadius: 16,
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
  userInfo: {
    flex: 1,
  },
  displayName: {
    color: colors.text.primary,
    fontSize: typography.size.body,
    fontWeight: typography.weight.semibold,
  },
  username: {
    color: colors.text.secondary,
    fontSize: typography.size.sm,
  },
});
