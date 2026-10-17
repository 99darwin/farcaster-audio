/**
 * Global search hit: conversation, the matching message with highlighted
 * terms, and one line of surrounding context on each side.
 */

import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { Avatar } from "@/components/common/Avatar";
import { MessageText } from "@/components/messages/MessageText";
import {
  conversationAvatar,
  conversationTitle,
} from "@/components/messages/ConversationRow";
import { spacing, typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { userDisplayName } from "@/components/messages/userDisplayName";
import { formatInboxTime } from "@/utils/messageTime";
import type { Message, MessageSearchHit } from "@/types/messages";

const HIGHLIGHT_TAG_PATTERN = /<[^>]*>([^<]*)<\/[^>]*>/g;
const MAX_TERM_LENGTH = 64;

/**
 * Terms to highlight where no exact ranges apply (context lines, older
 * servers): `matched_terms`, else the tagged runs inside the raw
 * `highlights` snippets, else the query's words.
 */
export function highlightTermsFor(hit: MessageSearchHit, query: string): string[] {
  if (hit.matched_terms && hit.matched_terms.length > 0) return hit.matched_terms;
  const fromSnippets = hit.highlights
    .flatMap((snippet) => Array.from(snippet.matchAll(HIGHLIGHT_TAG_PATTERN), (m) => m[1].trim()))
    .filter((term) => term.length > 0 && term.length <= MAX_TERM_LENGTH);
  if (fromSnippets.length > 0) return Array.from(new Set(fromSnippets));
  return query.trim().split(/\s+/).filter(Boolean);
}

function ContextLine({
  message,
  terms,
  linkColor,
}: {
  message: Message | undefined;
  terms: string[];
  linkColor: string;
}) {
  const styles = useStyles();
  if (!message || message.is_deleted || !message.text.trim()) return null;
  const name = userDisplayName(message.sender);
  return (
    <View style={styles.matchLine}>
      {name ? <Text style={styles.context}>{`${name}: `}</Text> : null}
      <MessageText
        text={message.text}
        style={[styles.context, styles.contextText]}
        linkColor={linkColor}
        highlightTerms={terms}
        numberOfLines={1}
      />
    </View>
  );
}

interface SearchResultRowProps {
  hit: MessageSearchHit;
  query: string;
  onPress: (hit: MessageSearchHit) => void;
}

function SearchResultRowImpl({ hit, query, onPress }: SearchResultRowProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const title = conversationTitle(hit.conversation);
  const senderName =
    userDisplayName(hit.message.sender);
  const terms = highlightTermsFor(hit, query);
  return (
    <Pressable
      onPress={() => onPress(hit)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${title}: ${hit.message.text}`}
      testID={`search-hit-${hit.message.message_id}`}
    >
      <Avatar pfpUrl={conversationAvatar(hit.conversation)} displayName={title} size="md" />
      <View style={styles.body}>
        <View style={styles.topLine}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.time}>{formatInboxTime(hit.message.sent_at)}</Text>
        </View>
        {/* `before` is newest-first: its first item sits right above the hit. */}
        <ContextLine message={hit.before[0]} terms={terms} linkColor={colors.purple} />
        <View style={styles.matchLine}>
          {hit.conversation.is_group && senderName ? (
            <Text style={styles.sender}>{senderName}: </Text>
          ) : null}
          <MessageText
            text={hit.message.text}
            style={styles.match}
            linkColor={colors.purple}
            highlightTerms={terms}
            highlightRanges={hit.highlight_ranges}
            numberOfLines={3}
          />
        </View>
        {/* `after` is newest-first: its last item sits right below the hit. */}
        <ContextLine
          message={hit.after[hit.after.length - 1]}
          terms={terms}
          linkColor={colors.purple}
        />
      </View>
    </Pressable>
  );
}

export const SearchResultRow = memo(SearchResultRowImpl);

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    row: {
      flexDirection: "row",
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    pressed: { backgroundColor: colors.background.surface },
    body: { flex: 1, gap: 2 },
    topLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    title: {
      flex: 1,
      fontSize: typography.size.md,
      fontWeight: typography.weight.semibold,
      color: colors.text.primary,
    },
    time: { fontSize: typography.size.sm, color: colors.text.secondary },
    matchLine: { flexDirection: "row", flexWrap: "wrap" },
    sender: {
      fontSize: typography.size.body,
      fontWeight: typography.weight.semibold,
      color: colors.text.body,
    },
    match: {
      flexShrink: 1,
      fontSize: typography.size.body,
      lineHeight: 19,
      color: colors.text.body,
    },
    context: { fontSize: typography.size.body2, color: colors.text.secondary },
    contextText: { flexShrink: 1 },
  }));
