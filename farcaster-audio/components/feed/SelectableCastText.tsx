import { memo } from "react";
import { type TextStyle } from "react-native";
import { CastText } from "@/components/feed/CastText";

interface SelectableCastTextProps {
  text: string;
  style?: TextStyle;
  hiddenUrls?: Set<string>;
  onMentionPress?: (username: string) => void;
}

function SelectableCastTextImpl({
  text,
  style,
  hiddenUrls,
  onMentionPress,
}: SelectableCastTextProps) {
  return (
    <CastText
      text={text}
      style={style}
      hiddenUrls={hiddenUrls}
      onMentionPress={onMentionPress}
      selectable
    />
  );
}

export const SelectableCastText = memo(SelectableCastTextImpl);
