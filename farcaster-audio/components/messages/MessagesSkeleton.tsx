/**
 * Loading placeholders for the inbox and a thread. One shared opacity pulse
 * (RN Animated, native driver where available) keeps every block in step
 * and works the same on iOS, Android and web.
 */

import { useEffect, useRef } from "react";
import { Animated, View, type DimensionValue } from "react-native";
import { radii, spacing } from "@/constants/theme";
import { useThemedStyles } from "@/hooks/useThemedStyles";

const PULSE_MS = 800;
const PULSE_MIN = 0.35;
const PULSE_MAX = 0.75;
const INBOX_ROWS = 8;
/** Alternating own / incoming bubble widths, newest at the bottom. */
const THREAD_BUBBLES: readonly { isOwn: boolean; width: DimensionValue }[] = [
  { isOwn: false, width: "58%" },
  { isOwn: false, width: "40%" },
  { isOwn: true, width: "52%" },
  { isOwn: false, width: "66%" },
  { isOwn: true, width: "34%" },
  { isOwn: true, width: "60%" },
  { isOwn: false, width: "46%" },
];

function usePulse(): Animated.Value {
  const opacity = useRef(new Animated.Value(PULSE_MIN)).current;
  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: PULSE_MAX, duration: PULSE_MS, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: PULSE_MIN, duration: PULSE_MS, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [opacity]);
  return opacity;
}

export function InboxSkeleton() {
  const styles = useStyles();
  const opacity = usePulse();
  return (
    <View testID="inbox-skeleton" accessibilityLabel="Loading conversations">
      {Array.from({ length: INBOX_ROWS }, (_, index) => (
        <View key={index} style={styles.inboxRow}>
          <Animated.View style={[styles.avatar, { opacity }]} />
          <View style={styles.inboxLines}>
            <Animated.View style={[styles.line, styles.nameLine, { opacity }]} />
            <Animated.View style={[styles.line, styles.previewLine, { opacity }]} />
          </View>
        </View>
      ))}
    </View>
  );
}

export function ThreadSkeleton() {
  const styles = useStyles();
  const opacity = usePulse();
  return (
    <View style={styles.thread} testID="thread-skeleton" accessibilityLabel="Loading messages">
      {THREAD_BUBBLES.map((bubble, index) => (
        <Animated.View
          key={index}
          style={[
            styles.bubble,
            bubble.isOwn ? styles.bubbleOwn : styles.bubbleOther,
            { width: bubble.width, opacity },
          ]}
        />
      ))}
    </View>
  );
}

/** Stand-in for the thread header's avatar + name while the peer resolves. */
export function ThreadHeaderSkeleton() {
  const styles = useStyles();
  const opacity = usePulse();
  return (
    <View
      style={styles.headerRow}
      testID="thread-header-skeleton"
      accessibilityLabel="Loading recipient"
    >
      <Animated.View style={[styles.headerAvatar, { opacity }]} />
      <Animated.View style={[styles.line, styles.headerNameLine, { opacity }]} />
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    inboxRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    avatar: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: colors.background.subtle,
    },
    inboxLines: { flex: 1, gap: spacing.sm },
    line: { height: 12, borderRadius: 4, backgroundColor: colors.background.subtle },
    nameLine: { width: "45%" },
    previewLine: { width: "75%" },
    thread: {
      flex: 1,
      justifyContent: "flex-end",
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    bubble: { height: 36, borderRadius: radii.lg, backgroundColor: colors.background.subtle },
    bubbleOwn: { alignSelf: "flex-end" },
    bubbleOther: { alignSelf: "flex-start" },
    headerRow: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.sm },
    headerAvatar: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.background.subtle,
    },
    headerNameLine: { width: 120 },
  }));
