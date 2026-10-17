/**
 * Conversation thread. Wires the windowed message list, composer, reaction
 * overlay, reactors sheet and in-thread search to the messaging hooks.
 *
 * Routes:
 *   /messages/<id>                      existing conversation
 *   /messages/<id>?anchorMessageId=<m>  open scrolled to (and flashing) m
 *   /messages/draft?recipientFid=...    first DM; swaps to the real id on send
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { Ionicons } from "@expo/vector-icons";
import { Avatar } from "@/components/common/Avatar";
import { Composer, type ComposerHandle, type ComposerSubmit } from "@/components/messages/Composer";
import {
  conversationAvatar,
  conversationTitle,
} from "@/components/messages/ConversationRow";
import { MessageActionsOverlay, DOUBLE_TAP_REACTION } from "@/components/messages/MessageActionsOverlay";
import type { BubbleRect } from "@/components/messages/MessageBubble";
import { MessageList, type MessageListHandle } from "@/components/messages/MessageList";
import {
  ThreadHeaderSkeleton,
  ThreadSkeleton,
} from "@/components/messages/MessagesSkeleton";
import { ReactorsSheet } from "@/components/messages/ReactorsSheet";
import { SignerGate } from "@/components/messages/SignerGate";
import { ThreadSearchBar } from "@/components/messages/ThreadSearchBar";
import {
  resolveActiveHitId,
  sortHitsByTime,
  threadSearchTerms,
} from "@/components/messages/threadSearch";
import {
  DRAFT_CONVERSATION_ROUTE,
  threadHref,
  type ThreadRouteParams,
} from "@/components/messages/messagesNavigation";
import { useConversation } from "@/hooks/useConversation";
import { useDraftRecipient } from "@/hooks/useDraftRecipient";
import { parseFid } from "@/utils/farcasterIds";
import { useMessageReactions } from "@/hooks/useMessageReactions";
import { useMessageSearch } from "@/hooks/useMessageSearch";
import { useMessagingAccess } from "@/hooks/useMessagingAccess";
import { useSendMessage } from "@/hooks/useSendMessage";
import { composerDraftKey } from "@/services/composerDrafts";
import { deleteMessage, markConversationUnread } from "@/services/messagesApi";
import { useAuthStore } from "@/stores/authStore";
import { draftThreadKey, useMessageStore } from "@/stores/messageStore";
import { spacing, touchTarget, typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { userDisplayName } from "@/components/messages/userDisplayName";
import { describeMessagesError, describeMessagesFailure } from "@/utils/messagesErrors";
import { haptic } from "@/utils/haptics";
import {
  MAX_MESSAGE_LENGTH,
  type HighlightRange,
  type Message,
  type MessageSearchHit,
  type MessageUser,
} from "@/types/messages";

/** How long a jumped-to bubble stays highlighted. */
export const JUMP_HIGHLIGHT_MS = 1_200;
/** Let the list render a freshly loaded anchor window before scrolling. */
const ANCHOR_SCROLL_DELAY_MS = 80;
/** Prefetch the next search page when this close to the oldest loaded hit. */
const SEARCH_PREFETCH_DISTANCE = 2;
/**
 * iOS needs padding; Android already resizes the window for the keyboard
 * (softwareKeyboardLayoutMode "resize"), so a second adjustment would double
 * the gap. Web has no on-screen keyboard to avoid.
 */
const KEYBOARD_BEHAVIOR = Platform.OS === "ios" ? "padding" : undefined;

export default function ThreadScreen() {
  const params = useLocalSearchParams<ThreadRouteParams>();
  const isDraft = params.conversationId === DRAFT_CONVERSATION_ROUTE;
  const draftRecipientFid = isDraft ? parseFid(params.recipientFid) : null;
  const conversationId = isDraft ? null : params.conversationId ?? null;
  const threadKey = isDraft
    ? draftThreadKey(draftRecipientFid ?? 0)
    : (conversationId ?? "");

  return (
    <Thread
      key={threadKey}
      conversationId={conversationId}
      threadKey={threadKey}
      draftRecipientFid={draftRecipientFid}
      anchorMessageId={params.anchorMessageId ?? null}
    />
  );
}

