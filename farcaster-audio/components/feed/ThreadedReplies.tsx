import { useState, useMemo } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { CastCard } from "@/components/feed/CastCard";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { withAlpha } from "@/constants/theme";
import type { NeynarCast, NeynarCastWithReplies } from "@/types/neynar";

const INDENT_PX = 28;
const MAX_EXTRA_INDENT_PX = 48; // Max additional indent beyond CastCard's built-in threaded padding
const DEFAULT_MAX_DEPTH = 3;
const MAX_RECURSION_DEPTH = 10;

/**
 * Returns true if `hash` matches `reply.hash` or any cast in its nested
 * `direct_replies` subtree.
 */
export function subtreeContainsHash(
  reply: NeynarCastWithReplies,
  hash: string,
): boolean {
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
  const styles = useStyles();

  // L1: Recursion safety valve
  if (depth > MAX_RECURSION_DEPTH) return null;

  const childReplies = reply.direct_replies ?? [];
  const hasChildren = childReplies.length > 0;
  const isAtMaxDepth = depth >= maxDepth;
  const subtreeContainsFocus = focusHash
    ? subtreeContainsHash(reply, focusHash)
    : false;
  const isFocused = !!focusHash && reply.hash === focusHash;
  // Auto-expand collapsed nodes whose subtree contains the focused reply,
  // so the focus target is actually rendered.
  const [isExpanded, setIsExpanded] = useState<boolean>(
    () => isAtMaxDepth && hasChildren && subtreeContainsFocus,
  );

  // CastCard's `threaded` prop already applies 52px left padding + thread line + sm avatar.
  // We only add extra indent for depth > 0 (nested replies beyond direct replies).
  const extraIndent =
    depth > 0 ? Math.min(depth * INDENT_PX, MAX_EXTRA_INDENT_PX) : 0;

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
    <View accessible accessibilityLabel={`Thread reply, depth ${depth + 1}`}>
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
            View {childReplies.length} more{" "}
            {childReplies.length === 1 ? "reply" : "replies"}
          </Text>
        </Pressable>
      )}

      {hasChildren && isAtMaxDepth && isExpanded && (
        <>
          <ThreadedReplies
            replies={childReplies}
            depth={depth + 1}
            maxDepth={Math.min(
              maxDepth + DEFAULT_MAX_DEPTH,
              MAX_RECURSION_DEPTH,
            )}
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
  const styles = useStyles();
  const [slopRevealed, setSlopRevealed] = useState(false);

  // Separate spam from non-spam replies
  const { clean, spam } = useMemo(() => {
    const clean: NeynarCastWithReplies[] = [];
    const spam: NeynarCastWithReplies[] = [];
    for (const reply of replies) {
      if (reply.author?.is_spam === true) {
        spam.push(reply);
      } else {
        clean.push(reply);
      }
    }
    return { clean, spam };
  }, [replies]);

  return (
    <View>
      {clean.map((reply) => (
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

      {spam.length > 0 && !slopRevealed && (
        <Pressable
          style={styles.slopBanner}
          onPress={() => setSlopRevealed(true)}
        >
          <Text style={styles.slopText}>
            See {spam.length} probable slop{" "}
            {spam.length === 1 ? "reply" : "replies"}
          </Text>
        </Pressable>
      )}

      {spam.length > 0 && slopRevealed && (
        <View style={styles.slopSection}>
          {spam.map((reply) => (
            <View key={reply.hash} style={styles.slopMuted}>
              <ReplyNode
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
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    unfurlButton: {
      paddingVertical: 15,
      minHeight: 44,
    },
    unfurlText: {
      color: colors.purple,
      fontSize: 14,
      fontWeight: "500" as const,
    },
    focusHighlight: {
      backgroundColor: withAlpha(colors.purple, 0.08),
      borderLeftWidth: 2,
      borderLeftColor: colors.purple,
    },
    slopBanner: {
      paddingVertical: 12,
      paddingLeft: 68,
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
