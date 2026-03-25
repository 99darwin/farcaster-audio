import { useState, useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { CastCard } from '@/components/feed/CastCard';
import { colors } from '@/constants/theme';
import type { NeynarCast, NeynarCastWithReplies } from '@/types/neynar';

const INDENT_PX = 28;
const MAX_EXTRA_INDENT_PX = 48; // Max additional indent beyond CastCard's built-in threaded padding
const DEFAULT_MAX_DEPTH = 3;
const MAX_RECURSION_DEPTH = 10;

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
}) {
  // L1: Recursion safety valve
  if (depth > MAX_RECURSION_DEPTH) return null;

  const [isExpanded, setIsExpanded] = useState(false);
  const childReplies = reply.direct_replies ?? [];
  const hasChildren = childReplies.length > 0;
  const isAtMaxDepth = depth >= maxDepth;

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
}: ThreadedRepliesProps) {
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
        />
      ))}
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
});
