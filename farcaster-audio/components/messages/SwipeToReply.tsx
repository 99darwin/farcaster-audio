/**
 * Telegram-style swipe-to-reply. Dragging a bubble left reveals a reply
 * icon; the first time a gesture crosses the threshold it fires one
 * selection haptic (dragging back and forth does not repeat it), and
 * releasing past it triggers `onReply(message)`. The bubble springs home
 * carrying the release velocity so the return feels continuous. Beyond the
 * threshold the drag rubber-bands so the bubble never runs away from the
 * finger. The gesture only activates on a drag toward the leading edge
 * (leftward in LTR, rightward in RTL, where the layout and the iOS back
 * gesture are mirrored), so the edge-swipe back gesture and vertical list
 * scrolling are left alone.
 */

import { memo, useCallback, useMemo, type ReactNode } from "react";
import { I18nManager, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/hooks/useTheme";
import { withAlpha } from "@/constants/theme";
import { haptic } from "@/utils/haptics";
import type { Message } from "@/types/messages";

/** Drag distance (pt) at which releasing replies. */
export const SWIPE_REPLY_THRESHOLD = 64;
/** Fraction of finger travel applied past the threshold. */
const SWIPE_RUBBER_BAND = 0.25;
/** Hard cap on how far the bubble can travel. */
export const SWIPE_MAX_OFFSET = 96;
const ACTIVATION_OFFSET = 12;
const VERTICAL_FAIL_OFFSET = 14;
/** Large sentinel: "no limit" on the far side of an offset range. */
const UNBOUNDED = 10_000;
const ICON_SIZE = 18;
const ICON_BUBBLE = 32;
const SWIPE_SPRING = {
  damping: 20,
  stiffness: 260,
  mass: 0.7,
  overshootClamping: false,
} as const;

/**
 * Per-gesture haptic latch: true exactly once, on the first update past the
 * threshold. `hasFired` is reset when the gesture begins.
 */
export function shouldFireThresholdHaptic(offset: number, hasFired: boolean): boolean {
  "worklet";
  return !hasFired && Math.abs(offset) >= SWIPE_REPLY_THRESHOLD;
}

/**
 * Map raw horizontal finger travel (screen space) to bubble offset: <= 0
 * in LTR, >= 0 in RTL. Only travel toward the reply direction counts.
 * Linear up to the threshold, then rubber-banded, then capped.
 */
export function computeSwipeOffset(translationX: number, isRTL = false): number {
  "worklet";
  const distance = isRTL ? translationX : -translationX;
  if (distance <= 0) return 0;
  const magnitude =
    distance <= SWIPE_REPLY_THRESHOLD
      ? distance
      : Math.min(
          SWIPE_REPLY_THRESHOLD + (distance - SWIPE_REPLY_THRESHOLD) * SWIPE_RUBBER_BAND,
          SWIPE_MAX_OFFSET,
        );
  return isRTL ? magnitude : -magnitude;
}

/** `activeOffsetX` range that starts the pan only toward the reply direction. */
export function swipeActiveOffsetX(isRTL: boolean): [number, number] {
  return isRTL ? [-UNBOUNDED, ACTIVATION_OFFSET] : [-ACTIVATION_OFFSET, UNBOUNDED];
}

/** Release velocity carried into the spring home, toward the reply side only. */
export function releaseVelocity(velocityX: number, isRTL: boolean): number {
  "worklet";
  return isRTL ? Math.max(0, velocityX) : Math.min(0, velocityX);
}

interface SwipeToReplyProps {
  isEnabled: boolean;
  message: Message;
  /** Stable across rows; receives the row's message. */
  onReply: (message: Message) => void;
  children: ReactNode;
}

function SwipeToReplyImpl({ isEnabled, message, onReply, children }: SwipeToReplyProps) {
  const { colors } = useTheme();
  // Fixed for the app's lifetime (an RTL switch restarts the app).
  const isRTL = I18nManager.isRTL;
  const translateX = useSharedValue(0);
  const isPastThreshold = useSharedValue(false);
  const hasFiredHaptic = useSharedValue(false);

  const handleThresholdCrossed = useCallback(() => haptic.selection(), []);
  const handleRelease = useCallback(() => onReply(message), [message, onReply]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(isEnabled)
        .activeOffsetX(swipeActiveOffsetX(isRTL))
        .failOffsetY([-VERTICAL_FAIL_OFFSET, VERTICAL_FAIL_OFFSET])
        .onBegin(() => {
          hasFiredHaptic.value = false;
          isPastThreshold.value = false;
        })
        .onUpdate((event) => {
          const next = computeSwipeOffset(event.translationX, isRTL);
          translateX.value = next;
          isPastThreshold.value = Math.abs(next) >= SWIPE_REPLY_THRESHOLD;
          if (shouldFireThresholdHaptic(next, hasFiredHaptic.value)) {
            hasFiredHaptic.value = true;
            runOnJS(handleThresholdCrossed)();
          }
        })
        .onEnd((event) => {
          if (isPastThreshold.value) runOnJS(handleRelease)();
          translateX.value = withSpring(0, {
            ...SWIPE_SPRING,
            velocity: releaseVelocity(event.velocityX ?? 0, isRTL),
          });
        })
        .onFinalize(() => {
          // Cancelled gestures (no onEnd) still return home.
          if (translateX.value !== 0) translateX.value = withSpring(0, SWIPE_SPRING);
          isPastThreshold.value = false;
        }),
    [
      handleRelease,
      handleThresholdCrossed,
      hasFiredHaptic,
      isEnabled,
      isPastThreshold,
      isRTL,
      translateX,
    ],
  );

  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const iconStyle = useAnimatedStyle(() => {
    const progress = Math.min(1, Math.abs(translateX.value) / SWIPE_REPLY_THRESHOLD);
    return {
      opacity: progress,
      transform: [{ scale: 0.5 + progress * 0.5 }],
    };
  });

  return (
    <GestureDetector gesture={pan}>
      <View>
        <Animated.View
          pointerEvents="none"
          style={[styles.iconSlot, iconStyle]}
          testID="swipe-reply-icon"
        >
          <View
            style={[
              styles.iconBubble,
              { backgroundColor: withAlpha(colors.purple, 0.18) },
            ]}
          >
            <Ionicons name="arrow-undo" size={ICON_SIZE} color={colors.purple} />
          </View>
        </Animated.View>
        <Animated.View style={contentStyle}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
}

export const SwipeToReply = memo(SwipeToReplyImpl);

const styles = StyleSheet.create({
  iconSlot: {
    position: "absolute",
    // `end` follows the layout direction: the icon sits on the side the
    // bubble moves away from.
    end: 12,
    top: 0,
    bottom: 0,
    justifyContent: "center",
  },
  iconBubble: {
    width: ICON_BUBBLE,
    height: ICON_BUBBLE,
    borderRadius: ICON_BUBBLE / 2,
    alignItems: "center",
    justifyContent: "center",
  },
});
