/**
 * New message: pick a recipient (debounced `GET /recipients`), then open
 * the existing 1:1 or a draft thread.
 */

import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, Text, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Avatar } from "@/components/common/Avatar";
import { SearchBar } from "@/components/search/SearchBar";
import { openDirectThreadWithFeedback } from "@/components/messages/messagesNavigation";
import { isAbortError, searchRecipients } from "@/services/messagesApi";
import { MIN_QUERY_LENGTH, SEARCH_DEBOUNCE_MS } from "@/hooks/useMessageSearch";
import { spacing, typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { userDisplayName } from "@/components/messages/userDisplayName";
import { applyMessagesError, describeMessagesError } from "@/utils/messagesErrors";
import { haptic } from "@/utils/haptics";
import type { MessageUser } from "@/types/messages";

export default function NewMessageScreen() {
  const { colors } = useTheme();
  const styles = useStyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MessageUser[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const trimmed = query.trim().replace(/^@/, "");

  useEffect(() => {
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setIsLoading(false);
      setErrorMessage(null);
      return;
    }
    const controller = new AbortController();
    setIsLoading(true);
    const timer = setTimeout(() => {
      searchRecipients(trimmed, {}, { signal: controller.signal })
        .then((page) => {
          setResults(page.items);
          setErrorMessage(null);
        })
        .catch((error: unknown) => {
          if (isAbortError(error)) return;
          setErrorMessage(describeMessagesError(applyMessagesError(error) ?? "unknown"));
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed]);

  const handleSelect = (user: MessageUser) => {
    haptic.selection();
    void openDirectThreadWithFeedback(router, user, {
      shouldReplace: true,
      onRefused: (message) => Alert.alert("Can't message", message),
    });
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <SearchBar
          value={query}
          onChangeText={setQuery}
          onCancel={() => router.back()}
          placeholder="Who do you want to message?"
          autoFocus
        />
      </View>
      {isLoading && results.length === 0 ? (
        <ActivityIndicator style={styles.spinner} color={colors.text.secondary} />
      ) : null}
      {errorMessage ? <Text style={styles.message}>{errorMessage}</Text> : null}
      <FlatList
        data={results}
        keyExtractor={(user) => String(user.fid)}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => handleSelect(item)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`Message ${userDisplayName(item)}`}
            testID={`recipient-${item.fid}`}
          >
            <Avatar pfpUrl={item.pfp_url} displayName={item.display_name} size="md" />
            <View style={styles.names}>
              <Text style={styles.name} numberOfLines={1}>
                {userDisplayName(item)}
              </Text>
              {item.username ? (
                <Text style={styles.username} numberOfLines={1}>
                  @{item.username}
                </Text>
              ) : null}
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          !isLoading && trimmed.length >= MIN_QUERY_LENGTH && !errorMessage ? (
            <Text style={styles.message}>No one found for "{trimmed}"</Text>
          ) : null
        }
      />
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: { flex: 1, backgroundColor: colors.background.main },
    header: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
    spinner: { marginTop: spacing.xl },
    message: {
      textAlign: "center",
      color: colors.text.secondary,
      fontSize: typography.size.md,
      marginTop: spacing.xl,
      paddingHorizontal: spacing["2xl"],
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    pressed: { backgroundColor: colors.background.surface },
    names: { flex: 1 },
    name: {
      fontSize: typography.size.lg,
      fontWeight: typography.weight.semibold,
      color: colors.text.primary,
    },
    username: { fontSize: typography.size.body, color: colors.text.secondary },
  }));
