/**
 * Message body text: tappable links and @mentions (reusing the cast
 * tokenizer) plus optional search highlighting: exact server ranges
 * (`highlight_ranges`, UTF-16 offsets into `text`) when given, else
 * case-insensitive term matches.
 */

import { memo, useMemo } from "react";
import { Linking, Text, type StyleProp, type TextStyle } from "react-native";
import { tokenizeCastText } from "@/utils/castTextTokens";
import { useTheme } from "@/hooks/useTheme";
import { withAlpha } from "@/constants/theme";
import type { HighlightRange } from "@/types/messages";

export interface TextPart {
  text: string;
  isMatch: boolean;
}

/** Best-effort: a link the OS can't open (no handler) is simply not followed. */
function ignoreUnopenableLink(): void {}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split `text` into runs that do / don't case-insensitively match any term. */
function splitHighlights(text: string, terms: string[]): TextPart[] {
  const cleaned = Array.from(
    new Set(terms.map((t) => t.trim()).filter((t) => t.length > 0)),
  ).sort((a, b) => b.length - a.length);
  if (!text || cleaned.length === 0) return [{ text, isMatch: false }];
  const pattern = new RegExp(`(${cleaned.map(escapeRegExp).join("|")})`, "gi");
  const parts: TextPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), isMatch: false });
    parts.push({ text: match[0], isMatch: true });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), isMatch: false });
  return parts;
}

/**
 * Split the slice of the full text that starts at `offset` into runs inside /
 * outside the half-open `ranges` (sorted, non-overlapping, full-text indices).
 */
export function splitRanges(
  value: string,
  offset: number,
  ranges: readonly HighlightRange[],
): TextPart[] {
  const end = offset + value.length;
  const parts: TextPart[] = [];
  let cursor = offset;
  for (const range of ranges) {
    const start = Math.max(range.start, cursor);
    const stop = Math.min(range.end, end);
    if (stop <= start) continue;
    if (start > cursor) {
      parts.push({ text: value.slice(cursor - offset, start - offset), isMatch: false });
    }
    parts.push({ text: value.slice(start - offset, stop - offset), isMatch: true });
    cursor = stop;
  }
  if (cursor < end) parts.push({ text: value.slice(cursor - offset), isMatch: false });
  return parts.length > 0 ? parts : [{ text: value, isMatch: false }];
}

interface MessageTextProps {
  text: string;
  style?: StyleProp<TextStyle>;
  linkColor: string;
  highlightTerms?: string[];
  /** Exact ranges into `text`; win over `highlightTerms`. */
  highlightRanges?: readonly HighlightRange[];
  numberOfLines?: number;
  onMentionPress?: (username: string) => void;
}

function MessageTextImpl({
  text,
  style,
  linkColor,
  highlightTerms,
  highlightRanges,
  numberOfLines,
  onMentionPress,
}: MessageTextProps) {
  const { colors } = useTheme();
  const segments = useMemo(() => tokenizeCastText(text), [text]);
  const segmentOffsets = useMemo(() => {
    const offsets: number[] = [];
    let offset = 0;
    for (const segment of segments) {
      offsets.push(offset);
      offset += segment.value.length;
    }
    // Ranges index the raw text; only trust them if segments cover it 1:1.
    return offset === text.length ? offsets : null;
  }, [segments, text]);
  const terms = highlightTerms ?? [];
  const ranges =
    highlightRanges && highlightRanges.length > 0 && segmentOffsets
      ? highlightRanges
      : null;
  const highlightStyle = useMemo<TextStyle>(
    () => ({
      backgroundColor: withAlpha(colors.warning, 0.45),
      borderRadius: 3,
    }),
    [colors.warning],
  );

  const renderHighlighted = (value: string, segmentIndex: number, keyPrefix: string) =>
    (ranges && segmentOffsets
      ? splitRanges(value, segmentOffsets[segmentIndex], ranges)
      : splitHighlights(value, terms)
    ).map((part, index) => (
      <Text
        key={`${keyPrefix}-${index}`}
        style={part.isMatch ? highlightStyle : undefined}
      >
        {part.text}
      </Text>
    ));

  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {segments.map((segment, index) => {
        const key = `s${index}`;
        if (segment.type === "mention") {
          return (
            <Text
              key={key}
              style={{ color: linkColor, fontWeight: "600" }}
              onPress={() => onMentionPress?.(segment.username)}
              suppressHighlighting
            >
              {renderHighlighted(segment.value, index, key)}
            </Text>
          );
        }
        if (segment.type === "url") {
          return (
            <Text
              key={key}
              style={{ color: linkColor, textDecorationLine: "underline" }}
              onPress={() => void Linking.openURL(segment.href).catch(ignoreUnopenableLink)}
              accessibilityRole="link"
              suppressHighlighting
            >
              {renderHighlighted(segment.value, index, key)}
            </Text>
          );
        }
        return renderHighlighted(segment.value, index, key);
      })}
    </Text>
  );
}

export const MessageText = memo(MessageTextImpl);
