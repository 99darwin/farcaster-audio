/**
 * Inverted, windowed thread list (index 0 = newest, rendered at the bottom).
 * Owns scroll position: exposes `scrollToMessage` for quote / search jumps
 * and `scrollToLatest`, and shows the scroll-to-bottom FAB with a count of
 * messages that arrived while the reader was scrolled up. A detached window
 * (after a jump) pages forward as the reader nears the bottom. The scroll
 * offset is reported so the screen can restore it on return.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  View,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { DateSeparator } from "@/components/messages/DateSeparator";
import {
  MessageBubble,
  type MessageBubbleProps,
} from "@/components/messages/MessageBubble";
import { ScrollToBottomFab } from "@/components/messages/ScrollToBottomFab";
import { SwipeToReply } from "@/components/messages/SwipeToReply";
import { UnreadSeparator } from "@/components/messages/UnreadSeparator";
import {
  buildMessageRows,
  findRowIndex,
  type MessageListRow,
} from "@/components/messages/messageListItems";
import { spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import type { HighlightRange, Message } from "@/types/messages";

/** Scrolled further than this from the newest message shows the FAB. */
const FAB_SHOW_OFFSET = 240;
const SCROLL_RETRY_DELAY_MS = 60;
const AUTOSCROLL_THRESHOLD = 80;
const MAX_SCROLL_RETRIES = 6;
/** Distance from the newest edge (in visible lengths) that pages forward. */
const START_REACHED_THRESHOLD = 0.5;
const EMPTY_RANGES: Readonly<Record<string, readonly HighlightRange[]>> = {};

export interface MessageListHandle {
  /** Resolves false when the row isn't in the loaded window. */
  scrollToMessage: (messageId: string) => boolean;
  scrollToLatest: () => void;
}

type BubbleCallbacks = Pick<
  MessageBubbleProps,
  | "onLongPress"
  | "onDoubleTap"
  | "onQuotePress"
  | "onReactionChipPress"
  | "onRetry"
  | "onReply"
  | "onSenderPress"
  | "onMentionPress"
>;

interface MessageListProps extends BubbleCallbacks {
  messages: Message[];
  viewerFid: number;
  isGroup: boolean;
  hasOlder: boolean;
  isLoadingOlder: boolean;
  /** The window doesn't reach the newest message (jump / search seed). */
  isDetached: boolean;
  isLoadingNewer?: boolean;
  /** `Conversation.peer_last_read_at`: 0 = never, null = group / unknown. */
  peerLastReadAt?: number | null;
  highlightedMessageId: string | null;
  highlightTerms?: string[];
  /** Exact search ranges per message id (in-thread search hits). */
  highlightRangesById?: Readonly<Record<string, readonly HighlightRange[]>>;
  /** Oldest unread message on open; "New messages" renders above it. */
  unreadSeparatorId?: string | null;
  /** Restored once on mount (inverted: 0 = newest). */
  initialScrollOffset?: number;
  canReply: boolean;
  onLoadOlder: () => void;
  onLoadNewer?: () => void;
  onJumpToLatest: () => void;
  onScrollOffsetChange?: (offset: number) => void;
  /** The reader started dragging (never fired for programmatic scrolls). */
  onUserScroll?: () => void;
}

/**
 * The newest own message, if the other party has read it: seen iff
 * `peer_last_read_at >= sent_at` (§4.5). Groups (null) and "never" (0)
 * show nothing.
 */
