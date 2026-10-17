/**
 * Who-reacted bottom sheet: an "All" tab plus one tab per emoji, listing
 * reactors (avatar, name, @username). Pages through `GET /reactions`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Avatar } from "@/components/common/Avatar";
import { getReactors } from "@/services/messagesApi";
import { radii, spacing, typography, withAlpha } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { userDisplayName } from "@/components/messages/userDisplayName";
import { applyMessagesError, describeMessagesError } from "@/utils/messagesErrors";
import { formatCount } from "@/utils/format";
import type { Message, ReactorEntry } from "@/types/messages";

const ALL_REACTIONS_TAB = "__all__";
const SHEET_HEIGHT_RATIO = 0.6;

interface ReactorsSheetProps {
  conversationId: string | null;
  message: Message | null;
  initialReaction: string | null;
  onUserPress: (fid: number) => void;
  onDismiss: () => void;
}

/**
 * Reactor pages mix every reaction, so a filtered tab can be empty while
 * more pages exist. Keep fetching until it has rows, the cursor runs out,
 * or a request fails (no retry loop on errors).
 */
export function shouldAutoPageReactors({
  visibleCount,
  cursor,
  isLoading,
  hasError,
}: {
  visibleCount: number;
  cursor: string | null;
  isLoading: boolean;
  hasError: boolean;
}): boolean {
  return visibleCount === 0 && cursor !== null && !isLoading && !hasError;
}

export function ReactorsSheet({
  conversationId,
  message,
  initialReaction,
  onUserPress,
  onDismiss,
}: ReactorsSheetProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [activeTab, setActiveTab] = useState<string>(ALL_REACTIONS_TAB);
  const [entries, setEntries] = useState<ReactorEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const messageId = message?.message_id ?? null;

  const loadPage = useCallback(
    async (pageCursor: string | null, signal?: AbortSignal) => {
      if (!conversationId || !messageId) return;
      setIsLoading(true);
      try {
        const page = await getReactors(
          { conversationId, messageId, cursor: pageCursor },
          { signal },
        );
        setEntries((previous) => (pageCursor ? [...previous, ...page.items] : page.items));
        setCursor(page.next_cursor);
        setErrorText(null);
      } catch (error) {
        const code = applyMessagesError(error);
        if (code) setErrorText(describeMessagesError(code));
      } finally {
        if (!signal?.aborted) setIsLoading(false);
      }
    },
    [conversationId, messageId],
  );

  useEffect(() => {
    if (!messageId) return;
    setActiveTab(initialReaction ?? ALL_REACTIONS_TAB);
    setEntries([]);
    setCursor(null);
    const controller = new AbortController();
    void loadPage(null, controller.signal);
    return () => controller.abort();
  }, [initialReaction, loadPage, messageId]);

  const tabs = useMemo(() => {
    const summary = message?.reactions ?? [];
    const total = summary.reduce((sum, r) => sum + r.count, 0);
    return [
      { key: ALL_REACTIONS_TAB, label: `All ${formatCount(total)}` },
      ...summary.map((r) => ({
        key: r.reaction,
        label: `${r.reaction} ${formatCount(r.count)}`,
      })),
    ];
  }, [message?.reactions]);

  const visible = useMemo(
    () =>
      activeTab === ALL_REACTIONS_TAB
        ? entries
        : entries.filter((e) => e.reaction === activeTab),
    [activeTab, entries],
  );

  useEffect(() => {
    const isNeeded = shouldAutoPageReactors({
      visibleCount: visible.length,
      cursor,
      isLoading,
      hasError: errorText !== null,
    });
    if (isNeeded) void loadPage(cursor);
  }, [cursor, errorText, isLoading, loadPage, visible.length]);

  if (!message) return null;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onDismiss}>
      <Pressable
        style={[styles.backdrop, { backgroundColor: withAlpha(colors.background.main, 0.5) }]}
        onPress={onDismiss}
        accessibilityLabel="Close reactions"
        testID="reactors-backdrop"
      />
      <View
        style={[
          styles.sheet,
          { height: height * SHEET_HEIGHT_RATIO, paddingBottom: insets.bottom },
        ]}
        accessibilityViewIsModal
        testID="reactors-sheet"
      >
        <View style={styles.handle} />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabs}
          style={styles.tabsScroll}
        >
          {tabs.map((tab) => {
            const isActive = tab.key === activeTab;
            return (
              <Pressable
                key={tab.key}
                onPress={() => setActiveTab(tab.key)}
                style={[styles.tab, isActive && styles.tabActive]}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive }}
                testID={`reactors-tab-${tab.key}`}
              >
                <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
                  {tab.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
        <FlatList
          data={visible}
          keyExtractor={(entry) => `${entry.user.fid}:${entry.reaction}`}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => onUserPress(item.user.fid)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              accessibilityRole="button"
              accessibilityLabel={`${item.user.display_name}, reacted ${item.reaction}`}
              testID={`reactor-${item.user.fid}`}
            >
              <Avatar
                pfpUrl={item.user.pfp_url}
                displayName={userDisplayName(item.user)}
                size="sm"
              />
              <View style={styles.rowText}>
                <Text style={styles.name} numberOfLines={1}>
                  {userDisplayName(item.user, `fid ${item.user.fid}`)}
                </Text>
                {item.user.username ? (
                  <Text style={styles.username} numberOfLines={1}>
                    @{item.user.username}
                  </Text>
                ) : null}
              </View>
              <Text style={styles.rowEmoji}>{item.reaction}</Text>
            </Pressable>
          )}
          onEndReached={() => {
            if (cursor && !isLoading) void loadPage(cursor);
          }}
          onEndReachedThreshold={0.4}
          ListEmptyComponent={
            isLoading ? null : (
              <Text style={styles.empty}>{errorText ?? "No reactions yet."}</Text>
            )
          }
          ListFooterComponent={
            isLoading ? <ActivityIndicator style={styles.spinner} color={colors.purple} /> : null
          }
        />
      </View>
    </Modal>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors, glass }) => ({
    backdrop: { ...({ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as const) },
    sheet: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: colors.background.surface,
      borderTopLeftRadius: radii["2xl"],
      borderTopRightRadius: radii["2xl"],
      borderWidth: 1,
      borderColor: glass.borderColor,
    },
    handle: {
      alignSelf: "center",
      width: 40,
      height: 5,
      borderRadius: 3,
      marginTop: spacing.sm,
      backgroundColor: colors.background.subtle,
    },
    tabsScroll: { flexGrow: 0 },
    tabs: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm },
    tab: {
      paddingHorizontal: spacing.md,
      minHeight: 34,
      justifyContent: "center",
      borderRadius: radii.full,
      backgroundColor: colors.background.main,
    },
    tabActive: { backgroundColor: withAlpha(colors.purple, 0.22) },
    tabLabel: {
      fontSize: typography.size.body,
      color: colors.text.secondary,
      fontWeight: typography.weight.semibold,
    },
    tabLabelActive: { color: colors.text.primary },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      minHeight: 56,
    },
    rowPressed: { backgroundColor: colors.background.border },
    rowText: { flex: 1 },
    name: {
      fontSize: typography.size.md,
      fontWeight: typography.weight.semibold,
      color: colors.text.primary,
    },
    username: { fontSize: typography.size.body2, color: colors.text.secondary },
    rowEmoji: { fontSize: 20 },
    empty: {
      textAlign: "center",
      color: colors.text.secondary,
      marginTop: spacing["3xl"],
      fontSize: typography.size.body,
    },
    spinner: { marginVertical: spacing.lg },
  }));
