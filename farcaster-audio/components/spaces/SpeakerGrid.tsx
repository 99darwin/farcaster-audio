import { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from '@/components/common/Avatar';
import { colors } from '@/constants/theme';
import type { Participant } from '@/types/space';

interface SpeakerGridProps {
  speakers: Participant[];
  hostFid: number;
}

function SpeakingPulse({ isSpeaking }: { isSpeaking: boolean }) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (isSpeaking) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.parallel([
            Animated.timing(scale, { toValue: 1.25, duration: 600, useNativeDriver: true }),
            Animated.timing(opacity, { toValue: 0.6, duration: 300, useNativeDriver: true }),
          ]),
          Animated.parallel([
            Animated.timing(scale, { toValue: 1, duration: 600, useNativeDriver: true }),
            Animated.timing(opacity, { toValue: 0, duration: 600, useNativeDriver: true }),
          ]),
        ]),
      );
      pulse.start();
      return () => pulse.stop();
    } else {
      scale.setValue(1);
      opacity.setValue(0);
    }
  }, [isSpeaking, scale, opacity]);

  if (!isSpeaking) return null;

  return (
    <Animated.View
      style={[
        styles.pulseRing,
        { transform: [{ scale }], opacity },
      ]}
      pointerEvents="none"
    />
  );
}

export function SpeakerGrid({ speakers, hostFid }: SpeakerGridProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Speakers</Text>
      <View style={styles.grid}>
        {speakers.map((speaker) => {
          const role = speaker.fid === hostFid ? 'Host' : 'Speaker';
          const isSpeaking = speaker.is_speaking;
          return (
            <View
              key={speaker.fid}
              style={styles.speakerItem}
              accessibilityLabel={`${speaker.display_name}, ${role}${speaker.is_muted ? ', muted' : ''}`}
            >
              <View style={styles.avatarWrapper}>
                <SpeakingPulse isSpeaking={isSpeaking} />
                <Avatar
                  pfpUrl={speaker.pfp_url}
                  displayName={speaker.display_name}
                  size="lg"
                />
              </View>
              <Text style={styles.name} numberOfLines={1}>{speaker.display_name}</Text>
              {speaker.fid === hostFid && (
                <View style={styles.hostBadge}>
                  <Text style={styles.hostText}>Host</Text>
                </View>
              )}
              {speaker.is_muted && (
                <View style={styles.mutedIndicator}>
                  <Ionicons name="mic-off" size={14} color={colors.text.primary} />
                </View>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const AVATAR_SIZE = 64;

const styles = StyleSheet.create({
  container: { padding: 16 },
  title: { color: colors.text.secondary, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  speakerItem: { alignItems: 'center', width: 80, position: 'relative' },
  avatarWrapper: { justifyContent: 'center', alignItems: 'center' },
  pulseRing: {
    position: 'absolute',
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    borderWidth: 3,
    borderColor: colors.success,
  },
  name: { color: colors.text.primary, fontSize: 13, marginTop: 6, textAlign: 'center' },
  hostBadge: { backgroundColor: colors.accent, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1, marginTop: 4 },
  hostText: { color: colors.text.primary, fontSize: 10, fontWeight: '700' },
  mutedIndicator: { position: 'absolute', bottom: 20, right: 8, backgroundColor: colors.background.surface, borderRadius: 10, padding: 2 },
});
