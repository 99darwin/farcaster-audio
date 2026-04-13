import { useState, useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { CastCard } from '@/components/feed/CastCard';
import { colors } from '@/constants/theme';
import type { NeynarCast, NeynarCastWithReplies } from '@/types/neynar';

const INDENT_PX = 28;
const MAX_EXTRA_INDENT_PX = 48; // Max additional indent beyond CastCard's built-in threaded padding
const DEFAULT_MAX_DEPTH = 3;
const MAX_RECURSION_DEPTH = 10;

/**
 * Returns true if `hash` matches `reply.hash` or any cast in its nested
 * `direct_replies` subtree.
 */
export function subtreeContainsHash(reply: NeynarCastWithReplies, hash: string): boolean {
  if (reply.hash === hash) return true;
  const children = reply.direct_replies ?? [];
  for (const child of children) {
    if (subtreeContainsHash(child, hash)) return true;
  }
  return false;
}

/**
 * Walks each top-level reply in `replies` (and its nested subtree) and returns
 * the index of the top-level reply whose subtree contains `hash`. Returns -1
 * if not found.
 */
export function findTopLevelIndexContaining(
  replies: NeynarCastWithReplies[],
  hash: string,
): number {
  for (let i = 0; i < replies.length; i++) {
    if (subtreeContainsHash(replies[i], hash)) return i;
  }
  return -1;
}

interface ThreadedRepliesProps {
  replies: NeynarCastWithReplies[];
  depth?: number;
  maxDepth?: number;
  myFid: number;
  onLike: (hash: string, isLiked: boolean) => void;
  onRecast: (hash: string, isRecasted: boolean) => void;
  onQuoteCast: (cast: NeynarCast) => void;
  onReply: (cast: NeynarCast) => void;
  onCastPress: (hash: string) => void;
  focusHash?: string;
}

function ReplyNode({
  reply,
  depth,
  maxDepth,
  myFid,
  onLike,
  onRecast,
  onQuoteCast,
  onReply,
  onCastPress,
  focusHash,
}: {
  reply: NeynarCastWithReplies;
  depth: number;
  maxDepth: number;
  myFid: number;
  onLike: (hash: string, isLiked: boolean) => void;
  onRecast: (hash: string, isRecasted: boolean) => void;
  onQuoteCast: (cast: NeynarCast) => void;
  onReply: (cast: NeynarCast) => void;
  onCastPress: (hash: string) => void;
  focusHash?: string;
}) {
  // L1: Recursion safety valve
  if (depth > MAX_RECURSION_DEPTH) return null;

  const childReplies = reply.direct_replies ?? [];
  const hasChildren = childReplies.length > 0;
  const isAtMaxDepth = depth >= maxDepth;
  const subtreeContainsFocus = focusHash ? subtreeContainsHash(reply, focusHash) : false;
  const isFocused = !!focusHash && reply.hash === focusHash;
  // Auto-expand collapsed nodes whose subtree contains the focused reply,
  // so the focus target is actually rendered.
  const [isExpanded, setIsExpanded] = useState<boolean>(
    () => isAtMaxDepth && hasChildren && subtreeContainsFocus,
  );

  // CastCard's `threaded` prop already applies 52px left padding + thread line + sm avatar.
  // We only add extra indent for depth > 0 (nested replies beyond direct replies).
  const extraIndent = depth > 0 ? Math.min(depth * INDENT_PX, MAX_EXTRA_INDENT_PX) : 0;

  // L2: Memoize inline styles
  const wrapperStyle = useMemo(
    () => (extraIndent > 0 ? { paddingLeft: extraIndent } : undefined),
    [extraIndent],
  );
  const unfurlPaddingStyle = useMemo(
    () => ({ paddingLeft: extraIndent + 68 }),
    [extraIndent],
  );

  return (
    <View
      accessible
      accessibilityLabel={`Thread reply, depth ${depth + 1}`}
    >
      <View style={wrapperStyle}>
        <View style={isFocused ? styles.focusHighlight : undefined}>
          <CastCard
            cast={reply}
            myFid={myFid}
            onLike={onLike}
            onRecast={onRecast}
            onQuoteCast={onQuoteCast}
            onReply={onReply}
            onPress={() => onCastPress(reply.hash)}
            threaded
            hideThreadLine={depth > 0}
          />
        </View>
      </View>

      {hasChildren && !isAtMaxDepth && (
        <ThreadedReplies
          replies={childReplies}
          depth={depth + 1}
          maxDepth={maxDepth}
          myFid={myFid}
          onLike={onLike}
          onRecast={onRecast}
          onQuoteCast={onQuoteCast}
          onReply={onReply}
          onCastPress={onCastPress}
          focusHash={focusHash}
        />
      )}

      {hasChildren && isAtMaxDepth && !isExpanded && (
        <Pressable
          style={[styles.unfurlButton, unfurlPaddingStyle]}
          onPress={() => setIsExpanded(true)}
        >
          <Text style={styles.unfurlText}>
            View {childReplies.length} more {childReplies.length === 1 ? 'reply' : 'replies'}
          </Text>
        </Pressable>
      )}

      {hasChildren && isAtMaxDepth && isExpanded && (
        <>
          <ThreadedReplies
            replies={childReplies}
            depth={depth + 1}
            maxDepth={Math.min(maxDepth + DEFAULT_MAX_DEPTH, MAX_RECURSION_DEPTH)}
            myFid={myFid}
            onLike={onLike}
            onRecast={onRecast}
            onQuoteCast={onQuoteCast}
            onReply={onReply}
            onCastPress={onCastPress}
            focusHash={focusHash}
          />
          <Pressable
            style={[styles.unfurlButton, unfurlPaddingStyle]}
            onPress={() => setIsExpanded(false)}
          >
            <Text style={styles.unfurlText}>Hide replies</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

/**
 * Groups consecutive spam replies into a collapsible banner.
 * Non-spam replies render individually as ReplyNodes.
 */
function SpamGroup({
  replies,
  depth,
  maxDepth,
  myFid,
  onLike,
  onRecast,
  onQuoteCast,
  onReply,
  onCastPress,
  focusHash,
}: {
  replies: NeynarCastWithReplies[];
  depth: number;
  maxDepth: number;
  myFid: number;
  onLike: (hash: string, isLiked: boolean) => void;
  onRecast: (hash: string, isRecasted: boolean) => void;
  onQuoteCast: (cast: NeynarCast) => void;
  onReply: (cast: NeynarCast) => void;
  onCastPress: (hash: string) => void;
  focusHash?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const extraIndent = depth > 0 ? Math.min(depth * INDENT_PX, MAX_EXTRA_INDENT_PX) : 0;
  const paddingStyle = useMemo(() => ({ paddingLeft: extraIndent + 68 }), [extraIndent]);

  if (!revealed) {
    return (
      <Pressable
        style={[styles.spamGroupBanner, paddingStyle]}
        onPress={() => setRevealed(true)}
      >
        <Text style={styles.spamGroupText}>
          {replies.length} probable slop {replies.length === 1 ? 'reply' : 'replies'}
        </Text>
      </Pressable>
    );
  }

  return (
    <View>
      {replies.map((reply) => (
        <ReplyNode
          key={reply.hash}
          reply={reply}
          depth={depth}
          maxDepth={maxDepth}
          myFid={myFid}
          onLike={onLike}
          onRecast={onRecast}
          onQuoteCast={onQuoteCast}
          onReply={onReply}
          onCastPress={onCastPress}
          focusHash={focusHash}
        />
      ))}
    </View>
  );
}

export function ThreadedReplies({
  replies,
  depth = 0,
  maxDepth = DEFAULT_MAX_DEPTH,
  myFid,
  onLike,
  onRecast,
  onQuoteCast,
  onReply,
  onCastPress,
  focusHash,
}: ThreadedRepliesProps) {
  // Group consecutive spam replies into batches
  const groups = useMemo(() => {
    const result: Array<{ isSpam: boolean; items: NeynarCastWithReplies[] }> = [];
    for (const reply of replies) {
      const spam = reply.author?.is_spam === true;
      const last = result[result.length - 1];
      if (last && last.isSpam === spam) {
        last.items.push(reply);
      } else {
        result.push({ isSpam: spam, items: [reply] });
      }
    }
    return result;
  }, [replies]);

  return (
    <View>
      {groups.map((group) => {
        if (group.isSpam) {
          return (
            <SpamGroup
              key={`spam-${group.items[0].hash}`}
              replies={group.items}
              depth={depth}
              maxDepth={maxDepth}
              myFid={myFid}
              onLike={onLike}
              onRecast={onRecast}
              onQuoteCast={onQuoteCast}
              onReply={onReply}
              onCastPress={onCastPress}
              focusHash={focusHash}
            />
          );
        }
        return group.items.map((reply) => (
          <ReplyNode
            key={reply.hash}
            reply={reply}
            depth={depth}
            maxDepth={maxDepth}
            myFid={myFid}
            onLike={onLike}
            onRecast={onRecast}
            onQuoteCast={onQuoteCast}
            onReply={onReply}
            onCastPress={onCastPress}
            focusHash={focusHash}
          />
        ));
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  unfurlButton: {
    paddingVertical: 15,
    minHeight: 44,
  },
  unfurlText: {
    color: colors.purple,
    fontSize: 14,
    fontWeight: '500',
  },
  focusHighlight: {
    backgroundColor: colors.purple + '14',
    borderLeftWidth: 2,
    borderLeftColor: colors.purple,
  },
  spamGroupBanner: {
    paddingVertical: 12,
    minHeight: 44,
  },
  spamGroupText: {
    color: colors.text.secondary,
    fontSize: 14,
    fontStyle: 'italic',
  },
});
