import { Text, type TextStyle, Linking } from 'react-native';
import { colors } from '@/constants/theme';

const MENTION_PATTERN = /(?<!\w)@[\w][\w.]*[\w]|(?<!\w)@[\w]/;
const URL_PATTERN = /https?:\/\/[^\s<)}\]]+/;
const TOKEN_REGEX = new RegExp(
  `(${MENTION_PATTERN.source})|(${URL_PATTERN.source})`,
  'gu',
);

interface CastTextProps {
  text: string;
  style?: TextStyle;
  numberOfLines?: number;
  onMentionPress?: (username: string) => void;
}

interface TextSegment {
  type: 'text' | 'mention' | 'url';
  value: string;
}

function tokenize(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(TOKEN_REGEX)) {
    const start = match.index!;
    if (start > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, start) });
    }
    if (match[1] !== undefined) {
      segments.push({ type: 'mention', value: match[1] });
    } else {
      segments.push({ type: 'url', value: match[2] });
    }
    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return segments;
}

export function CastText({ text, style, numberOfLines, onMentionPress }: CastTextProps) {
  const segments = tokenize(text);

  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {segments.map((seg, i) => {
        if (seg.type === 'mention') {
          const username = seg.value.slice(1);
          return (
            <Text
              key={i}
              style={{ color: colors.purple }}
              onPress={() => onMentionPress?.(username)}
            >
              {seg.value}
            </Text>
          );
        }

        if (seg.type === 'url') {
          return (
            <Text
              key={i}
              style={{ color: colors.purple }}
              onPress={() => Linking.openURL(seg.value)}
            >
              {seg.value}
            </Text>
          );
        }

        return seg.value;
      })}
    </Text>
  );
}