interface ThreadProps {
  conversationId: string | null;
  threadKey: string;
  draftRecipientFid: number | null;
  anchorMessageId: string | null;
}

function Thread({ conversationId, threadKey, draftRecipientFid, anchorMessageId }: ThreadProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const { recipient: draftRecipient, isLoading: isDraftRecipientLoading } =
    useDraftRecipient(draftRecipientFid);
  const authUser = useAuthStore((s) => s.user);
  const { state: accessState } = useMessagingAccess();
  const isReady = accessState === "ready";
  const viewerFid = authUser?.fid ?? 0;
  const viewer = useMemo<MessageUser | null>(
    () =>
      authUser
        ? {
            fid: authUser.fid,
            username: authUser.username ?? null,
            display_name: authUser.display_name || authUser.username || "",
            pfp_url: authUser.pfp_url ?? null,
          }
        : null,
    [authUser],
  );

  const {
    conversation,
    thread,
    isLoading,
    isLoadingOlder,
    isLoadingNewer,
    errorCode,
    unreadSeparatorId,
    loadOlder,
    loadNewer,
    ensureMessageLoaded,
    jumpToLatest,
  } = useConversation({
    conversationId,
    threadKey,
    viewerFid,
    isEnabled: isReady,
    isFocused,
    anchorMessageId,
  });
  // Restore where the reader left this thread, unless arriving at a target.
  const [initialScrollOffset] = useState(() =>
    anchorMessageId ? 0 : (useMessageStore.getState().scrollOffsets[threadKey] ?? 0),
  );
  const handleScrollOffsetChange = useCallback(
    (offset: number) => useMessageStore.getState().setScrollOffset(threadKey, offset),
    [threadKey],
  );

  const handleConversationCreated = useCallback(
    (id: string) => router.replace(threadHref({ conversationId: id })),
    [router],
  );
  const { send, retry, discard } = useSendMessage({
    threadKey,
    conversationId,
    recipientFid: draftRecipientFid,
    viewer,
    onConversationCreated: handleConversationCreated,
  });
  const { toggleReaction } = useMessageReactions(conversationId);

  const listRef = useRef<MessageListHandle>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const replyTarget = useMessageStore((s) => s.replyTargets[threadKey] ?? null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [actionTarget, setActionTarget] = useState<{ message: Message; rect: BubbleRect } | null>(null);
  const [reactorsTarget, setReactorsTarget] = useState<{ message: Message; reaction: string } | null>(null);

  useEffect(
    () => () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    },
    [],
  );

  const flashMessage = useCallback((messageId: string) => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedId(messageId);
    highlightTimerRef.current = setTimeout(() => setHighlightedId(null), JUMP_HIGHLIGHT_MS);
  }, []);

  /**
   * Scroll to a message, loading a window around it if needed. A search hit
   * seeds that window directly from its context (no extra request).
   */
  const jumpToMessage = useCallback(
    async (messageId: string, hit?: MessageSearchHit | null) => {
      if (listRef.current?.scrollToMessage(messageId)) {
        flashMessage(messageId);
        return;
      }
      const isFound = await ensureMessageLoaded(messageId, hit);
      if (!isFound) {
        Alert.alert("Message unavailable", "That message couldn't be found.");
        return;
      }
      setTimeout(() => {
        if (listRef.current?.scrollToMessage(messageId)) flashMessage(messageId);
      }, ANCHOR_SCROLL_DELAY_MS);
    },
    [ensureMessageLoaded, flashMessage],
  );

  // Arrived from search: jump once the first page is in.
  const hasJumpedToAnchorRef = useRef(false);
  useEffect(() => {
    if (!anchorMessageId || !thread.isLoaded || hasJumpedToAnchorRef.current) return;
    hasJumpedToAnchorRef.current = true;
    void jumpToMessage(anchorMessageId);
  }, [anchorMessageId, jumpToMessage, thread.isLoaded]);

  // ---- In-thread search ----------------------------------------------------
  const [isSearching, setIsSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // The active hit is tracked by id: loading another page re-sorts the
  // list, and an index would silently point at a different message.
  const [activeHitId, setActiveHitId] = useState<string | null>(null);
  const search = useMessageSearch({
    query: searchQuery,
    isEnabled: isSearching && isReady && conversationId !== null,
    conversationId,
  });
  const searchHits = useMemo(() => sortHitsByTime(search.hits), [search.hits]);
  const searchIndex = activeHitId
    ? searchHits.findIndex((h) => h.message.message_id === activeHitId)
    : -1;
  const searchTerms = useMemo(
    () => (isSearching ? threadSearchTerms(search.hits, searchQuery) : undefined),
    [isSearching, search.hits, searchQuery],
  );
  const highlightRangesById = useMemo(() => {
    const ranges: Record<string, readonly HighlightRange[]> = {};
    if (!isSearching) return ranges;
    for (const hit of search.hits) {
      if (hit.highlight_ranges) ranges[hit.message.message_id] = hit.highlight_ranges;
    }
    return ranges;
  }, [isSearching, search.hits]);

  useEffect(() => {
    setActiveHitId((current) => resolveActiveHitId(current, searchHits));
  }, [searchHits]);

  const searchHitsRef = useRef(searchHits);
  searchHitsRef.current = searchHits;
  /** A search hit was jumped to and the reader hasn't dragged away since. */
  const isParkedOnHitRef = useRef(false);
  useEffect(() => {
    if (!activeHitId) return;
    isParkedOnHitRef.current = true;
    const hit = searchHitsRef.current.find((h) => h.message.message_id === activeHitId);
    void jumpToMessage(activeHitId, hit);
  }, [activeHitId, jumpToMessage]);
  const handleUserScroll = useCallback(() => {
    isParkedOnHitRef.current = false;
  }, []);

  const handleChangeSearchQuery = useCallback((query: string) => {
    setSearchQuery(query);
    setActiveHitId(null);
  }, []);

  const handleSearchOlder = useCallback(() => {
    const nextIndex = searchIndex + 1;
    const next = searchHits[nextIndex];
    if (next) {
      haptic.selection();
      setActiveHitId(next.message.message_id);
    }
    const isNearEnd = nextIndex >= searchHits.length - SEARCH_PREFETCH_DISTANCE;
    if (isNearEnd && search.hasMore) void search.loadMore();
  }, [search, searchHits, searchIndex]);

  const handleSearchNewer = useCallback(() => {
    const previous = searchHits[searchIndex - 1];
    if (!previous) return;
    haptic.selection();
    setActiveHitId(previous.message.message_id);
  }, [searchHits, searchIndex]);

  const handleOpenSearch = useCallback(() => setIsSearching(true), []);

  /**
   * Closing search goes back to the live tail, as if the search never
   * happened, unless the reader scrolled away from the hit to read around
   * it: then they stay where they are.
   */
  const handleCloseSearch = useCallback(() => {
    const shouldReturnToLatest = isParkedOnHitRef.current;
    isParkedOnHitRef.current = false;
    setIsSearching(false);
    setSearchQuery("");
    setActiveHitId(null);
    if (shouldReturnToLatest) listRef.current?.scrollToLatest();
  }, []);

  // ---- Message actions -----------------------------------------------------
  const setReply = useCallback(
    (message: Message | null) => useMessageStore.getState().setReplyTarget(threadKey, message),
    [threadKey],
  );

  const handleReply = useCallback(
    (message: Message) => {
      setReply(message);
      composerRef.current?.focus();
    },
    [setReply],
  );

  const handleReact = useCallback(
    async (message: Message, reaction: string) => {
      const fresh =
        useMessageStore
          .getState()
          .threads[threadKey]?.messages.find((m) => m.message_id === message.message_id) ?? message;
      const errorMessage = await toggleReaction(fresh, reaction);
      if (errorMessage) Alert.alert("Couldn't react", errorMessage);
    },
    [threadKey, toggleReaction],
  );

  const handleDoubleTap = useCallback(
    (message: Message) => void handleReact(message, DOUBLE_TAP_REACTION),
    [handleReact],
  );

  const handleCopy = useCallback(async (message: Message) => {
    await Clipboard.setStringAsync(message.text);
    haptic.success();
  }, []);

  const handleDelete = useCallback(
    (message: Message) => {
      if (message.send_state) {
        discard(message);
        return;
      }
      if (!conversationId) return;
      Alert.alert("Delete message?", "It will be removed for everyone.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            const store = useMessageStore.getState();
            store.patchMessage(conversationId, message.message_id, { is_deleted: true });
            deleteMessage(conversationId, message.message_id).catch((error: unknown) => {
              useMessageStore
                .getState()
                .patchMessage(conversationId, message.message_id, { is_deleted: false });
              const errorMessage = describeMessagesFailure(error);
              if (errorMessage) Alert.alert("Couldn't delete", errorMessage);
            });
          },
        },
      ]);
    },
    [conversationId, discard],
  );

  const handleRetry = useCallback(
    async (message: Message) => {
      const result = await retry(message);
      if (!result.isSent && result.errorMessage) Alert.alert("Not delivered", result.errorMessage);
    },
    [retry],
  );

  const handleOpenProfile = useCallback(
    (fid: number) => router.push({ pathname: "/profile/[fid]", params: { fid: String(fid) } }),
    [router],
  );

  // ---- Stable list / overlay handlers (memoised rows depend on them) ------
  const handleBack = useCallback(() => router.back(), [router]);
  const handleLoadOlder = useCallback(() => void loadOlder(), [loadOlder]);
  const handleLoadNewer = useCallback(() => void loadNewer(), [loadNewer]);
  const handleJumpToLatest = useCallback(() => void jumpToLatest(), [jumpToLatest]);
  const handleLongPress = useCallback(
    (message: Message, rect: BubbleRect) => setActionTarget({ message, rect }),
    [],
  );
  const handleQuotePress = useCallback(
    (messageId: string) => void jumpToMessage(messageId),
    [jumpToMessage],
  );
  const handleReactionChipPress = useCallback(
    (message: Message, reaction: string) => setReactorsTarget({ message, reaction }),
    [],
  );
  const handleRetryPress = useCallback(
    (message: Message) => void handleRetry(message),
    [handleRetry],
  );
  const handleCancelReply = useCallback(() => setReply(null), [setReply]);
  const handleOverlayReact = useCallback(
    (message: Message, reaction: string) => void handleReact(message, reaction),
    [handleReact],
  );
  const handleOverlayCopy = useCallback(
    (message: Message) => void handleCopy(message),
    [handleCopy],
  );
  const handleDismissActions = useCallback(() => setActionTarget(null), []);
  const handleDismissReactors = useCallback(() => setReactorsTarget(null), []);
  const handleReactorPress = useCallback(
    (fid: number) => {
      setReactorsTarget(null);
      handleOpenProfile(fid);
    },
    [handleOpenProfile],
  );

  /**
   * Mark unread and leave: staying would show the messages as read again.
   * Auto mark-read only fires for a newer incoming message, so the flag
   * sticks if the reader returns before anything new arrives.
   */
  const handleMarkUnread = useCallback(async () => {
    if (!conversationId) return;
    const store = useMessageStore.getState();
    store.patchConversation(conversationId, { manually_marked_unread: true });
    haptic.selection();
    try {
      await markConversationUnread(conversationId);
      router.back();
    } catch (error) {
      useMessageStore
        .getState()
        .patchConversation(conversationId, { manually_marked_unread: false });
      const errorMessage = describeMessagesFailure(error);
      if (errorMessage) Alert.alert("Couldn't mark unread", errorMessage);
    }
  }, [conversationId, router]);
  const handleMarkUnreadPress = useCallback(() => void handleMarkUnread(), [handleMarkUnread]);

  const handleMentionPress = useCallback(
    (username: string, message: Message) => {
      const mention = message.metadata?.mentions.find(
        (m) => m.username?.toLowerCase() === username.toLowerCase(),
      );
      if (mention) handleOpenProfile(mention.fid);
    },
    [handleOpenProfile],
  );

  const handleSubmit = useCallback(
    async ({ text, processMetadata }: ComposerSubmit) => {
      if (text.trim().length > MAX_MESSAGE_LENGTH) {
        Alert.alert("Message too long", `Messages are limited to ${MAX_MESSAGE_LENGTH} characters.`);
        return false;
      }
      const target = replyTarget;
      setReply(null);
      listRef.current?.scrollToLatest();
      // `send` inserts the optimistic row synchronously; don't hold the
      // composer for delivery, so the next message can go right away. A
      // failed send stays in the thread with a tap-to-retry affordance, so
      // the draft is always cleared.
      void send(text, target, { processMetadata });
      return true;
    },
    [replyTarget, send, setReply],
  );

  // ---- Header --------------------------------------------------------------
  const isRecipientPending = !conversation && isDraftRecipientLoading;
  const title = conversation
    ? conversationTitle(conversation)
    : userDisplayName(
        draftRecipient,
        draftRecipientFid ? `fid ${draftRecipientFid}` : "",
      );
  const avatarUrl = conversation ? conversationAvatar(conversation) : (draftRecipient?.pfp_url ?? null);
  const peerFid = conversation?.is_group ? null : (conversation?.counterparty?.fid ?? draftRecipientFid ?? null);
  const peerUsername = conversation?.counterparty?.username ?? draftRecipient?.username;
  const subtitle = conversation?.is_group
    ? `${conversation.participants.length} members`
    : peerUsername
      ? `@${peerUsername}`
      : null;
  const handleTitlePress = useCallback(() => {
    if (peerFid) handleOpenProfile(peerFid);
  }, [handleOpenProfile, peerFid]);
  const isReadOnly = conversation?.access === "read";
  const isOwnActionTarget = actionTarget?.message.sender.fid === viewerFid;

  const isEmpty = thread.messages.length === 0;
  const draftKey = composerDraftKey(viewerFid, threadKey);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        {isSearching ? (
          <ThreadSearchBar
            query={searchQuery}
            activeIndex={searchIndex}
            matchCount={searchHits.length}
            isSearching={search.isLoading}
            onChangeQuery={handleChangeSearchQuery}
            onOlder={handleSearchOlder}
            onNewer={handleSearchNewer}
            onClose={handleCloseSearch}
          />
        ) : (
          <>
            <Pressable
              onPress={handleBack}
              hitSlop={8}
              style={styles.headerButton}
              accessibilityRole="button"
              accessibilityLabel="Back"
              testID="thread-back"
            >
              <Ionicons name="chevron-back" size={26} color={colors.text.primary} />
            </Pressable>
            <Pressable
              onPress={handleTitlePress}
              disabled={!peerFid}
              style={styles.headerTitle}
              accessibilityRole="button"
              accessibilityLabel={peerFid ? `Open ${title}'s profile` : title}
            >
              {isRecipientPending ? (
                <ThreadHeaderSkeleton />
              ) : (
                <>
                  <Avatar pfpUrl={avatarUrl} displayName={title} size="sm" />
                  <View style={styles.headerNames}>
                    <Text style={styles.headerName} numberOfLines={1}>
                      {title}
                    </Text>
                    {subtitle ? (
                      <Text style={styles.headerSubtitle} numberOfLines={1}>
                        {subtitle}
                      </Text>
                    ) : null}
                  </View>
                </>
              )}
            </Pressable>
            {conversationId ? (
              <>
                <Pressable
                  onPress={handleMarkUnreadPress}
                  hitSlop={8}
                  style={styles.headerButton}
                  accessibilityRole="button"
                  accessibilityLabel="Mark as unread"
                  testID="thread-mark-unread-button"
                >
                  <Ionicons name="mail-unread-outline" size={22} color={colors.text.primary} />
                </Pressable>
                <Pressable
                  onPress={handleOpenSearch}
                  hitSlop={8}
                  style={styles.headerButton}
                  accessibilityRole="button"
                  accessibilityLabel="Search in conversation"
                  testID="thread-search-button"
                >
                  <Ionicons name="search" size={22} color={colors.text.primary} />
                </Pressable>
              </>
            ) : null}
          </>
        )}
      </View>
      <SignerGate>
        <KeyboardAvoidingView style={styles.body} behavior={KEYBOARD_BEHAVIOR}>
          {isLoading && isEmpty ? (
            <ThreadSkeleton />
          ) : errorCode && isEmpty ? (
            <View style={styles.centered}>
              <Text style={styles.emptyText}>{describeMessagesError(errorCode)}</Text>
              <Pressable onPress={handleJumpToLatest} style={styles.retry} accessibilityRole="button">
                <Text style={styles.retryLabel}>Try again</Text>
              </Pressable>
            </View>
          ) : isEmpty && isRecipientPending ? (
            <ThreadSkeleton />
          ) : isEmpty ? (
            <View style={styles.centered} testID="thread-empty">
              <Avatar pfpUrl={avatarUrl} displayName={title} size="lg" />
              <Text style={styles.emptyTitle}>{title}</Text>
              <Text style={styles.emptyText}>Send a message to start the conversation.</Text>
            </View>
          ) : (
            <MessageList
              ref={listRef}
              messages={thread.messages}
              viewerFid={viewerFid}
              isGroup={conversation?.is_group ?? false}
              hasOlder={thread.hasOlder}
              isLoadingOlder={isLoadingOlder}
              isDetached={thread.isDetached}
              isLoadingNewer={isLoadingNewer}
              peerLastReadAt={conversation?.peer_last_read_at ?? null}
              highlightedMessageId={highlightedId}
              highlightTerms={searchTerms}
              highlightRangesById={highlightRangesById}
              unreadSeparatorId={unreadSeparatorId}
              initialScrollOffset={initialScrollOffset}
              canReply={!isReadOnly}
              onLoadOlder={handleLoadOlder}
              onLoadNewer={handleLoadNewer}
              onJumpToLatest={handleJumpToLatest}
              onScrollOffsetChange={handleScrollOffsetChange}
              onUserScroll={handleUserScroll}
              onLongPress={handleLongPress}
              onDoubleTap={handleDoubleTap}
              onQuotePress={handleQuotePress}
              onReactionChipPress={handleReactionChipPress}
              onRetry={handleRetryPress}
              onReply={handleReply}
              onSenderPress={handleOpenProfile}
              onMentionPress={handleMentionPress}
            />
          )}
          <Composer
            ref={composerRef}
            replyTarget={replyTarget}
            isReadOnly={isReadOnly}
            bottomInset={insets.bottom}
            draftKey={draftKey}
            onCancelReply={handleCancelReply}
            onSubmit={handleSubmit}
          />
        </KeyboardAvoidingView>
      </SignerGate>
      <MessageActionsOverlay
        message={actionTarget?.message ?? null}
        anchor={actionTarget?.rect ?? null}
        isOwn={isOwnActionTarget}
        onReact={handleOverlayReact}
        onReply={handleReply}
        onCopy={handleOverlayCopy}
        onDelete={handleDelete}
        onDismiss={handleDismissActions}
      />
      <ReactorsSheet
        conversationId={conversationId}
        message={reactorsTarget?.message ?? null}
        initialReaction={reactorsTarget?.reaction ?? null}
        onUserPress={handleReactorPress}
        onDismiss={handleDismissReactors}
      />
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors, glass }) => ({
    container: { flex: 1, backgroundColor: colors.background.main },
    header: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: touchTarget.min + spacing.sm,
      paddingHorizontal: spacing.sm,
      gap: spacing.xs,
      borderBottomWidth: 1,
      borderBottomColor: glass.borderColor,
    },
    headerButton: {
      width: touchTarget.min,
      height: touchTarget.min,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitle: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.sm },
    headerNames: { flex: 1 },
    headerName: {
      fontSize: typography.size.lg,
      fontWeight: typography.weight.semibold,
      color: colors.text.primary,
    },
    headerSubtitle: { fontSize: typography.size.sm, color: colors.text.secondary },
    body: { flex: 1 },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.sm,
      paddingHorizontal: spacing["3xl"],
    },
    emptyTitle: {
      fontSize: typography.size.xl,
      fontWeight: typography.weight.bold,
      color: colors.text.primary,
      marginTop: spacing.sm,
    },
    emptyText: {
      fontSize: typography.size.md,
      color: colors.text.secondary,
      textAlign: "center",
    },
    retry: { minHeight: touchTarget.min, justifyContent: "center", paddingHorizontal: spacing.lg },
    retryLabel: {
      color: colors.purple,
      fontSize: typography.size.md,
      fontWeight: typography.weight.semibold,
    },
  }));
