import { Text, Linking, type TextStyle } from 'react-native';
import { colors } from '@/constants/theme';

const MENTION_REGEX = /((?<!\w)@[\w][\w.]*[\w]|(?<!\w)@[\w])/g;

interface CastTextProps {
  text: string;
  style?: TextStyle;
  numberOfLines?: number;
}

export function CastText({ text, style, numberOfLines }: CastTextProps) {
  const parts = text.split(MENTION_REGEX);

  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {parts.map((part, i) => {
        if (MENTION_REGEX.test(part)) {
          // Reset regex lastIndex since it's global
          MENTION_REGEX.lastIndex = 0;
          const username = part.slice(1); // remove @
          return (
            <Text
              key={i}
              style={{ color: colors.purple }}
              onPress={() => Linking.openURL(`https://warpcast.com/${encodeURIComponent(username)}`)}
            >
              {part}
            </Text>
          );
        }
        // Reset regex lastIndex
        MENTION_REGEX.lastIndex = 0;
        return part;
      })}
    </Text>
  );
}
