import { useEffect, useMemo, useState } from "react";
import {
  View,
  Pressable,
  Modal,
  StyleSheet,
  ActivityIndicator,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import { useVideoPlayer, VideoView, type VideoThumbnail } from "expo-video";
import { Ionicons } from "@expo/vector-icons";
import { useEvent } from "expo";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
} from "react-native-reanimated";
import { useThemedStyles } from "@/hooks/useThemedStyles";

const MAX_INLINE_ASPECT = 4 / 3; // widest
const MIN_INLINE_ASPECT = 3 / 4; // tallest in feed

// Poster generation
const FIRST_FRAME_TIME_S = 0;

// Swipe-down-to-dismiss (mirrors the MediaViewer gesture in common/ImageViewer)
const SPRING_CONFIG = { damping: 20, stiffness: 200 };
const DISMISS_DRAG_THRESHOLD_PX = 110;
const DISMISS_VELOCITY_THRESHOLD = 900;
const PAN_ACTIVE_OFFSET_Y = 12;
const PAN_FAIL_OFFSET_X = 80;
const DISMISS_ANIMATION_MS = 180;
const BACKDROP_MIN_OPACITY = 0.35;
const BACKDROP_FADE_DISTANCE_PX = 420;
const BACKDROP_MAX_ALPHA = 0.95;

type PosterSource = { uri: string } | VideoThumbnail | null;

interface VideoPlayerProps {
  url: string;
  thumbnailUrl?: string;
  aspectRatio?: number;
}

