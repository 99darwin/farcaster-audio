import { View, Pressable, StyleSheet } from "react-native";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { glass } from "@/constants/theme";
import {
  REACTION_EMOJI,
  emojiImageUrl,
  type ReactionKey,
} from "@/constants/emoji";

interface EmojiReactionPanelProps {
  onReaction: (key: ReactionKey) => void;
}

export function EmojiReactionPanel({ onReaction }: EmojiReactionPanelProps) {
  const handlePress = (key: ReactionKey) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onReaction(key);
  };

  return (
    <View style={styles.container}>
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
  );
}

const styles = StyleSheet.create({
  container: {
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
    backgroundColor: "rgba(255, 255, 255, 0.08)",
  },
  emojiButtonPressed: {
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    transform: [{ scale: 1.15 }],
  },
  emojiImage: {
    width: 26,
    height: 26,
  },
});
