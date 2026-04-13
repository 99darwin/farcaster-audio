import { View, Text, Pressable, StyleSheet } from "react-native";
import { useState } from "react";
import { colors, typography } from "@/constants/theme";

interface TranscriptWord {
  word: string;
  start_ms: number;
  end_ms: number;
}

interface TranscriptProps {
  text: string;
  words: TranscriptWord[] | null;
  positionMs: number;
  isExpanded?: boolean;
}

const PREVIEW_LENGTH = 100;

export function Transcript({
  text,
  words,
  positionMs,
  isExpanded: initialExpanded = false,
}: TranscriptProps) {
  const [isExpanded, setIsExpanded] = useState(initialExpanded);

  if (!text) return null;

  // Truncated preview
  if (!isExpanded) {
    const preview =
      text.length > PREVIEW_LENGTH
        ? text.slice(0, PREVIEW_LENGTH) + "..."
        : text;
    return (
      <Pressable
        onPress={() => setIsExpanded(true)}
        accessibilityLabel="Show transcript"
        accessibilityRole="button"
      >
        <Text style={styles.previewText}>{preview}</Text>
        {text.length > PREVIEW_LENGTH && (
          <Text style={styles.showMore}>Show transcript</Text>
        )}
      </Pressable>
    );
  }

  // Expanded with karaoke word-level highlighting
  if (words && words.length > 0) {
    return (
      <Pressable
        onPress={() => setIsExpanded(false)}
        accessibilityLabel="Hide transcript"
        accessibilityRole="button"
        accessibilityState={{ expanded: true }}
      >
        <Text style={styles.transcriptText}>
          {words.map((w, i) => {
            const isActive = positionMs >= w.start_ms && positionMs < w.end_ms;
            const isPast = positionMs >= w.end_ms;
            return (
              <Text
                key={i}
                style={[
                  styles.word,
                  isActive && styles.activeWord,
                  isPast && styles.pastWord,
                ]}
              >
                {w.word}{" "}
              </Text>
            );
          })}
        </Text>
        <Text style={styles.showMore}>Hide transcript</Text>
      </Pressable>
    );
  }

  // Expanded without word-level timestamps
  return (
    <Pressable
      onPress={() => setIsExpanded(false)}
      accessibilityLabel="Hide transcript"
      accessibilityRole="button"
      accessibilityState={{ expanded: true }}
    >
      <Text style={styles.transcriptText}>{text}</Text>
      <Text style={styles.showMore}>Hide transcript</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  previewText: {
    color: colors.text.secondary,
    fontSize: typography.size.body2,
    lineHeight: 18,
  },
  transcriptText: {
    color: colors.text.body,
    fontSize: typography.size.body2,
    lineHeight: 20,
  },
  word: {
    color: colors.text.secondary,
  },
  activeWord: {
    color: colors.text.primary,
    fontWeight: "600",
  },
  pastWord: {
    color: colors.text.body,
  },
  showMore: {
    color: colors.accent,
    fontSize: typography.size.sm,
    marginTop: 4,
  },
});