export function VideoPlayer({
  url,
  thumbnailUrl,
  aspectRatio = 16 / 9,
}: VideoPlayerProps) {
  const styles = useStyles();
  const [isStarted, setIsStarted] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [isBuffering, setIsBuffering] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hasFirstFrame, setHasFirstFrame] = useState(false);
  const [generatedPoster, setGeneratedPoster] = useState<VideoThumbnail | null>(
    null,
  );

  // useVideoPlayer creates a fresh player when the source changes, so reset
  // the per-source preview state alongside it (render-time reset avoids a
  // one-frame flash of the previous video's poster).
  const [prevUrl, setPrevUrl] = useState(url);
  if (prevUrl !== url) {
    setPrevUrl(url);
    setIsStarted(false);
    setIsBuffering(false);
    setHasError(false);
    setHasFirstFrame(false);
    setGeneratedPoster(null);
  }

  // Clamp aspect ratio for inline display so tall videos don't dominate the feed
  const inlineAspect = Math.max(
    MIN_INLINE_ASPECT,
    Math.min(MAX_INLINE_ASPECT, aspectRatio),
  );

  const player = useVideoPlayer(url, (p) => {
    p.muted = true;
    p.loop = true;
  });

  const { status } = useEvent(player, "statusChange", {
    status: player.status,
  });

  useEffect(() => {
    if (status === "readyToPlay" && isStarted) {
      setIsBuffering(false);
    } else if (status === "loading" && isStarted) {
      setIsBuffering(true);
    } else if (status === "error") {
      setHasError(true);
      setIsBuffering(false);
    }
  }, [status, isStarted]);

  // Without an embed thumbnail, extract the first frame as a poster once the
  // (paused) player has loaded enough metadata. Progressive buffering means
  // this doesn't download the full video.
  useEffect(() => {
    if (thumbnailUrl || generatedPoster || status !== "readyToPlay") return;

    let isCancelled = false;
    player
      .generateThumbnailsAsync(FIRST_FRAME_TIME_S)
      .then((thumbnails) => {
        if (!isCancelled && thumbnails.length > 0) {
          setGeneratedPoster(thumbnails[0]);
        }
      })
      .catch(() => {
        // Some streaming sources (e.g. HLS) can't generate thumbnails; the
        // paused VideoView still renders the first frame inline as a fallback.
      });

    return () => {
      isCancelled = true;
    };
  }, [thumbnailUrl, generatedPoster, status, player]);

  useEffect(() => {
    return () => {
      player.release();
    };
  }, [player]);

  const handleRetry = () => {
    setHasError(false);
    setIsBuffering(true);
    player.replay();
  };

  const handleToggleMute = () => {
    const newMuted = !isMuted;
    player.muted = newMuted;
    setIsMuted(newMuted);
  };

  const handleOpenFullscreen = () => {
    if (!isStarted) {
      setIsStarted(true);
      setIsBuffering(true);
      setHasError(false);
      player.play();
    }
    setIsFullscreen(true);
  };

  const handleCloseFullscreen = () => {
    setIsFullscreen(false);
  };

  if (hasError) {
    return (
      <View style={[styles.container, { aspectRatio: inlineAspect }]}>
        <View style={[StyleSheet.absoluteFill, styles.placeholder]} />
        <Pressable style={styles.playOverlay} onPress={handleRetry}>
          <View style={styles.retryButton}>
            <Ionicons name="refresh" size={28} color="#fff" />
          </View>
        </Pressable>
      </View>
    );
  }

  const posterSource: PosterSource = thumbnailUrl
    ? { uri: thumbnailUrl }
    : generatedPoster;
  // Keep the embed thumbnail visible until real frames render so pressing
  // play never flashes black; without a thumbnail, cover the loading video
  // with the placeholder (or generated poster) until its first frame shows.
  const showThumbnailPoster = !!thumbnailUrl && (!isStarted || !hasFirstFrame);
  const showFirstFrameCover = !thumbnailUrl && !hasFirstFrame;

  return (
    <>
      <View style={[styles.container, { aspectRatio: inlineAspect }]}>
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          nativeControls={false}
          onFirstFrameRender={() => setHasFirstFrame(true)}
        />
        {showThumbnailPoster && (
          <Image
            source={{ uri: thumbnailUrl }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={200}
          />
        )}
        {showFirstFrameCover &&
          (generatedPoster ? (
            <Image
              source={generatedPoster}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.placeholder]} />
          ))}
        {!isStarted && (
          <Pressable style={styles.playOverlay} onPress={handleOpenFullscreen}>
            <View style={styles.playButton}>
              <Ionicons name="play" size={32} color="#fff" />
            </View>
          </Pressable>
        )}
        {isStarted && isBuffering && (
          <View style={styles.bufferOverlay}>
            <ActivityIndicator size="small" color="#fff" />
          </View>
        )}
        {isStarted && (
          <View style={styles.controls}>
            <Pressable
              onPress={handleToggleMute}
              hitSlop={8}
              style={styles.controlButton}
            >
              <Ionicons
                name={isMuted ? "volume-mute" : "volume-high"}
                size={18}
                color="#fff"
              />
            </Pressable>
            <Pressable
              onPress={handleOpenFullscreen}
              hitSlop={8}
              style={styles.controlButton}
            >
              <Ionicons name="expand" size={18} color="#fff" />
            </Pressable>
          </View>
        )}
      </View>
      <FullscreenModal
        player={player}
        visible={isFullscreen}
        onClose={handleCloseFullscreen}
        isMuted={isMuted}
        onToggleMute={handleToggleMute}
        isBuffering={isBuffering}
        posterSource={posterSource}
      />
    </>
  );
}

