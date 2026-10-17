import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  View,
  Pressable,
  StyleSheet,
  FlatList,
  useWindowDimensions,
  type ViewToken,
} from "react-native";
import { Image, type ImageLoadEventData } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
  type NativeGesture,
  type PanGesture,
} from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withDecay,
  runOnJS,
  type SharedValue,
} from "react-native-reanimated";

interface MediaViewerProps {
  images: string[];
  initialIndex: number;
  visible: boolean;
  onClose: () => void;
}

const SPRING_CONFIG = { damping: 20, stiffness: 200 };
const DISMISS_THRESHOLD = 110;

/** Scale at which the image fits the viewport (resting state). */
const FIT_SCALE = 1;
/** Maximum scale the image settles at after a pinch ends. */
const MAX_SCALE = 4;
/** Hard floor for scale while a pinch is in flight (springs back to fit on release). */
const MIN_PINCH_SCALE = 0.5;
/** Scale applied when double-tapping into a point. */
const DOUBLE_TAP_SCALE = 2.5;
/** Above this scale the image is considered zoomed (enables pan, disables dismiss/paging). */
const ZOOMED_SCALE_THRESHOLD = 1.02;
/** Resistance applied to scale beyond [FIT_SCALE, MAX_SCALE] while pinching. */
const SCALE_RUBBER_BAND_FACTOR = 0.35;
/** Resistance applied to pan translation beyond the image bounds while dragging. */
const PAN_RUBBER_BAND_FACTOR = 0.45;
/** Bounce softness for fling momentum hitting the pan bounds. */
const DECAY_RUBBER_BAND_FACTOR = 0.9;
/** The image box occupies this fraction of the viewport height (see <Image> style below). */
const IMAGE_HEIGHT_RATIO = 0.8;

const clampWorklet = (value: number, min: number, max: number): number => {
  "worklet";
  return Math.min(Math.max(value, min), max);
};

/** Lets `value` exceed [min, max] with resistance instead of stopping dead. */
const applyRubberBand = (
  value: number,
  min: number,
  max: number,
  factor: number,
): number => {
  "worklet";
  if (value < min) return min + (value - min) * factor;
  if (value > max) return max + (value - max) * factor;
  return value;
};

/** Inverse of applyRubberBand: the raw value that would band to `value`. */
const invertRubberBand = (
  value: number,
  min: number,
  max: number,
  factor: number,
): number => {
  "worklet";
  if (value < min) return min + (value - min) / factor;
  if (value > max) return max + (value - max) / factor;
  return value;
};

/**
 * Max translation (from center) that keeps the scaled rendered image covering
 * the viewport. When the scaled image is smaller than the viewport on an axis,
 * the bound is 0 and the image stays centered on that axis.
 */
const getPanBounds = (
  scaleValue: number,
  renderedWidth: number,
  renderedHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): { maxTranslateX: number; maxTranslateY: number } => {
  "worklet";
  const scaledWidth = renderedWidth * scaleValue;
  const scaledHeight = renderedHeight * scaleValue;
  return {
    maxTranslateX: Math.max(0, (scaledWidth - viewportWidth) / 2),
    maxTranslateY: Math.max(0, (scaledHeight - viewportHeight) / 2),
  };
};

