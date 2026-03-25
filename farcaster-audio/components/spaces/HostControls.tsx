import { useEffect } from 'react';
import { View, Text, Modal, ScrollView, Pressable, Alert, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from '@/components/common/Avatar';
import { Button } from '@/components/common/Button';
import { useSpaceStore } from '@/stores/spaceStore';
import { colors } from '@/constants/theme';
import * as api from '@/services/api';
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
  // Refresh participants and hand queue from backend when modal opens
  useEffect(() => {
    if (!visible) return;
    const roomId = useSpaceStore.getState().room?.id;
    if (!roomId) return;
    api.getRoom(roomId).then((data) => {
      const store = useSpaceStore.getState();
      store.setHandQueue(data.hand_queue ?? []);
      // Sync participant roles from backend
      for (const p of data.participants) {
        store.updateParticipant(p.fid, { role: p.role, pfp_url: p.pfp_url });
      }
    }).catch(() => {});
  }, [visible]);

  const listeners = participants.filter((p) => p.role === 'listener');
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
                      <Pressable onPress={() => onPromote(p.fid)} style={styles.iconButton} accessibilityLabel={`Promote ${p.display_name} to speaker`} accessibilityRole="button">
                        <Ionicons name="checkmark-circle-outline" size={18} color={colors.success} />
                      </Pressable>
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
                      <Pressable onPress={() => onMute(s.fid)} style={styles.iconButton} accessibilityLabel={`Mute ${s.display_name}`} accessibilityRole="button">
                        <Ionicons name="mic-off" size={18} color={colors.text.secondary} />
                      </Pressable>
                      <Pressable onPress={() => onDemote(s.fid)} style={styles.iconButton} accessibilityLabel={`Demote ${s.display_name} to listener`} accessibilityRole="button">
                        <Ionicons name="arrow-down-circle-outline" size={18} color={colors.text.secondary} />
                      </Pressable>
                    </View>
                  )}
                </View>
              ))}
            </View>

            {/* Listeners */}
            {listeners.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>
                  Listeners ({listeners.length})
                </Text>
                {listeners.map((p) => (
                  <View key={p.fid} style={styles.participantRow}>
                    <Avatar pfpUrl={p.pfp_url} displayName={p.display_name} size="sm" />
                    <Text style={styles.participantName}>{p.display_name}</Text>
                    <View style={styles.actions}>
                      <Pressable onPress={() => onPromote(p.fid)} style={styles.iconButton} accessibilityLabel={`Promote ${p.display_name} to speaker`} accessibilityRole="button">
                        <Ionicons name="arrow-up-circle-outline" size={18} color={colors.success} />
                      </Pressable>
                      <Pressable onPress={() => confirmKick(p.fid, p.display_name)} style={styles.iconButton} accessibilityLabel={`Kick ${p.display_name}`} accessibilityRole="button">
                        <Ionicons name="remove-circle-outline" size={18} color={colors.error} />
                      </Pressable>
                      <Pressable onPress={() => confirmBan(p.fid, p.display_name)} style={styles.iconButton} accessibilityLabel={`Ban ${p.display_name}`} accessibilityRole="button">
                        <Ionicons name="ban-outline" size={18} color={colors.error} />
                      </Pressable>
                    </View>
                  </View>
                ))}
              </View>
            )}

            {/* Danger Zone */}
            <View style={[styles.section, styles.dangerSection]}>
              <Button title="End Space" onPress={confirmEndSpace} variant="danger" accessibilityLabel="End space for everyone" />
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.background.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '80%', paddingBottom: 40 },
  handle: { width: 40, height: 4, backgroundColor: colors.background.subtle, borderRadius: 2, alignSelf: 'center', marginTop: 12 },
  title: { color: colors.text.primary, fontSize: 20, fontWeight: '700', textAlign: 'center', marginVertical: 16 },
  scrollContent: { paddingHorizontal: 16 },
  section: { marginBottom: 24 },
  sectionTitle: { color: colors.text.secondary, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', marginBottom: 12 },
  participantRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, minHeight: 44, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.background.border },
  participantName: { color: colors.text.primary, fontSize: 15, flex: 1 },
  actions: { flexDirection: 'row', gap: 4 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  dangerSection: { paddingTop: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.background.border },
});
