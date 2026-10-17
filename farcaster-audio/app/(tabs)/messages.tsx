/**
 * Messages tab: inbox with Chats / Requests segments, pull-to-refresh,
 * pagination, swipe to toggle unread, gated on a usable signer.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, Text, View } from "react-native";
import { haptic } from "@/utils/haptics";
import { useNavigation, useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { TAB_BAR_CONTENT_INSET } from "@/components/navigation/GlassTabBar";
import { TabStrip, type TabStripItem } from "@/components/search/TabStrip";
import { ConversationRow } from "@/components/messages/ConversationRow";
import { InboxSkeleton } from "@/components/messages/MessagesSkeleton";
import { SignerGate } from "@/components/messages/SignerGate";
import { useInbox, type RequestDecision } from "@/hooks/useInbox";
import { useMessagingAccess } from "@/hooks/useMessagingAccess";
import { useAuthStore } from "@/stores/authStore";
import { useMessageStore, type InboxSegment } from "@/stores/messageStore";
import { radii, spacing, touchTarget, typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { ON_ACCENT } from "@/components/messages/bubbleColors";
import { describeMessagesError } from "@/utils/messagesErrors";
import { MessagesApiError, type MessagesErrorCode } from "@/services/messagesApi";
import type { Conversation } from "@/types/messages";

export default function MessagesScreen() {
  return (
    <SignerGate>
      <Inbox />
    </SignerGate>
  );
}

function Inbox() {
  const { colors } = useTheme();
  const styles = useStyles();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const viewerFid = useAuthStore((s) => s.user?.fid) ?? 0;
  const requestsCount = useMessageStore((s) => s.requestsCount);
  const hasUnreadRequests = useMessageStore((s) => s.hasUnreadRequests);
  const { state } = useMessagingAccess();
  const [segment, setSegment] = useState<InboxSegment>("default");
  const listRef = useRef<FlatList<Conversation>>(null);

  const {
    conversations,
    isLoading,
    isRefreshing,
    isLoadingMore,
    hasMore,
    hasLoaded,
    errorCode,
    refresh,
    loadMore,
    toggleUnread,
    respondToRequest,
    respondingId,
  } = useInbox({ segment, isEnabled: state === "ready", isFocused });

  // Tapping the focused tab again scrolls to top and refreshes.
  useEffect(() => {
    const tabNavigation = navigation as typeof navigation & {
      addListener(type: "tabPress", listener: () => void): () => void;
    };
    return tabNavigation.addListener("tabPress", () => {
      if (!isFocused) return;
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
      void refresh();
    });
  }, [isFocused, navigation, refresh]);

  const handleOpen = useCallback(
    (conversation: Conversation) => {
      router.push({
        pathname: "/messages/[conversationId]",
        params: { conversationId: conversation.conversation_id },
      });
    },
    [router],
  );

  const handleToggleUnread = useCallback(
    (conversation: Conversation) => {
      toggleUnread(conversation).catch((error: unknown) => {
        const code = error instanceof MessagesApiError ? error.code : "unknown";
        Alert.alert("Couldn't update", describeMessagesError(code));
      });
    },
    [toggleUnread],
  );

  const handleRespond = useCallback(
    (conversation: Conversation, decision: RequestDecision) => {
      haptic.selection();
      respondToRequest(conversation, decision).catch((error: unknown) => {
        const code = error instanceof MessagesApiError ? error.code : "unknown";
        Alert.alert("Couldn't update request", describeMessagesError(code));
      });
    },
    [respondToRequest],
  );
  const handleAccept = useCallback(
    (conversation: Conversation) => handleRespond(conversation, "accept"),
    [handleRespond],
  );
  const handleDecline = useCallback(
    (conversation: Conversation) => handleRespond(conversation, "decline"),
    [handleRespond],
  );
  const isRequestSegment = segment === "request";

  const handleEndReached = useCallback(() => {
    if (hasMore && !isLoadingMore) void loadMore();
  }, [hasMore, isLoadingMore, loadMore]);
  const handleRetry = useCallback(() => void refresh(), [refresh]);
  const handleCompose = useCallback(() => router.push("/messages/new"), [router]);

  const tabs: TabStripItem<InboxSegment>[] = [
    { key: "default", label: "Chats" },
    {
      key: "request",
      label: requestsCount > 0 ? `Requests (${requestsCount})` : "Requests",
    },
  ];

  const renderItem = useCallback(
    ({ item }: { item: Conversation }) => (
      <ConversationRow
        conversation={item}
        viewerFid={viewerFid}
        onPress={handleOpen}
        onToggleUnread={handleToggleUnread}
        onAccept={isRequestSegment ? handleAccept : undefined}
        onDecline={isRequestSegment ? handleDecline : undefined}
        isResponding={respondingId === item.conversation_id}
      />
    ),
    [
      handleAccept,
      handleDecline,
      handleOpen,
      handleToggleUnread,
      isRequestSegment,
      respondingId,
      viewerFid,
    ],
  );

  const isEmpty = conversations.length === 0;
  const showSpinner = isEmpty && (isLoading || !hasLoaded) && !errorCode;

  return (
    <View style={styles.container}>
      <View style={styles.tabs}>
        <TabStrip tabs={tabs} activeKey={segment} onChange={setSegment} />
        {hasUnreadRequests && segment !== "request" ? (
          <View style={styles.requestsDot} testID="requests-unread-dot" />
        ) : null}
      </View>
      {showSpinner ? (
        <InboxSkeleton />
      ) : (
        <FlatList
          ref={listRef}
          data={conversations}
          keyExtractor={(item) => item.conversation_id}
          renderItem={renderItem}
          onRefresh={refresh}
          refreshing={isRefreshing}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.4}
          initialNumToRender={12}
          windowSize={9}
          ItemSeparatorComponent={InboxSeparator}
          ListFooterComponent={
            isLoadingMore ? (
              <ActivityIndicator style={styles.footer} color={colors.text.secondary} />
            ) : null
          }
          ListEmptyComponent={
            <InboxEmpty
              segment={segment}
              errorCode={errorCode}
              onRetry={handleRetry}
              onCompose={handleCompose}
            />
          }
          contentContainerStyle={[
            isEmpty && styles.emptyContainer,
            { paddingBottom: insets.bottom + TAB_BAR_CONTENT_INSET },
          ]}
          testID="inbox-list"
        />
      )}
    </View>
  );
}

function InboxSeparator() {
  const styles = useStyles();
  return <View style={styles.separator} />;
}

function InboxEmpty({
  segment,
  errorCode,
  onRetry,
  onCompose,
}: {
  segment: InboxSegment;
  errorCode: MessagesErrorCode | null;
  onRetry: () => void;
  onCompose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  if (errorCode) {
    return (
      <View style={styles.centered} testID="inbox-error">
        <Text style={styles.emptyTitle}>Couldn't load messages</Text>
        <Text style={styles.emptyBody}>{describeMessagesError(errorCode)}</Text>
        <Pressable onPress={onRetry} style={styles.cta} accessibilityRole="button">
          <Text style={styles.ctaLabel}>Try again</Text>
        </Pressable>
      </View>
    );
  }
  if (segment === "request") {
    return (
      <View style={styles.centered} testID="inbox-empty-requests">
        <Ionicons name="mail-outline" size={40} color={colors.text.secondary} />
        <Text style={styles.emptyTitle}>No message requests</Text>
        <Text style={styles.emptyBody}>
          Messages from people you don't follow land here first.
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.centered} testID="inbox-empty">
      <Ionicons name="chatbubbles-outline" size={44} color={colors.purple} />
      <Text style={styles.emptyTitle}>No conversations yet</Text>
      <Text style={styles.emptyBody}>Say hi to someone from your feed.</Text>
      <Pressable onPress={onCompose} style={styles.cta} accessibilityRole="button">
        <Text style={styles.ctaLabel}>New message</Text>
      </Pressable>
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: { flex: 1, backgroundColor: colors.background.main },
    tabs: { position: "relative" },
    requestsDot: {
      position: "absolute",
      top: spacing.md,
      right: "22%",
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.purple,
    },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.sm,
      paddingHorizontal: spacing["3xl"],
    },
    emptyContainer: { flexGrow: 1 },
    separator: {
      height: 1,
      marginLeft: spacing.lg + 48 + spacing.md,
      backgroundColor: colors.background.border,
    },
    footer: { paddingVertical: spacing.lg },
    emptyTitle: {
      fontSize: typography.size.xl,
      fontWeight: typography.weight.bold,
      color: colors.text.primary,
      textAlign: "center",
      marginTop: spacing.sm,
    },
    emptyBody: {
      fontSize: typography.size.md,
      color: colors.text.secondary,
      textAlign: "center",
    },
    cta: {
      marginTop: spacing.md,
      minHeight: touchTarget.min,
      paddingHorizontal: spacing.xl,
      borderRadius: radii.full,
      backgroundColor: colors.purple,
      alignItems: "center",
      justifyContent: "center",
    },
    ctaLabel: {
      color: ON_ACCENT,
      fontSize: typography.size.md,
      fontWeight: typography.weight.semibold,
    },
  }));
