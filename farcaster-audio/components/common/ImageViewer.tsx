import { useCallback, useMemo, useRef, useState } from "react";
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
const DISMISS_THRESHOLD = 150;

function ZoomableImage({
  uri,
  width,
  height,
  onClose,
}: {
  uri: string;
  width: number;
  height: number;
  onClose: () => void;
}) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  const opacity = useSharedValue(1);
  const [isZoomed, setIsZoomed] = useState(false);

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
          runOnJS(setIsZoomed)(false);
        } else {
          savedScale.value = scale.value;
          runOnJS(setIsZoomed)(scale.value > 1);
        }
      });

    // Vertical-only dismiss pan — used when not zoomed. Fails on horizontal
    // movement so the parent FlatList can page between images.
    const dismissPan = Gesture.Pan()
      .activeOffsetY([-20, 20])
      .failOffsetX([-20, 20])
      .onUpdate((e) => {
        translateY.value = e.translationY;
        opacity.value = Math.max(0.4, 1 - Math.abs(e.translationY) / 400);
      })
      .onEnd((e) => {
        if (Math.abs(e.translationY) > DISMISS_THRESHOLD) {
          opacity.value = withTiming(0, { duration: 200 });
          runOnJS(onClose)();
        } else {
          translateY.value = withSpring(0, SPRING_CONFIG);
          opacity.value = withSpring(1, SPRING_CONFIG);
        }
      });

    // Full pan for when zoomed in — allows panning in all directions.
    const zoomPan = Gesture.Pan()
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
          runOnJS(setIsZoomed)(false);
        } else {
          scale.value = withSpring(2, SPRING_CONFIG);
          savedScale.value = 2;
          runOnJS(setIsZoomed)(true);
        }
      });

    // Only compose the active pan mode so unused pans never capture the
    // gesture from the parent horizontal FlatList.
    const activePan = isZoomed ? zoomPan : dismissPan;
    return Gesture.Exclusive(doubleTap, Gesture.Simultaneous(pinch, activePan));
  }, [
    isZoomed,
    onClose,
    scale,
    savedScale,
    translateX,
    translateY,
    savedTranslateX,
    savedTranslateY,
    opacity,
  ]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
    opacity: opacity.value,
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

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      if (viewableItems.length > 0 && viewableItems[0].index != null) {
        currentIndex.value = viewableItems[0].index;
      }
    },
    [currentIndex],
  );

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;

  if (!visible || images.length === 0) return null;

  return (
    <Modal visible animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
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
              onClose={onClose}
            />
          )}
        />
        {images.length > 1 && (
          <View style={[styles.dotsContainer, { bottom: insets.bottom + 20 }]}>
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
      </View>
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
    backgroundColor: "rgba(0,0,0,0.95)",
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
