import { View, Pressable, ScrollView } from "react-native";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import {
  REACTION_EMOJI,
  emojiImageUrl,
  type ReactionKey,
} from "@/constants/emoji";

interface EmojiReactionPanelProps {
  onReaction: (key: ReactionKey) => void;
}

export function EmojiReactionPanel({ onReaction }: EmojiReactionPanelProps) {
  const styles = useStyles();

  const handlePress = (key: ReactionKey) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onReaction(key);
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroll}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.inner}>
        {REACTION_EMOJI.map(({ key, label }) => (
          <Pressable
            key={key}
            onPress={() => handlePress(key)}
            accessibilityLabel={label}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.emojiButton,
              pressed && styles.emojiButtonPressed,
            ]}
          >
            <Image
              source={{ uri: emojiImageUrl(key) }}
              style={styles.emojiImage}
              contentFit="contain"
              cachePolicy="memory-disk"
            />
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const useStyles = () =>
  useThemedStyles(({ glass }) => ({
    scroll: {
      maxWidth: "92%" as const,
      alignSelf: "center" as const,
      borderRadius: glass.pillRadius,
    },
    container: {
      flexGrow: 0,
    },
    inner: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: glass.pillRadius,
      backgroundColor: glass.overlayColor,
      borderWidth: 1,
      borderColor: glass.borderColor,
    },
    emojiButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: glass.overlayColor,
    },
    emojiButtonPressed: {
      backgroundColor: glass.accentOverlay,
      transform: [{ scale: 1.15 }],
    },
    emojiImage: {
      width: 26,
      height: 26,
    },
  }));
