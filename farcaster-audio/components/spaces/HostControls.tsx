import { View, Text, Modal, ScrollView, Pressable, Alert, StyleSheet } from 'react-native';
import { Avatar } from '@/components/common/Avatar';
import { Button } from '@/components/common/Button';
import type { Participant } from '@/types/space';

interface HostControlsProps {
  visible: boolean;
  onClose: () => void;
  speakers: Participant[];
  handQueue: number[];
  participants: Participant[];
  onPromote: (fid: number) => void;
  onDemote: (fid: number) => void;
  onMute: (fid: number) => void;
  onKick: (fid: number) => void;
  onBan: (fid: number) => void;
  onEndSpace: () => void;
  hostFid: number;
}

export function HostControls({
  visible,
  onClose,
  speakers,
  handQueue,
  participants,
  onPromote,
  onDemote,
  onMute,
  onKick,
  onBan,
  onEndSpace,
  hostFid,
}: HostControlsProps) {
  const handRaisedParticipants = participants.filter((p) => handQueue.includes(p.fid));

  const confirmEndSpace = () => {
    Alert.alert('End Space', 'Are you sure you want to end this space for everyone?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'End Space', style: 'destructive', onPress: onEndSpace },
    ]);
  };

  const confirmKick = (fid: number, name: string) => {
    Alert.alert('Kick Participant', `Remove ${name} from this space?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Kick', style: 'destructive', onPress: () => onKick(fid) },
    ]);
  };

  const confirmBan = (fid: number, name: string) => {
    Alert.alert('Ban Participant', `Ban ${name} from this space?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Ban', style: 'destructive', onPress: () => onBan(fid) },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />
          <Text style={styles.title}>Host Controls</Text>

          <ScrollView style={styles.scrollContent}>
            {/* Hand Queue */}
            {handRaisedParticipants.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Raised Hands ({handRaisedParticipants.length})</Text>
                {handRaisedParticipants.map((p) => (
                  <View key={p.fid} style={styles.participantRow}>
                    <Avatar pfpUrl={p.pfp_url} displayName={p.display_name} size="sm" />
                    <Text style={styles.participantName}>{p.display_name}</Text>
                    <View style={styles.actions}>
                      <Button title="Accept" onPress={() => onPromote(p.fid)} size="sm" accessibilityLabel={`Promote ${p.display_name} to speaker`} accessibilityRole="button" />
                    </View>
                  </View>
                ))}
              </View>
            )}

            {/* Speakers */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Speakers ({speakers.length})</Text>
              {speakers.map((s) => (
                <View key={s.fid} style={styles.participantRow}>
                  <Avatar pfpUrl={s.pfp_url} displayName={s.display_name} size="sm" />
                  <Text style={styles.participantName}>
                    {s.display_name} {s.fid === hostFid ? '(Host)' : ''}
                  </Text>
                  {s.fid !== hostFid && (
                    <View style={styles.actions}>
                      <Button title="Mute" onPress={() => onMute(s.fid)} variant="ghost" size="sm" accessibilityLabel={`Mute ${s.display_name}`} accessibilityRole="button" />
                      <Button title="Demote" onPress={() => onDemote(s.fid)} variant="secondary" size="sm" accessibilityLabel={`Demote ${s.display_name} to listener`} accessibilityRole="button" />
                    </View>
                  )}
                </View>
              ))}
            </View>

            {/* Danger Zone */}
            <View style={[styles.section, styles.dangerSection]}>
              <Button title="End Space" onPress={confirmEndSpace} variant="danger" accessibilityLabel="End space for everyone" accessibilityRole="button" />
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#1a1a2e', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '80%', paddingBottom: 40 },
  handle: { width: 40, height: 4, backgroundColor: '#3a3a5a', borderRadius: 2, alignSelf: 'center', marginTop: 12 },
  title: { color: '#ffffff', fontSize: 20, fontWeight: '700', textAlign: 'center', marginVertical: 16 },
  scrollContent: { paddingHorizontal: 16 },
  section: { marginBottom: 24 },
  sectionTitle: { color: '#8888aa', fontSize: 13, fontWeight: '600', textTransform: 'uppercase', marginBottom: 12 },
  participantRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, minHeight: 44, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2a2a4a' },
  participantName: { color: '#ffffff', fontSize: 15, flex: 1 },
  actions: { flexDirection: 'row', gap: 8 },
  dangerSection: { paddingTop: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#2a2a4a' },
});
