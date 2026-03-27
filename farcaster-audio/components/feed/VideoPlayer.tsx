import { useState, useEffect, useRef } from 'react';
import { View, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import { useEvent } from 'expo';
import { colors } from '@/constants/theme';

interface VideoPlayerProps {
  url: string;
  thumbnailUrl?: string;
  aspectRatio?: number;
}

export function VideoPlayer({ url, thumbnailUrl, aspectRatio = 16 / 9 }: VideoPlayerProps) {
  const [isStarted, setIsStarted] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [isBuffering, setIsBuffering] = useState(false);
  const [hasError, setHasError] = useState(false);

  const player = useVideoPlayer(url, (p) => {
    p.muted = true;
    p.loop = true;
  });

  const { status } = useEvent(player, 'statusChange', { status: player.status });

  useEffect(() => {
    if (status === 'readyToPlay' && isStarted) {
      setIsBuffering(false);
    } else if (status === 'loading' && isStarted) {
      setIsBuffering(true);
    } else if (status === 'error') {
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

  const handleToggleFullscreen = () => {
    // expo-video doesn't have a built-in fullscreen API on the player,
    // but VideoView supports it natively via its controls
  };

  if (!isStarted) {
    return (
      <View style={[styles.container, { aspectRatio }]}>
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
        <Pressable style={styles.playOverlay} onPress={handlePlay}>
          <View style={styles.playButton}>
            <Ionicons name="play" size={32} color="#fff" />
          </View>
        </Pressable>
      </View>
    );
  }

  if (hasError) {
    return (
      <View style={[styles.container, { aspectRatio }]}>
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
    <View style={[styles.container, { aspectRatio }]}>
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        nativeControls={false}
      />
      {isBuffering && (
        <View style={styles.bufferOverlay}>
          <ActivityIndicator size="small" color="#fff" />
        </View>
      )}
      <View style={styles.controls}>
        <Pressable onPress={handleToggleMute} hitSlop={8} style={styles.controlButton}>
          <Ionicons name={isMuted ? 'volume-mute' : 'volume-high'} size={18} color="#fff" />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: colors.background.surface,
    marginTop: 8,
  },
  placeholder: {
    backgroundColor: colors.background.surface,
  },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  playButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingLeft: 4,
  },
  retryButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  bufferOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  controls: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    flexDirection: 'row',
    gap: 8,
  },
  controlButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
