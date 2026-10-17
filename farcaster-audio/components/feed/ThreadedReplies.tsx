/**
 * Thread replies, laid out the way X shows a conversation.
 *
 * Each top-level reply is a group: one reply path shown flat (no indentation),
 * joined avatar-to-avatar by a thread line. Where the tree branches or runs
 * past `MAX_INLINE_CHAIN`, a "Show more replies" row opens that cast's own
 * thread (see `selectReplyChain`). A deep-linked `focusHash` is always kept on
 * the inline path. Spam replies are hoisted into a dismissible footer.
 */

import { useState, useMemo } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { CastCard } from "@/components/feed/CastCard";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { withAlpha } from "@/constants/theme";
import { selectReplyChain, subtreeContainsHash } from "@/utils/replyChain";
import type {
  FarcasterCast,
  FarcasterCastWithReplies,
} from "@/types/farcaster";

export { subtreeContainsHash };

/**
 * Walks each top-level reply in `replies` (and its nested subtree) and returns
 * the index of the top-level reply whose subtree contains `hash`. Returns -1
 * if not found.
 */
export function findTopLevelIndexContaining(
  replies: FarcasterCastWithReplies[],
  hash: string,
): number {
  return replies.findIndex((reply) => subtreeContainsHash(reply, hash));
}

interface NodeHandlers {
  myFid: number;
  onLike: (hash: string, isLiked: boolean) => void;
  onRecast: (hash: string, isRecasted: boolean) => void;
  onBookmark: (hash: string, isBookmarked: boolean) => void;
  onQuoteCast: (cast: FarcasterCast) => void;
  onReply: (cast: FarcasterCast) => void;
  onBlockAuthor?: (fid: number) => Promise<void> | void;
  onCastPress: (hash: string) => void;
  focusHash?: string;
}

interface ThreadedRepliesProps extends NodeHandlers {
  replies: FarcasterCastWithReplies[];
  /** Casts shown inline per group; defaults to `MAX_INLINE_CHAIN`. */
  maxChainLength?: number;
}

function ReplyGroup({
  reply,
  focusHash,
  maxChainLength,
  onCastPress,
  ...handlers
}: NodeHandlers & { reply: FarcasterCastWithReplies; maxChainLength?: number }) {
  const styles = useStyles();
  const { chain, continueFrom } = useMemo(
    () => selectReplyChain(reply, { focusHash, maxLength: maxChainLength }),
    [reply, focusHash, maxChainLength],
  );

  return (
    <View>
      {chain.map((node, index) => (
        <View
          key={node.hash}
          style={node.hash === focusHash ? styles.focusHighlight : undefined}
          accessibilityLabel={`Thread reply, ${index + 1} of ${chain.length}`}
        >
          <CastCard
            cast={node}
            {...handlers}
            onPress={() => onCastPress(node.hash)}
            connectAbove={index > 0}
            connectBelow={index < chain.length - 1 || continueFrom !== null}
          />
        </View>
      ))}
      {continueFrom && (
        <Pressable
          style={styles.showMore}
          onPress={() => onCastPress(continueFrom.hash)}
          accessibilityRole="link"
          accessibilityLabel="Show more replies"
        >
          <View style={styles.showMoreDots}>
            {[0, 1, 2].map((dot) => (
              <View key={dot} style={styles.showMoreDot} />
            ))}
          </View>
          <Text style={styles.showMoreText}>Show more replies</Text>
        </Pressable>
      )}
    </View>
  );
}

export function partitionSpamFromTree(replies: FarcasterCastWithReplies[]): {
  clean: FarcasterCastWithReplies[];
  spam: FarcasterCastWithReplies[];
} {
  const clean: FarcasterCastWithReplies[] = [];
  const spam: FarcasterCastWithReplies[] = [];
  for (const reply of replies) {
    if (reply.author?.is_spam === true) {
      spam.push(reply);
      continue;
    }
    const children = reply.direct_replies ?? [];
    if (children.length === 0) {
      clean.push(reply);
      continue;
    }
    const childResult = partitionSpamFromTree(children);
    clean.push({ ...reply, direct_replies: childResult.clean });
    spam.push(...childResult.spam);
  }
  return { clean, spam };
}

export function ThreadedReplies({ replies, ...handlers }: ThreadedRepliesProps) {
  return (
    <View>
      {replies.map((reply) => (
        <ReplyGroup key={reply.hash} reply={reply} {...handlers} />
      ))}
    </View>
  );
}

interface ThreadSlopFooterProps {
  spam: FarcasterCastWithReplies[];
  myFid: number;
  onLike: (hash: string, isLiked: boolean) => void;
  onRecast: (hash: string, isRecasted: boolean) => void;
  onBookmark: (hash: string, isBookmarked: boolean) => void;
  onQuoteCast: (cast: FarcasterCast) => void;
  onReply: (cast: FarcasterCast) => void;
  onBlockAuthor?: (fid: number) => Promise<void> | void;
  onCastPress: (hash: string) => void;
  focusHash?: string;
}

export function ThreadSlopFooter({
  spam,
  myFid,
  onLike,
  onRecast,
  onBookmark,
  onQuoteCast,
  onReply,
  onBlockAuthor,
  onCastPress,
  focusHash,
}: ThreadSlopFooterProps) {
  const styles = useStyles();
  const [revealed, setRevealed] = useState(false);

  if (spam.length === 0) return null;

  if (!revealed) {
    return (
      <Pressable style={styles.slopBanner} onPress={() => setRevealed(true)}>
        <Text style={styles.slopText}>
          See {spam.length} probable slop{" "}
          {spam.length === 1 ? "reply" : "replies"}
        </Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.slopSection}>
      {spam.map((reply) => (
        <View key={reply.hash} style={styles.slopMuted}>
          <ReplyGroup
            reply={reply}
            myFid={myFid}
            onLike={onLike}
            onRecast={onRecast}
            onBookmark={onBookmark}
            onQuoteCast={onQuoteCast}
            onReply={onReply}
            onBlockAuthor={onBlockAuthor}
            onCastPress={onCastPress}
            focusHash={focusHash}
          />
        </View>
      ))}
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    // "Show more replies": dotted continuation of the thread line, aligned
    // under the 48px avatar column (16 padding + 24 half-avatar).
    showMore: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 12,
      minHeight: 44,
      paddingHorizontal: 16,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
    },
    showMoreDots: {
      width: 48,
      alignItems: "center" as const,
      gap: 3,
    },
    showMoreDot: {
      width: 2,
      height: 2,
      borderRadius: 1,
      backgroundColor: withAlpha(colors.text.secondary, 0.6),
    },
    showMoreText: {
      color: colors.purple,
      fontSize: 15,
    },
    focusHighlight: {
      backgroundColor: withAlpha(colors.purple, 0.08),
    },
    slopBanner: {
      paddingVertical: 12,
      paddingHorizontal: 16,
      minHeight: 44,
    },
    slopText: {
      color: colors.text.secondary,
      fontSize: 14,
      fontStyle: "italic" as const,
    },
    slopSection: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.background.border,
      marginTop: 4,
    },
    slopMuted: {
      opacity: 0.5,
    },
  }));
