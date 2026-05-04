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
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
} from "react-native-reanimated";
import { colors } from "@/constants/theme";

interface MediaViewerProps {
  images: string[];
  initialIndex: number;
  visible: boolean;
  onClose: () => void;
}

const SPRING_CONFIG = { damping: 20, stiffness: 200 };
const DISMISS_THRESHOLD = 110;

function ZoomableImage({
  uri,
  width,
  height,
  onZoomChange,
}: {
  uri: string;
  width: number;
  height: number;
  onZoomChange: (zoomed: boolean) => void;
}) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  const [isZoomed, setIsZoomed] = useState(false);

  const updateZoomed = useCallback(
    (zoomed: boolean) => {
      setIsZoomed(zoomed);
      onZoomChange(zoomed);
    },
    [onZoomChange],
  );

  const gesture = useMemo(() => {
    const pinch = Gesture.Pinch()
      .onUpdate((e) => {
        scale.value = Math.min(Math.max(savedScale.value * e.scale, 0.5), 4);
      })
      .onEnd(() => {
        if (scale.value < 1) {
          scale.value = withSpring(1, SPRING_CONFIG);
          savedScale.value = 1;
          translateX.value = withSpring(0, SPRING_CONFIG);
          translateY.value = withSpring(0, SPRING_CONFIG);
          savedTranslateX.value = 0;
          savedTranslateY.value = 0;
          runOnJS(updateZoomed)(false);
        } else {
          savedScale.value = scale.value;
          runOnJS(updateZoomed)(scale.value > 1);
        }
      });

    // Full pan for when zoomed in — allows panning in all directions.
    const zoomPan = Gesture.Pan()
      .enabled(isZoomed)
      .onUpdate((e) => {
        translateX.value = savedTranslateX.value + e.translationX;
        translateY.value = savedTranslateY.value + e.translationY;
      })
      .onEnd(() => {
        savedTranslateX.value = translateX.value;
        savedTranslateY.value = translateY.value;
      });

    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .onEnd(() => {
        if (savedScale.value > 1) {
          scale.value = withSpring(1, SPRING_CONFIG);
          savedScale.value = 1;
          translateX.value = withSpring(0, SPRING_CONFIG);
          translateY.value = withSpring(0, SPRING_CONFIG);
          savedTranslateX.value = 0;
          savedTranslateY.value = 0;
          runOnJS(updateZoomed)(false);
        } else {
          scale.value = withSpring(2, SPRING_CONFIG);
          savedScale.value = 2;
          runOnJS(updateZoomed)(true);
        }
      });

    return Gesture.Exclusive(doubleTap, Gesture.Simultaneous(pinch, zoomPan));
  }, [
    isZoomed,
    updateZoomed,
    scale,
    savedScale,
    translateX,
    translateY,
    savedTranslateX,
    savedTranslateY,
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
      <Animated.View
        style={[
          { width, height, justifyContent: "center", alignItems: "center" },
          animatedStyle,
        ]}
      >
        <Image
          source={{ uri }}
          style={{ width, height: height * 0.8 }}
          contentFit="contain"
          transition={200}
        />
      </Animated.View>
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
  const dismissTranslateY = useSharedValue(0);
  const backdropOpacity = useSharedValue(1);
  const [isZoomed, setIsZoomed] = useState(false);

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      if (viewableItems.length > 0 && viewableItems[0].index != null) {
        currentIndex.value = viewableItems[0].index;
        setIsZoomed(false);
      }
    },
    [currentIndex],
  );

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;
  const dismissGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!isZoomed)
        .activeOffsetY(12)
        .failOffsetX([-80, 80])
        .onUpdate((e) => {
          const dragY = Math.max(0, e.translationY);
          dismissTranslateY.value = dragY;
          backdropOpacity.value = Math.max(0.35, 1 - dragY / 420);
        })
        .onEnd((e) => {
          const shouldDismiss =
            e.translationY > DISMISS_THRESHOLD || e.velocityY > 900;
          if (shouldDismiss) {
            dismissTranslateY.value = withTiming(height, { duration: 180 });
            backdropOpacity.value = withTiming(0, { duration: 180 }, (finished) => {
              if (finished) {
                runOnJS(onClose)();
              }
            });
          } else {
            dismissTranslateY.value = withSpring(0, SPRING_CONFIG);
            backdropOpacity.value = withSpring(1, SPRING_CONFIG);
          }
        }),
    [backdropOpacity, dismissTranslateY, height, isZoomed, onClose],
  );

  useEffect(() => {
    if (visible) {
      dismissTranslateY.value = 0;
      backdropOpacity.value = 1;
      setIsZoomed(false);
    }
  }, [backdropOpacity, dismissTranslateY, visible]);

  const backdropStyle = useAnimatedStyle(() => ({
    backgroundColor: `rgba(0,0,0,${0.95 * backdropOpacity.value})`,
  }));

  const dismissStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: dismissTranslateY.value }],
  }));

  if (!visible || images.length === 0) return null;

  return (
    <Modal visible animationType="fade" transparent onRequestClose={onClose}>
      <GestureDetector gesture={dismissGesture}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Animated.View style={[styles.viewerContent, dismissStyle]}>
            <FlatList
              ref={flatListRef}
              data={images}
              horizontal
              pagingEnabled
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
                />
              )}
            />
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
            >
              <Ionicons name="close" size={28} color="#fff" />
            </Pressable>
          </Animated.View>
        </Animated.View>
      </GestureDetector>
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
  backdrop: {
    flex: 1,
  },
  viewerContent: {
    flex: 1,
  },
  closeButton: {
    position: "absolute",
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
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