export function ZoomableImage({
  uri,
  width,
  height,
  onZoomChange,
  zoomedShared,
  scrollGesture,
  dismissGesture,
}: {
  uri: string;
  width: number;
  height: number;
  onZoomChange: (zoomed: boolean) => void;
  /** UI-thread mirror of the zoomed state (JS `isZoomed` lags by a frame). */
  zoomedShared: SharedValue<boolean>;
  /**
   * Gesture.Native() attached to the paging FlatList. The pinch relates to it
   * explicitly so the two recognizers do not cancel each other. Must be the
   * gesture OBJECT, not
   * a component ref: RNGH resolves relations via `handlerTag`, which gesture
   * objects always carry but a FlatList ref does not (RNGH's own FlatList
   * forwards its ref to the plain RN FlatList, so even that ref silently
   * resolves to no relation).
   */
  scrollGesture: NativeGesture;
  /** Stable ancestor dismiss recognizer; related explicitly to every image gesture. */
  dismissGesture: PanGesture;
}) {
  const scale = useSharedValue(FIT_SCALE);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  // Snapshots taken when a pinch begins (transform math is relative to these).
  const pinchStartScale = useSharedValue(FIT_SCALE);
  const pinchStartTranslateX = useSharedValue(0);
  const pinchStartTranslateY = useSharedValue(0);
  const pinchStartFocalX = useSharedValue(0);
  const pinchStartFocalY = useSharedValue(0);
  // Last known focal point, used to anchor the settle spring when over max scale.
  const lastFocalX = useSharedValue(0);
  const lastFocalY = useSharedValue(0);
  // Snapshot taken when a one-finger pan begins.
  const panStartTranslateX = useSharedValue(0);
  const panStartTranslateY = useSharedValue(0);
  // While true, an active pinch owns translateX/Y and the pan must not write.
  // Needed on iOS: maxPointers(1) only makes UIPanGestureRecognizer IGNORE
  // extra touches once active — it does NOT cancel the pan (Android does).
  const isPinching = useSharedValue(false);
  // Last event translation seen by the pan. Folded into the snapshot when a
  // pan that survived a pinch resumes, so it continues from the post-pinch
  // transform instead of its stale pre-pinch snapshot.
  const panLatestTranslationX = useSharedValue(0);
  const panLatestTranslationY = useSharedValue(0);
  // Set whenever a pinch begins; a still-active pan re-snapshots translateX/Y
  // on its first update after the pinch releases the transform.
  const panNeedsRebaseline = useSharedValue(false);
  // Rendered image size at scale 1 (contentFit="contain" letterboxes inside
  // the image box). Falls back to the full box until the source loads.
  const renderedWidth = useSharedValue(width);
  const renderedHeight = useSharedValue(height * IMAGE_HEIGHT_RATIO);
  const updateZoomed = useCallback(
    (zoomed: boolean) => {
      onZoomChange(zoomed);
    },
    [onZoomChange],
  );

  const handleImageLoad = useCallback(
    (event: ImageLoadEventData) => {
      const { width: sourceWidth, height: sourceHeight } = event.source;
      if (!sourceWidth || !sourceHeight) return;
      const boxWidth = width;
      const boxHeight = height * IMAGE_HEIGHT_RATIO;
      const containFactor = Math.min(
        boxWidth / sourceWidth,
        boxHeight / sourceHeight,
      );
      renderedWidth.value = sourceWidth * containFactor;
      renderedHeight.value = sourceHeight * containFactor;
    },
    [width, height, renderedWidth, renderedHeight],
  );

  const gesture = useMemo(() => {
    const halfWidth = width / 2;
    const halfHeight = height / 2;

    // Flips the UI-thread mirror synchronously (gesture guards read it the
    // same frame) and mirrors to JS state (enabled()/scrollEnabled props).
    const setZoomed = (zoomed: boolean) => {
      "worklet";
      zoomedShared.value = zoomed;
      runOnJS(updateZoomed)(zoomed);
    };

    const resetToFit = () => {
      "worklet";
      // A visual reset also ends the zoom gesture's ownership of the touch
      // stream. In particular, a pan can still be ACTIVE when a double tap
      // resets the image; leaving these hand-off flags set makes that inert
      // recognizer continue competing with paging and swipe-to-dismiss.
      isPinching.value = false;
      panNeedsRebaseline.value = false;
      panLatestTranslationX.value = 0;
      panLatestTranslationY.value = 0;
      scale.value = withSpring(FIT_SCALE, SPRING_CONFIG);
      translateX.value = withSpring(0, SPRING_CONFIG);
      translateY.value = withSpring(0, SPRING_CONFIG);
      setZoomed(false);
    };

    const pinch = Gesture.Pinch()
      // Let a one-finger native page swipe activate while the pinch recognizer
      // is still waiting for a second pointer. `blocksExternalGesture` makes
      // the FlatList wait until the pinch fails (usually finger-up), which
      // prevents focused images from paging at all. Once a real pinch starts
      // below, paging is disabled through `setZoomed(true)` instead.
      .simultaneousWithExternalGesture(scrollGesture, dismissGesture)
      .onStart((e) => {
        isPinching.value = true;
        setZoomed(true);
        // Any concurrently active pan must re-snapshot once this pinch is
        // done. Set here (not in the pan's update) because the pan's tracked
        // finger may never move during the pinch, so the pan may not fire
        // another update until after the pinch has ended. Harmlessly stale
        // when no pan is active — pan.onStart clears it.
        panNeedsRebaseline.value = true;
        pinchStartScale.value = scale.value;
        pinchStartTranslateX.value = translateX.value;
        pinchStartTranslateY.value = translateY.value;
        pinchStartFocalX.value = e.focalX - halfWidth;
        pinchStartFocalY.value = e.focalY - halfHeight;
        lastFocalX.value = pinchStartFocalX.value;
        lastFocalY.value = pinchStartFocalY.value;
      })
      .onUpdate((e) => {
        const rawScale = pinchStartScale.value * e.scale;
        const nextScale = Math.max(
          applyRubberBand(
            rawScale,
            FIT_SCALE,
            MAX_SCALE,
            SCALE_RUBBER_BAND_FACTOR,
          ),
          MIN_PINCH_SCALE,
        );
        const focalX = e.focalX - halfWidth;
        const focalY = e.focalY - halfHeight;
        lastFocalX.value = focalX;
        lastFocalY.value = focalY;
        // Keep the content point that was under the focal at pinch start under
        // the (possibly moved) focal now: t' = f - (s'/s0) * (f0 - t0).
        // Using the live focal also pans the image with the fingers.
        const scaleRatio = nextScale / pinchStartScale.value;
        translateX.value =
          focalX -
          scaleRatio * (pinchStartFocalX.value - pinchStartTranslateX.value);
        translateY.value =
          focalY -
          scaleRatio * (pinchStartFocalY.value - pinchStartTranslateY.value);
        scale.value = nextScale;
      })
      .onEnd(() => {
        if (scale.value < ZOOMED_SCALE_THRESHOLD) {
          resetToFit();
          return;
        }
        const settledScale = Math.min(scale.value, MAX_SCALE);
        let targetX = translateX.value;
        let targetY = translateY.value;
        if (scale.value > MAX_SCALE) {
          // Shrink back to MAX_SCALE anchored at the last focal point so the
          // spring doesn't jump to a different part of the image.
          const scaleRatio = settledScale / scale.value;
          targetX =
            lastFocalX.value - scaleRatio * (lastFocalX.value - targetX);
          targetY =
            lastFocalY.value - scaleRatio * (lastFocalY.value - targetY);
        }
        const bounds = getPanBounds(
          settledScale,
          renderedWidth.value,
          renderedHeight.value,
          width,
          height,
        );
        targetX = clampWorklet(
          targetX,
          -bounds.maxTranslateX,
          bounds.maxTranslateX,
        );
        targetY = clampWorklet(
          targetY,
          -bounds.maxTranslateY,
          bounds.maxTranslateY,
        );
        if (settledScale !== scale.value) {
          scale.value = withSpring(settledScale, SPRING_CONFIG);
        }
        if (targetX !== translateX.value) {
          translateX.value = withSpring(targetX, SPRING_CONFIG);
        }
        if (targetY !== translateY.value) {
          translateY.value = withSpring(targetY, SPRING_CONFIG);
        }
        setZoomed(true);
      })
      .onFinalize((_event, success) => {
        // onFinalize (not onEnd) so the flag also clears if the pinch is
        // cancelled without a clean end.
        isPinching.value = false;
        if (!success) resetToFit();
      });

    // One-finger pan while zoomed. maxPointers(1) keeps it from fighting the
    // pinch over translateX/Y — two-finger movement is handled by the pinch's
    // focal tracking instead.
    const zoomPan = Gesture.Pan()
      // Keep every leaf in the composed image gesture related to both native
      // paging and the ancestor dismiss recognizer. This handler stays
      // installed at fit scale, but must FAIL there rather than merely ignore
      // callbacks. An inert ACTIVE pan still owns the stream and can starve
      // the carousel/dismiss recognizers after a double-tap reset.
      .simultaneousWithExternalGesture(scrollGesture, dismissGesture)
      .maxPointers(1)
      .onTouchesMove((event, stateManager) => {
        // Do not fail at first finger-down: iOS delivers that event before it
        // knows a second finger will turn the interaction into a pinch. A
        // synchronous failure there can reject this simultaneous composition
        // before its Pinch sibling recognizes. Once a *single* finger moves
        // at fit scale, this handler is definitely not needed and must get
        // out of the carousel's way.
        if (!zoomedShared.value && event.numberOfTouches === 1) {
          stateManager.fail();
        }
      })
      .onStart(() => {
        if (!zoomedShared.value) return;
        panStartTranslateX.value = translateX.value;
        panStartTranslateY.value = translateY.value;
        panLatestTranslationX.value = 0;
        panLatestTranslationY.value = 0;
        panNeedsRebaseline.value = false;
      })
      .onUpdate((e) => {
        // Keep this recognizer installed and stable across React renders, but
        // make it inert at fit scale. Because it remains simultaneous with the
        // native pager, a one-finger page swipe is never held waiting for a
        // pinch/pan composition to be rebuilt or disabled.
        if (!zoomedShared.value) return;
        if (isPinching.value) {
          // A concurrent pinch owns the transform (iOS keeps this pan active
          // when a second finger lands — maxPointers(1) ignores the touch but
          // does not cancel the pan). Track, don't write.
          panLatestTranslationX.value = e.translationX;
          panLatestTranslationY.value = e.translationY;
          return;
        }
        const bounds = getPanBounds(
          scale.value,
          renderedWidth.value,
          renderedHeight.value,
          width,
          height,
        );
        if (panNeedsRebaseline.value) {
          // First update after a pinch handed the transform back: continue
          // from the post-pinch position, not the stale pre-pinch snapshot.
          // Subtracting the translation already seen makes the delta below
          // start from zero, and inverting the rubber band makes this frame
          // reproduce the current (possibly out-of-bounds) position exactly.
          panStartTranslateX.value =
            invertRubberBand(
              translateX.value,
              -bounds.maxTranslateX,
              bounds.maxTranslateX,
              PAN_RUBBER_BAND_FACTOR,
            ) - panLatestTranslationX.value;
          panStartTranslateY.value =
            invertRubberBand(
              translateY.value,
              -bounds.maxTranslateY,
              bounds.maxTranslateY,
              PAN_RUBBER_BAND_FACTOR,
            ) - panLatestTranslationY.value;
          panNeedsRebaseline.value = false;
        }
        translateX.value = applyRubberBand(
          panStartTranslateX.value + e.translationX,
          -bounds.maxTranslateX,
          bounds.maxTranslateX,
          PAN_RUBBER_BAND_FACTOR,
        );
        translateY.value = applyRubberBand(
          panStartTranslateY.value + e.translationY,
          -bounds.maxTranslateY,
          bounds.maxTranslateY,
          PAN_RUBBER_BAND_FACTOR,
        );
        panLatestTranslationX.value = e.translationX;
        panLatestTranslationY.value = e.translationY;
      })
      .onEnd((e, success) => {
        // The pinch owns (or just settled) the transform — decaying from the
        // pan's stale values here is what caused the post-pinch jump. On
        // Android the pan is CANCELLED when a second pointer lands
        // (success === false); skip so the decay doesn't fight the pinch.
        if (
          !zoomedShared.value ||
          isPinching.value ||
          panNeedsRebaseline.value ||
          !success
        ) {
          return;
        }
        const bounds = getPanBounds(
          scale.value,
          renderedWidth.value,
          renderedHeight.value,
          width,
          height,
        );
        const clampedX = clampWorklet(
          translateX.value,
          -bounds.maxTranslateX,
          bounds.maxTranslateX,
        );
        const clampedY = clampWorklet(
          translateY.value,
          -bounds.maxTranslateY,
          bounds.maxTranslateY,
        );
        if (clampedX !== translateX.value) {
          translateX.value = withSpring(clampedX, SPRING_CONFIG);
        } else {
          translateX.value = withDecay({
            velocity: e.velocityX,
            clamp: [-bounds.maxTranslateX, bounds.maxTranslateX],
            rubberBandEffect: true,
            rubberBandFactor: DECAY_RUBBER_BAND_FACTOR,
          });
        }
        if (clampedY !== translateY.value) {
          translateY.value = withSpring(clampedY, SPRING_CONFIG);
        } else {
          translateY.value = withDecay({
            velocity: e.velocityY,
            clamp: [-bounds.maxTranslateY, bounds.maxTranslateY],
            rubberBandEffect: true,
            rubberBandFactor: DECAY_RUBBER_BAND_FACTOR,
          });
        }
      });

    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      // A double tap should zoom, but the recognizer must not hold the native
      // FlatList in BEGAN while it waits to see whether a one-finger drag is a
      // second tap. Let paging recognize alongside it; movement makes the tap
      // fail naturally while the page swipe continues.
      .simultaneousWithExternalGesture(scrollGesture, dismissGesture)
      .onEnd((e) => {
        if (scale.value > ZOOMED_SCALE_THRESHOLD) {
          resetToFit();
          return;
        }
        // Zoom into the tapped point: keep the content under the tap fixed,
        // clamped so we don't zoom past the image edges.
        const focalX = e.x - halfWidth;
        const focalY = e.y - halfHeight;
        const contentX = (focalX - translateX.value) / scale.value;
        const contentY = (focalY - translateY.value) / scale.value;
        const bounds = getPanBounds(
          DOUBLE_TAP_SCALE,
          renderedWidth.value,
          renderedHeight.value,
          width,
          height,
        );
        const targetX = clampWorklet(
          focalX - DOUBLE_TAP_SCALE * contentX,
          -bounds.maxTranslateX,
          bounds.maxTranslateX,
        );
        const targetY = clampWorklet(
          focalY - DOUBLE_TAP_SCALE * contentY,
          -bounds.maxTranslateY,
          bounds.maxTranslateY,
        );
        scale.value = withSpring(DOUBLE_TAP_SCALE, SPRING_CONFIG);
        translateX.value = withSpring(targetX, SPRING_CONFIG);
        translateY.value = withSpring(targetY, SPRING_CONFIG);
        setZoomed(true);
      });

    return Gesture.Exclusive(
      doubleTap,
      Gesture.Simultaneous(pinch, zoomPan),
    );
  }, [
    updateZoomed,
    width,
    height,
    scale,
    translateX,
    translateY,
    pinchStartScale,
    pinchStartTranslateX,
    pinchStartTranslateY,
    pinchStartFocalX,
    pinchStartFocalY,
    lastFocalX,
    lastFocalY,
    panStartTranslateX,
    panStartTranslateY,
    isPinching,
    panLatestTranslationX,
    panLatestTranslationY,
    panNeedsRebaseline,
    zoomedShared,
    renderedWidth,
    renderedHeight,
    scrollGesture,
    dismissGesture,
  ]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureDetector gesture={gesture}>
      {/* Gesture coordinates (focal/tap) are read against this untransformed
          container so the math stays stable while the inner view scales. */}
      <View style={{ width, height }} collapsable={false}>
        <Animated.View
          style={[
            { width, height, justifyContent: "center", alignItems: "center" },
            animatedStyle,
          ]}
        >
          <Image
            source={{ uri }}
            style={{ width, height: height * IMAGE_HEIGHT_RATIO }}
            contentFit="contain"
            transition={200}
            onLoad={handleImageLoad}
          />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

export function MediaViewer({
  images,
  initialIndex,
  visible,
  onClose,
}: MediaViewerProps) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const currentIndex = useSharedValue(initialIndex);
  const flatListRef = useRef<FlatList>(null);
  // The FlatList's scroll as an RNGH gesture, so per-image pinches can hold
  // a real arbitration relation to it (see ZoomableImage.scrollGesture).
  const nativeScroll = useMemo(() => Gesture.Native(), []);
  const dismissTranslateY = useSharedValue(0);
  const backdropOpacity = useSharedValue(1);
  const [isZoomed, setIsZoomed] = useState(false);
  // UI-thread mirror of isZoomed: .enabled(!isZoomed) only updates on the
  // next JS render, so the dismiss pan also checks this synchronously to
  // reject flicks landing in that one-frame window right after a pinch.
  const zoomedShared = useSharedValue(false);

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      if (viewableItems.length > 0 && viewableItems[0].index != null) {
        const nextIndex = viewableItems[0].index;
        // FlatList may re-emit viewability for the current page when
        // scrollEnabled changes at pinch start. Treat only a real page change
        // as a zoom reset; otherwise this callback races the UI-thread pinch
        // and immediately re-enables paging under the two fingers.
        if (currentIndex.value === nextIndex) return;
        currentIndex.value = nextIndex;
        setIsZoomed(false);
        zoomedShared.value = false;
      }
    },
    [currentIndex, zoomedShared],
  );

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;
  const dismissGesture = useMemo(
    () =>
      Gesture.Pan()
        // Keep the gesture object mounted across zoom-state React renders.
        // Replacing/enabling this ancestor recognizer while a pinch is ACTIVE
        // cancels the child pinch on iOS. Fail synchronously from the UI-thread
        // shared state instead, before a zoomed one-finger pan can compete.
        .onTouchesDown((_event, stateManager) => {
          if (zoomedShared.value) stateManager.fail();
        })
        // The focused viewer contains a horizontal native FlatList. Without
        // an explicit simultaneous relationship this ancestor pan can keep
        // the list in BEGAN while it waits to decide whether the drag is a
        // vertical dismiss, so an ordinary one-finger page swipe never
        // reaches the carousel. Directional guards below still ensure that
        // only a downward drag moves/dismisses the viewer.
        .simultaneousWithExternalGesture(nativeScroll)
        // A dismiss is always one finger; without this cap, the vertical
        // drift of a two-finger pinch can activate the dismiss pan first,
        // which cancels the pinch.
        .maxPointers(1)
        .activeOffsetY(12)
        .failOffsetX([-80, 80])
        .onUpdate((e) => {
          // Synchronous re-check: right after a pinch ends, .enabled(!isZoomed)
          // is still stale for a frame while the image is visually zoomed.
          if (zoomedShared.value) return;
          const dragY = Math.max(0, e.translationY);
          dismissTranslateY.value = dragY;
          backdropOpacity.value = Math.max(0.35, 1 - dragY / 420);
        })
        .onEnd((e) => {
          if (zoomedShared.value) {
            // Ignored while zoomed; make sure any pre-zoom drag is undone.
            dismissTranslateY.value = withSpring(0, SPRING_CONFIG);
            backdropOpacity.value = withSpring(1, SPRING_CONFIG);
            return;
          }
          const shouldDismiss =
            e.translationY > DISMISS_THRESHOLD || e.velocityY > 900;
          if (shouldDismiss) {
            dismissTranslateY.value = withTiming(height, { duration: 180 });
            backdropOpacity.value = withTiming(
              0,
              { duration: 180 },
              (finished) => {
                if (finished) {
                  runOnJS(onClose)();
                }
              },
            );
          } else {
            dismissTranslateY.value = withSpring(0, SPRING_CONFIG);
            backdropOpacity.value = withSpring(1, SPRING_CONFIG);
          }
        }),
    [
      backdropOpacity,
      dismissTranslateY,
      height,
      nativeScroll,
      onClose,
      zoomedShared,
    ],
  );

  useEffect(() => {
    if (visible) {
      dismissTranslateY.value = 0;
      backdropOpacity.value = 1;
      setIsZoomed(false);
      zoomedShared.value = false;
    }
  }, [backdropOpacity, dismissTranslateY, visible, zoomedShared]);

  const backdropStyle = useAnimatedStyle(() => ({
    backgroundColor: `rgba(0,0,0,${0.95 * backdropOpacity.value})`,
  }));

  const dismissStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: dismissTranslateY.value }],
  }));

  if (!visible || images.length === 0) return null;

  return (
    <Modal visible animationType="fade" transparent onRequestClose={onClose}>
      {/* Android renders Modal content in a separate native root; RNGH gestures
          inside it need their own GestureHandlerRootView. */}
      <GestureHandlerRootView style={styles.gestureRoot}>
        <GestureDetector gesture={dismissGesture}>
          <Animated.View style={[styles.backdrop, backdropStyle]}>
            <Animated.View style={[styles.viewerContent, dismissStyle]}>
              <GestureDetector gesture={nativeScroll}>
                <FlatList
                  ref={flatListRef}
                  data={images}
                  horizontal
                  pagingEnabled
                  scrollEnabled={!isZoomed}
                  initialScrollIndex={initialIndex}
                  getItemLayout={(_, index) => ({
                    length: width,
                    offset: width * index,
                    index,
                  })}
                  showsHorizontalScrollIndicator={false}
                  onViewableItemsChanged={onViewableItemsChanged}
                  viewabilityConfig={viewabilityConfig}
                  keyExtractor={(item) => item}
                  renderItem={({ item }) => (
                    <ZoomableImage
                      uri={item}
                      width={width}
                      height={height}
                      onZoomChange={setIsZoomed}
                      zoomedShared={zoomedShared}
                      scrollGesture={nativeScroll}
                      dismissGesture={dismissGesture}
                    />
                  )}
                />
              </GestureDetector>
              {images.length > 1 && (
                <View
                  style={[styles.dotsContainer, { bottom: insets.bottom + 20 }]}
                >
                  {images.map((_, i) => (
                    <PageDot key={i} index={i} currentIndex={currentIndex} />
                  ))}
                </View>
              )}
              <Pressable
                style={[styles.closeButton, { top: insets.top + 12 }]}
                onPress={onClose}
                hitSlop={12}
                accessible
                focusable
                importantForAccessibility="yes"
                accessibilityRole="button"
                accessibilityLabel="Close image viewer"
              >
                <Ionicons
                  name="close"
                  size={28}
                  color="#fff"
                  accessible={false}
                  importantForAccessibility="no-hide-descendants"
                />
              </Pressable>
            </Animated.View>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

function PageDot({
  index,
  currentIndex,
}: {
  index: number;
  currentIndex: { value: number };
}) {
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: currentIndex.value === index ? 1 : 0.4,
    transform: [{ scale: currentIndex.value === index ? 1.2 : 1 }],
  }));

  return <Animated.View style={[styles.dot, animatedStyle]} />;
}

const styles = StyleSheet.create({
  gestureRoot: {
    flex: 1,
  },
  backdrop: {
    flex: 1,
  },
  viewerContent: {
    flex: 1,
  },
  closeButton: {
    position: "absolute",
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.15)",
    justifyContent: "center",
    alignItems: "center",
  },
  dotsContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: "#fff",
  },
});