export function findSeenMessageId(
  messages: Message[],
  viewerFid: number,
  peerLastReadAt: number | null | undefined,
): string | null {
  if (!peerLastReadAt) return null;
  const newestOwn = messages.find((m) => m.sender.fid === viewerFid && !m.send_state);
  if (!newestOwn) return null;
  return peerLastReadAt >= newestOwn.sent_at ? newestOwn.message_id : null;
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(
  function MessageList(
    {
      messages,
      viewerFid,
      isGroup,
      hasOlder,
      isLoadingOlder,
      isDetached,
      isLoadingNewer = false,
      peerLastReadAt = null,
      highlightedMessageId,
      highlightTerms,
      highlightRangesById = EMPTY_RANGES,
      unreadSeparatorId = null,
      initialScrollOffset = 0,
      canReply,
      onLoadOlder,
      onLoadNewer,
      onJumpToLatest,
      onScrollOffsetChange,
      onUserScroll,
      onLongPress,
      onDoubleTap,
      onQuotePress,
      onReactionChipPress,
      onRetry,
      onReply,
      onSenderPress,
      onMentionPress,
    },
    ref,
  ) {
    const { colors } = useTheme();
    const listRef = useRef<FlatList<MessageListRow>>(null);
    const rows = useMemo(
      () => buildMessageRows(messages, unreadSeparatorId),
      [messages, unreadSeparatorId],
    );
    const rowsRef = useRef(rows);
    rowsRef.current = rows;
    const seenMessageId = useMemo(
      () => findSeenMessageId(messages, viewerFid, peerLastReadAt),
      [messages, peerLastReadAt, viewerFid],
    );

    const [isScrolledUp, setIsScrolledUp] = useState(false);
    const isScrolledUpRef = useRef(false);
    const [unseenCount, setUnseenCount] = useState(0);
    const newestIdRef = useRef<string | null>(messages[0]?.message_id ?? null);

    // Count incoming messages that land while the reader is scrolled up.
    useEffect(() => {
      const previousNewest = newestIdRef.current;
      newestIdRef.current = messages[0]?.message_id ?? null;
      if (!previousNewest || !isScrolledUpRef.current) return;
      const previousIndex = messages.findIndex((m) => m.message_id === previousNewest);
      if (previousIndex <= 0) return;
      const arrived = messages
        .slice(0, previousIndex)
        .filter((m) => m.sender.fid !== viewerFid).length;
      if (arrived > 0) setUnseenCount((count) => count + arrived);
    }, [messages, viewerFid]);

    const scrollToLatest = useCallback(() => {
      setUnseenCount(0);
      if (isDetached) {
        onJumpToLatest();
        return;
      }
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    }, [isDetached, onJumpToLatest]);

    const scrollToMessage = useCallback((messageId: string) => {
      const index = findRowIndex(rowsRef.current, messageId);
      if (index < 0) return false;
      listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
      return true;
    }, []);

    useImperativeHandle(ref, () => ({ scrollToMessage, scrollToLatest }), [
      scrollToLatest,
      scrollToMessage,
    ]);

    const retriesRef = useRef(0);
    const handleScrollToIndexFailed = useCallback(
      (info: { index: number; averageItemLength: number }) => {
        // Row not measured yet: scroll near it so it renders, then retry.
        listRef.current?.scrollToOffset({
          offset: info.averageItemLength * info.index,
          animated: false,
        });
        if (retriesRef.current >= MAX_SCROLL_RETRIES) {
          retriesRef.current = 0;
          return;
        }
        retriesRef.current += 1;
        setTimeout(() => {
          if (info.index >= rowsRef.current.length) return;
          listRef.current?.scrollToIndex({
            index: info.index,
            animated: true,
            viewPosition: 0.5,
          });
        }, SCROLL_RETRY_DELAY_MS);
      },
      [],
    );

    const scrollOffsetRef = useRef(initialScrollOffset);
    const onScrollOffsetChangeRef = useRef(onScrollOffsetChange);
    onScrollOffsetChangeRef.current = onScrollOffsetChange;
    // Report the last offset once, on unmount, instead of on every frame.
    useEffect(
      () => () => onScrollOffsetChangeRef.current?.(scrollOffsetRef.current),
      [],
    );

    const hasRestoredRef = useRef(initialScrollOffset <= 0);
    const handleContentSizeChange = useCallback(() => {
      if (hasRestoredRef.current) return;
      hasRestoredRef.current = true;
      listRef.current?.scrollToOffset({ offset: initialScrollOffset, animated: false });
    }, [initialScrollOffset]);

    const handleScroll = useCallback(
      (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
        const isUp = event.nativeEvent.contentOffset.y > FAB_SHOW_OFFSET;
        if (isUp === isScrolledUpRef.current) return;
        isScrolledUpRef.current = isUp;
        setIsScrolledUp(isUp);
        if (!isUp) setUnseenCount(0);
      },
      [],
    );

    const handleEndReached = useCallback(() => {
      if (!hasOlder || isLoadingOlder) return;
      onLoadOlder();
    }, [hasOlder, isLoadingOlder, onLoadOlder]);

    // Inverted list: the "start" is the newest edge (bottom of the screen).
    const handleStartReached = useCallback(() => {
      if (!isDetached || isLoadingNewer) return;
      onLoadNewer?.();
    }, [isDetached, isLoadingNewer, onLoadNewer]);

    const renderItem = useCallback(
      ({ item }: ListRenderItemInfo<MessageListRow>) => {
        if (item.kind === "day") return <DateSeparator timestamp={item.timestamp} />;
        if (item.kind === "unread") return <UnreadSeparator />;
        const { message } = item;
        const isOwn = message.sender.fid === viewerFid;
        const isReplyable =
          canReply && message.type === "text" && !message.is_deleted && !message.send_state;
        return (
          <SwipeToReply isEnabled={isReplyable} message={message} onReply={onReply}>
            <MessageBubble
              message={message}
              isOwn={isOwn}
              isGroup={isGroup}
              isRunStart={item.isRunStart}
              isRunEnd={item.isRunEnd}
              isHighlighted={message.message_id === highlightedMessageId}
              isSeen={message.message_id === seenMessageId}
              highlightTerms={highlightTerms}
              highlightRanges={highlightRangesById[message.message_id]}
              onLongPress={onLongPress}
              onDoubleTap={onDoubleTap}
              onQuotePress={onQuotePress}
              onReactionChipPress={onReactionChipPress}
              onRetry={onRetry}
              onReply={onReply}
              onSenderPress={onSenderPress}
              onMentionPress={onMentionPress}
            />
          </SwipeToReply>
        );
      },
      [
        canReply,
        highlightRangesById,
        highlightTerms,
        highlightedMessageId,
        isGroup,
        onDoubleTap,
        onLongPress,
        onMentionPress,
        onQuotePress,
        onReactionChipPress,
        onReply,
        onRetry,
        onSenderPress,
        seenMessageId,
        viewerFid,
      ],
    );

    return (
      <View style={{ flex: 1 }}>
        <FlatList
          ref={listRef}
          data={rows}
          inverted
          keyExtractor={(row) => row.key}
          renderItem={renderItem}
          extraData={highlightedMessageId}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.5}
          onStartReached={handleStartReached}
          onStartReachedThreshold={START_REACHED_THRESHOLD}
          onContentSizeChange={handleContentSizeChange}
          onScroll={handleScroll}
          onScrollBeginDrag={onUserScroll}
          scrollEventThrottle={32}
          onScrollToIndexFailed={handleScrollToIndexFailed}
          initialNumToRender={18}
          maxToRenderPerBatch={12}
          updateCellsBatchingPeriod={40}
          windowSize={11}
          // Clipping detached rows breaks measureInWindow for the overlay on
          // Android and causes blank flashes on fast inverted scrolls.
          removeClippedSubviews={false}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          // New rows land at index 0: stay put while reading history, but
          // follow along when already at the newest message.
          maintainVisibleContentPosition={
            Platform.OS === "web"
              ? undefined
              : { minIndexForVisible: 0, autoscrollToTopThreshold: AUTOSCROLL_THRESHOLD }
          }
          contentContainerStyle={{ paddingVertical: spacing.sm }}
          ListHeaderComponent={
            isLoadingNewer ? (
              <ActivityIndicator
                style={{ marginVertical: spacing.lg }}
                color={colors.text.secondary}
              />
            ) : null
          }
          ListFooterComponent={
            isLoadingOlder ? (
              <ActivityIndicator
                style={{ marginVertical: spacing.lg }}
                color={colors.text.secondary}
              />
            ) : null
          }
          testID="message-list"
        />
        <ScrollToBottomFab
          isVisible={isScrolledUp || isDetached}
          unreadCount={unseenCount}
          onPress={scrollToLatest}
        />
      </View>
    );
  },
);