function FullscreenModal({
  player,
  visible,
  onClose,
  isMuted,
  onToggleMute,
  isBuffering,
  posterSource,
}: {
  player: ReturnType<typeof useVideoPlayer>;
  visible: boolean;
  onClose: () => void;
  isMuted: boolean;
  onToggleMute: () => void;
  isBuffering: boolean;
  posterSource: PosterSource;
}) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [hasFirstFrame, setHasFirstFrame] = useState(false);
  const dismissTranslateY = useSharedValue(0);
  const backdropOpacity = useSharedValue(1);

  const dismissGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(PAN_ACTIVE_OFFSET_Y)
        .failOffsetX([-PAN_FAIL_OFFSET_X, PAN_FAIL_OFFSET_X])
        .onUpdate((e) => {
          const dragY = Math.max(0, e.translationY);
          dismissTranslateY.value = dragY;
          backdropOpacity.value = Math.max(
            BACKDROP_MIN_OPACITY,
            1 - dragY / BACKDROP_FADE_DISTANCE_PX,
          );
        })
        .onEnd((e) => {
          const shouldDismiss =
            e.translationY > DISMISS_DRAG_THRESHOLD_PX ||
            e.velocityY > DISMISS_VELOCITY_THRESHOLD;
          if (shouldDismiss) {
            dismissTranslateY.value = withTiming(height, {
              duration: DISMISS_ANIMATION_MS,
            });
            backdropOpacity.value = withTiming(
              0,
              { duration: DISMISS_ANIMATION_MS },
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
    [backdropOpacity, dismissTranslateY, height, onClose],
  );

  useEffect(() => {
    if (visible) {
      dismissTranslateY.value = 0;
      backdropOpacity.value = 1;
      setHasFirstFrame(false);
    }
  }, [backdropOpacity, dismissTranslateY, visible]);

  const backdropStyle = useAnimatedStyle(() => ({
    backgroundColor: `rgba(0,0,0,${BACKDROP_MAX_ALPHA * backdropOpacity.value})`,
  }));

  const dismissStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: dismissTranslateY.value }],
  }));

  if (!visible) return null;

  return (
    <Modal visible animationType="fade" transparent onRequestClose={onClose}>
      {/* RN Modal content lives in a separate native root on Android, so the
          gesture handler needs its own root view inside the modal. */}
      <GestureHandlerRootView style={fsStyles.root}>
        <GestureDetector gesture={dismissGesture}>
          <Animated.View style={[fsStyles.backdrop, backdropStyle]}>
            <Animated.View style={[fsStyles.content, dismissStyle]}>
              <VideoView
                player={player}
                style={StyleSheet.absoluteFill}
                contentFit="contain"
                nativeControls={false}
                onFirstFrameRender={() => setHasFirstFrame(true)}
              />
              {!hasFirstFrame && posterSource && (
                <Image
                  source={posterSource}
                  style={StyleSheet.absoluteFill}
                  contentFit="contain"
                  pointerEvents="none"
                />
              )}
              {isBuffering && (
                <View style={styles.bufferOverlay}>
                  <ActivityIndicator size="small" color="#fff" />
                </View>
              )}
              <Pressable
                style={[fsStyles.closeButton, { top: insets.top + 12 }]}
                onPress={onClose}
                hitSlop={12}
              >
                <Ionicons name="close" size={28} color="#fff" />
              </Pressable>
              <View style={[fsStyles.controls, { bottom: insets.bottom + 20 }]}>
                <Pressable
                  onPress={onToggleMute}
                  hitSlop={8}
                  style={fsStyles.controlButton}
                >
                  <Ionicons
                    name={isMuted ? "volume-mute" : "volume-high"}
                    size={22}
                    color="#fff"
                  />
                </Pressable>
              </View>
            </Animated.View>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      width: "100%" as const,
      borderRadius: 12,
      overflow: "hidden" as const,
      backgroundColor: colors.background.surface,
      marginTop: 8,
    },
    placeholder: {
      backgroundColor: colors.background.surface,
    },
    playOverlay: {
      ...StyleSheet.absoluteFillObject,
      justifyContent: "center" as const,
      alignItems: "center" as const,
    },
    playButton: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: "rgba(0,0,0,0.6)",
      justifyContent: "center" as const,
      alignItems: "center" as const,
      paddingLeft: 4,
    },
    retryButton: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: "rgba(0,0,0,0.6)",
      justifyContent: "center" as const,
      alignItems: "center" as const,
    },
    bufferOverlay: {
      ...StyleSheet.absoluteFillObject,
      justifyContent: "center" as const,
      alignItems: "center" as const,
      backgroundColor: "rgba(0,0,0,0.3)",
    },
    controls: {
      position: "absolute" as const,
      bottom: 8,
      right: 8,
      flexDirection: "row" as const,
      gap: 8,
    },
    controlButton: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "center" as const,
      alignItems: "center" as const,
    },
  }));

const fsStyles = StyleSheet.create({
  root: {
    flex: 1,
  },
  backdrop: {
    flex: 1,
  },
  content: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
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
    zIndex: 10,
  },
  controls: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    gap: 12,
  },
  controlButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
});
