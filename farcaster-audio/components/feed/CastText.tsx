import { Text, type TextStyle } from 'react-native';
import { colors } from '@/constants/theme';

const MENTION_REGEX = /((?<!\w)@[\w][\w.]*[\w]|(?<!\w)@[\w])/g;

interface CastTextProps {
  text: string;
  style?: TextStyle;
  numberOfLines?: number;
  onMentionPress?: (username: string) => void;
}

export function CastText({ text, style, numberOfLines, onMentionPress }: CastTextProps) {
  const parts = text.split(MENTION_REGEX);

  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {parts.map((part, i) => {
        if (MENTION_REGEX.test(part)) {
          MENTION_REGEX.lastIndex = 0;
          const username = part.slice(1);
          return (
            <Text
              key={i}
              style={{ color: colors.purple }}
              onPress={() => onMentionPress?.(username)}
            >
              {part}
            </Text>
          );
        }
        MENTION_REGEX.lastIndex = 0;
        return part;
      })}
    </Text>
  );
}
