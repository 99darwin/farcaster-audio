import { memo, useMemo } from "react";
import { Text, type TextStyle, Linking } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import {
  filterHiddenCastUrls,
  tokenizeCastText,
} from "@/utils/castTextTokens";

interface CastTextProps {
  text: string;
  style?: TextStyle;
  numberOfLines?: number;
  onMentionPress?: (username: string) => void;
  hiddenUrls?: Set<string>;
  selectable?: boolean;
}

function CastTextImpl({
  text,
  style,
  numberOfLines,
  onMentionPress,
  hiddenUrls,
  selectable,
}: CastTextProps) {
  const { colors } = useTheme();
  const segments = useMemo(
    () => filterHiddenCastUrls(tokenizeCastText(text), hiddenUrls),
    [text, hiddenUrls],
  );

  return (
    <Text style={style} numberOfLines={numberOfLines} selectable={selectable}>
      {segments.map((seg, i) => {
        if (seg.type === "mention") {
          return (
            <Text
              key={i}
              style={{ color: colors.purple }}
              onPress={() => onMentionPress?.(seg.username)}
              accessibilityRole="link"
            >
              {seg.value}
            </Text>
          );
        }

        if (seg.type === "url") {
          return (
            <Text
              key={i}
              style={{ color: colors.purple }}
              onPress={() => void Linking.openURL(seg.href).catch(() => {})}
              accessibilityRole="link"
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

export const CastText = memo(CastTextImpl);
