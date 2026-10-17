/**
 * Global message search: debounced query, highlighted hits with context,
 * tap to jump into the thread anchored on the hit.
 */

import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Text, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SearchBar } from "@/components/search/SearchBar";
import { SearchResultRow } from "@/components/messages/SearchResultRow";
import { threadHref } from "@/components/messages/messagesNavigation";
import { MIN_QUERY_LENGTH, useMessageSearch } from "@/hooks/useMessageSearch";
import { useMessagingAccess } from "@/hooks/useMessagingAccess";
import { useMessageStore } from "@/stores/messageStore";
import { spacing, typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { describeMessagesError } from "@/utils/messagesErrors";
import type { MessageSearchHit } from "@/types/messages";

export default function MessageSearchScreen() {
  const { colors } = useTheme();
  const styles = useStyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state } = useMessagingAccess();
  const [query, setQuery] = useState("");
  const { hits, isLoading, isLoadingMore, hasMore, errorCode, loadMore } =
    useMessageSearch({ query, isEnabled: state === "ready" });
  const trimmed = query.trim();

  const handlePress = useCallback(
    (hit: MessageSearchHit) => {
      // The thread seeds its window from the hit (context + cursors) instead
      // of refetching around the anchor.
      useMessageStore.getState().stashSearchSeed(hit);
      router.push(
        threadHref({
          conversationId: hit.conversation.conversation_id,
          anchorMessageId: hit.message.message_id,
        }),
      );
    },
    [router],
  );

  const renderEmpty = () => {
    if (isLoading) return null;
    if (errorCode) return <Text style={styles.message}>{describeMessagesError(errorCode)}</Text>;
    if (trimmed.length < MIN_QUERY_LENGTH) {
      return <Text style={styles.message}>Search across all your conversations.</Text>;
    }
    return <Text style={styles.message}>No messages match "{trimmed}"</Text>;
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <SearchBar
          value={query}
          onChangeText={setQuery}
          onCancel={() => router.back()}
          placeholder="Search messages"
          autoFocus
        />
      </View>
      {isLoading ? (
        <ActivityIndicator style={styles.spinner} color={colors.text.secondary} />
      ) : null}
      <FlatList
        data={hits}
        keyExtractor={(hit) => hit.message.message_id}
        renderItem={({ item }) => (
          <SearchResultRow hit={item} query={trimmed} onPress={handlePress} />
        )}
        onEndReached={() => {
          if (hasMore) void loadMore();
        }}
        onEndReachedThreshold={0.4}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListEmptyComponent={renderEmpty()}
        ListFooterComponent={
          isLoadingMore ? (
            <ActivityIndicator style={styles.spinner} color={colors.text.secondary} />
          ) : null
        }
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
        testID="message-search-results"
      />
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: { flex: 1, backgroundColor: colors.background.main },
    header: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
    spinner: { marginVertical: spacing.lg },
    message: {
      textAlign: "center",
      color: colors.text.secondary,
      fontSize: typography.size.md,
      marginTop: spacing.xl,
      paddingHorizontal: spacing["2xl"],
    },
  }));
