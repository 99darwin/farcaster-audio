import { useState, useEffect } from "react";
import {
  View,
  Pressable,
  Modal,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { Image } from "expo-image";
import { useVideoPlayer, VideoView } from "expo-video";
import { Ionicons } from "@expo/vector-icons";
import { useEvent } from "expo";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "@/constants/theme";

const MAX_INLINE_ASPECT = 4 / 3; // widest
const MIN_INLINE_ASPECT = 3 / 4; // tallest in feed

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
  const [isStarted, setIsStarted] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [isBuffering, setIsBuffering] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

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

  useEffect(() => {
    return () => {
      player.release();
    };
  }, [player]);

  const handlePlay = () => {
    setIsStarted(true);
    setIsBuffering(true);
    setHasError(false);
    player.play();
  };

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

  if (!isStarted) {
    return (
      <>
        <Pressable onPress={handleOpenFullscreen}>
          <View style={[styles.container, { aspectRatio: inlineAspect }]}>
            {thumbnailUrl ? (
              <Image
                source={{ uri: thumbnailUrl }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                transition={200}
              />
            ) : (
              <View style={[StyleSheet.absoluteFill, styles.placeholder]} />
            )}
            <View style={styles.playOverlay}>
              <View style={styles.playButton}>
                <Ionicons name="play" size={32} color="#fff" />
              </View>
            </View>
          </View>
        </Pressable>
        <FullscreenModal
          player={player}
          visible={isFullscreen}
          onClose={handleCloseFullscreen}
          isMuted={isMuted}
          onToggleMute={handleToggleMute}
          isBuffering={isBuffering}
        />
      </>
    );
  }

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

  return (
    <>
      <View style={[styles.container, { aspectRatio: inlineAspect }]}>
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          nativeControls={false}
        />
        {isBuffering && (
          <View style={styles.bufferOverlay}>
            <ActivityIndicator size="small" color="#fff" />
          </View>
        )}
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
      </View>
      <FullscreenModal
        player={player}
        visible={isFullscreen}
        onClose={handleCloseFullscreen}
        isMuted={isMuted}
        onToggleMute={handleToggleMute}
        isBuffering={isBuffering}
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
}: {
  player: ReturnType<typeof useVideoPlayer>;
  visible: boolean;
  onClose: () => void;
  isMuted: boolean;
  onToggleMute: () => void;
  isBuffering: boolean;
}) {
  const insets = useSafeAreaInsets();

  if (!visible) return null;

  return (
    <Modal
      visible
      animationType="fade"
      transparent={false}
      onRequestClose={onClose}
    >
      <View style={fsStyles.backdrop}>
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          nativeControls={false}
        />
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
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: colors.background.surface,
    marginTop: 8,
  },
  placeholder: {
    backgroundColor: colors.background.surface,
  },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
  },
  playButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    paddingLeft: 4,
  },
  retryButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
  },
  bufferOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.3)",
  },
  controls: {
    position: "absolute",
    bottom: 8,
    right: 8,
    flexDirection: "row",
    gap: 8,
  },
  controlButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
});

const fsStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.95)",
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
