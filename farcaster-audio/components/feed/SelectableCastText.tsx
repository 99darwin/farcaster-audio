import { memo, useCallback, useMemo, useState } from "react";
import {
  Linking,
  Platform,
  requireNativeComponent,
  StyleSheet,
  type NativeSyntheticEvent,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { CastText } from "@/components/feed/CastText";
import { useTheme } from "@/hooks/useTheme";

interface SelectableCastTextProps {
  text: string;
  style?: TextStyle;
  hiddenUrls?: Set<string>;
  onMentionPress?: (username: string) => void;
}

interface LinkPressEvent {
  type: "mention" | "url";
  value: string;
}

interface SizeChangeEvent {
  height: number;
}

interface NativeSelectableCastTextProps {
  text: string;
  textColor: string;
  linkColor: string;
  fontSize: number;
  lineHeight: number;
  style?: ViewStyle;
  onLinkPress?: (event: NativeSyntheticEvent<LinkPressEvent>) => void;
  onSizeChange?: (event: NativeSyntheticEvent<SizeChangeEvent>) => void;
}

const NativeSelectableCastTextView =
  requireNativeComponent<NativeSelectableCastTextProps>(
    "SelectableCastTextView",
  );

function getVisibleText(text: string, hiddenUrls?: Set<string>): string {
  if (!hiddenUrls || hiddenUrls.size === 0) return text;

  let visibleText = text;
  for (const url of hiddenUrls) {
    visibleText = visibleText.replace(url, "");
  }
  return visibleText.replace(/\s+$/, "");
}

function SelectableCastTextImpl({
  text,
  style,
  hiddenUrls,
  onMentionPress,
}: SelectableCastTextProps) {
  const { colors } = useTheme();
  const flatStyle = StyleSheet.flatten(style) ?? {};
  const fontSize =
    typeof flatStyle.fontSize === "number" ? flatStyle.fontSize : 15;
  const lineHeight =
    typeof flatStyle.lineHeight === "number" ? flatStyle.lineHeight : 21;
  const textColor =
    typeof flatStyle.color === "string" ? flatStyle.color : colors.text.body;
  const displayText = useMemo(
    () => getVisibleText(text, hiddenUrls),
    [text, hiddenUrls],
  );
  const [height, setHeight] = useState(lineHeight);

  const handleLinkPress = useCallback(
    (event: NativeSyntheticEvent<LinkPressEvent>) => {
      const { type, value } = event.nativeEvent;
      if (type === "mention") {
        onMentionPress?.(value);
        return;
      }
      Linking.openURL(value);
    },
    [onMentionPress],
  );

  const handleSizeChange = useCallback(
    (event: NativeSyntheticEvent<SizeChangeEvent>) => {
      setHeight(Math.max(lineHeight, Math.ceil(event.nativeEvent.height)));
    },
    [lineHeight],
  );

  if (Platform.OS !== "ios") {
    return (
      <CastText
        text={displayText}
        style={style}
        onMentionPress={onMentionPress}
        selectable
      />
    );
  }

  return (
    <NativeSelectableCastTextView
      text={displayText}
      textColor={textColor}
      linkColor={colors.purple}
      fontSize={fontSize}
      lineHeight={lineHeight}
      onLinkPress={handleLinkPress}
      onSizeChange={handleSizeChange}
      style={{ height, width: "100%" }}
    />
  );
}

export const SelectableCastText = memo(SelectableCastTextImpl);
