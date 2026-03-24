import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from '@/components/common/Avatar';
import { colors } from '@/constants/theme';
import type { Participant } from '@/types/space';

interface SpeakerGridProps {
  speakers: Participant[];
  hostFid: number;
}

export function SpeakerGrid({ speakers, hostFid }: SpeakerGridProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Speakers</Text>
      <View style={styles.grid}>
        {speakers.map((speaker) => {
          const role = speaker.fid === hostFid ? 'Host' : 'Speaker';
          return (
            <View
              key={speaker.fid}
              style={styles.speakerItem}
              accessibilityLabel={`${speaker.display_name}, ${role}${speaker.is_muted ? ', muted' : ''}`}
            >
              <Avatar
                pfpUrl={speaker.pfp_url}
                displayName={speaker.display_name}
                size="lg"
              />
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

const styles = StyleSheet.create({
  container: { padding: 16 },
  title: { color: colors.text.secondary, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  speakerItem: { alignItems: 'center', width: 80, position: 'relative' },
  name: { color: colors.text.primary, fontSize: 12, marginTop: 6, textAlign: 'center' },
  hostBadge: { backgroundColor: colors.accent, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1, marginTop: 4 },
  hostText: { color: colors.text.primary, fontSize: 10, fontWeight: '700' },
  mutedIndicator: { position: 'absolute', bottom: 20, right: 8, backgroundColor: colors.background.surface, borderRadius: 10, padding: 2 },
});
