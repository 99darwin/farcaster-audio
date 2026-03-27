import { View, Pressable, Text, StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, glass } from '@/constants/theme';

const REACTIONS = [
  { emoji: '👏', label: 'Clap' },
  { emoji: '💯', label: '100' },
  { emoji: '😂', label: 'Joy' },
  { emoji: '😭', label: 'Sob' },
  { emoji: '👍', label: 'Thumbs up' },
] as const;

export type ReactionEmoji = (typeof REACTIONS)[number]['emoji'];

interface EmojiReactionPanelProps {
  onReaction: (emoji: ReactionEmoji) => void;
}

export function EmojiReactionPanel({ onReaction }: EmojiReactionPanelProps) {
  const handlePress = (emoji: ReactionEmoji) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onReaction(emoji);
  };

  return (
    <View style={styles.container}>
      {REACTIONS.map(({ emoji, label }) => (
        <Pressable
          key={emoji}
          onPress={() => handlePress(emoji)}
          accessibilityLabel={label}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.emojiButton,
            pressed && styles.emojiButtonPressed,
          ]}
        >
          <Text style={styles.emoji}>{emoji}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
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
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  emojiButtonPressed: {
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    transform: [{ scale: 1.15 }],
  },
  emoji: {
    fontSize: 22,
  },
});
