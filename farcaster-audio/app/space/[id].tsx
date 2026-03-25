import { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Toast from 'react-native-toast-message';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSpace } from '@/hooks/useSpace';
import { useSpacePermissions } from '@/hooks/useSpacePermissions';
import { useAuthStore } from '@/stores/authStore';
import { useSpaceStore } from '@/stores/spaceStore';
import { SpeakerGrid } from '@/components/spaces/SpeakerGrid';
import { ListenerList } from '@/components/spaces/ListenerList';
import { HandRaiseButton } from '@/components/spaces/HandRaiseButton';
import { HostControls } from '@/components/spaces/HostControls';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { colors } from '@/constants/theme';
import * as api from '@/services/api';

export default function SpaceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const {
    room,
    participants,
    handQueue,
    myRole,
    isConnected,
    isMuted,
    isHandRaised,
    joinRoom,
    leaveRoom,
    toggleMute,
    attachListeners,
  } = useSpace();
  const permissions = useSpacePermissions();
  const [isJoining, setIsJoining] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [showHostControls, setShowHostControls] = useState(false);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!id) return;
    if (room?.id === id) {
      // Room already in store (came from create) — just attach LiveKit listeners
      attachListeners();
      return;
    }
    setIsJoining(true);
    joinRoom(id)
      .catch((err) => {
        Toast.show({ type: 'error', text1: 'Error', text2: err.response?.data?.detail || 'Failed to join space' });
        router.back();
      })
      .finally(() => setIsJoining(false));
  }, [id]);

  const handleLeave = useCallback(async () => {
    if (!id) return;
    setIsLeaving(true);
    router.replace('/');
    await leaveRoom(id);
  }, [id, leaveRoom, router]);

  const handleRaiseHand = useCallback(async () => {
    if (!id) return;
    try {
      const newState = !isHandRaised;
      await api.raiseHand(id, { raised: newState });
      useSpaceStore.getState().setHandRaised(newState);
    } catch (err) {
      console.error('Failed to raise hand:', err);
    }
  }, [id, isHandRaised]);

  const handlePromote = useCallback(async (fid: number) => {
    if (!id) return;
    useSpaceStore.getState().updateParticipant(fid, { role: 'speaker', is_muted: false });
    try {
      await api.promoteParticipant(id, fid);
    } catch (err) {
      useSpaceStore.getState().updateParticipant(fid, { role: 'listener', is_muted: true });
      Toast.show({ type: 'error', text1: 'Error', text2: 'Failed to promote participant' });
    }
  }, [id]);

  const handleDemote = useCallback(async (fid: number) => {
    if (!id) return;
    useSpaceStore.getState().updateParticipant(fid, { role: 'listener', is_muted: true });
    try {
      await api.demoteParticipant(id, fid);
    } catch (err) {
      useSpaceStore.getState().updateParticipant(fid, { role: 'speaker' });
      Toast.show({ type: 'error', text1: 'Error', text2: 'Failed to demote participant' });
    }
  }, [id]);

  const handleMute = useCallback(async (fid: number) => {
    if (!id) return;
    try {
      await api.muteParticipant(id, fid);
    } catch (err) {
      Toast.show({ type: 'error', text1: 'Error', text2: 'Failed to mute participant' });
    }
  }, [id]);

  const handleKick = useCallback(async (fid: number) => {
    if (!id) return;
    try {
      await api.kickParticipant(id, fid);
    } catch (err) {
      Toast.show({ type: 'error', text1: 'Error', text2: 'Failed to kick participant' });
    }
  }, [id]);

  const handleBan = useCallback(async (fid: number) => {
    if (!id) return;
    try {
      await api.banParticipant(id, fid, { reason: 'Removed by host' });
    } catch (err) {
      Toast.show({ type: 'error', text1: 'Error', text2: 'Failed to ban participant' });
    }
  }, [id]);

  const handleEndSpace = useCallback(async () => {
    if (!id) return;
    try {
      await api.endRoom(id);
      router.replace('/');
      await leaveRoom(id);
    } catch (err) {
      Toast.show({ type: 'error', text1: 'Error', text2: 'Failed to end space' });
    }
  }, [id, router, leaveRoom]);

  if (isLeaving || isJoining || !room) {
    return <LoadingSpinner fullScreen />;
  }

  const speakers = participants.filter(
    (p) => p.role === 'host' || p.role === 'co_host' || p.role === 'speaker'
  );
  const listeners = participants.filter((p) => p.role === 'listener');

  return (
    <View style={styles.container}>
      {/* Header info */}
      <View style={styles.header}>
        <Text style={styles.title}>{room.title}</Text>
        <View style={styles.statusRow}>
          <View style={styles.liveDot} />
          <Text style={styles.statusText}>Live</Text>
          <Text style={styles.listenerCount}>
            {participants.length} {participants.length === 1 ? 'person' : 'people'}
          </Text>
        </View>
        {!isConnected && (
          <Text style={styles.reconnecting}>Reconnecting...</Text>
        )}
      </View>

      {/* Content */}
      <ScrollView style={styles.scrollContent}>
        <SpeakerGrid speakers={speakers} hostFid={room.host_fid} />
        <ListenerList listeners={listeners} />
      </ScrollView>

      {/* Bottom Controls */}
      <View style={[styles.controls, { paddingBottom: insets.bottom || 12 }]}>
        {permissions.isListener && (
          <HandRaiseButton isRaised={isHandRaised} onPress={handleRaiseHand} />
        )}
        {permissions.canSelfMute && (
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              toggleMute();
            }}
            style={[styles.controlIcon, isMuted && styles.controlIconMuted]}
            accessibilityLabel={isMuted ? 'Unmute microphone' : 'Mute microphone'}
            accessibilityRole="button"
          >
            <Ionicons name={isMuted ? 'mic-off' : 'mic'} size={24} color={colors.text.primary} />
          </Pressable>
        )}
        {(permissions.canPromote || permissions.canMuteOthers || permissions.canKick || permissions.canEndRoom) && (
          <Pressable
            onPress={() => setShowHostControls(true)}
            style={styles.controlIcon}
            accessibilityLabel="Host controls"
            accessibilityRole="button"
          >
            <Ionicons name="settings-outline" size={24} color={colors.text.primary} />
          </Pressable>
        )}
        <Pressable
          onPress={handleLeave}
          style={[styles.controlIcon, styles.controlIconLeave]}
          accessibilityLabel="Leave space"
          accessibilityRole="button"
        >
          <Ionicons name="exit-outline" size={24} color={colors.text.primary} />
        </Pressable>
      </View>

      {/* Host Controls Modal */}
      <HostControls
        visible={showHostControls}
        onClose={() => setShowHostControls(false)}
        speakers={speakers}
        handQueue={handQueue}
        participants={participants}
        onPromote={handlePromote}
        onDemote={handleDemote}
        onMute={handleMute}
        onKick={handleKick}
        onBan={handleBan}
        onEndSpace={handleEndSpace}
        hostFid={room.host_fid}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background.main },
  header: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.background.border },
  title: { color: colors.text.primary, fontSize: 22, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.live },
  statusText: { color: colors.error, fontSize: 14, fontWeight: '600' },
  listenerCount: { color: colors.text.secondary, fontSize: 14 },
  reconnecting: { color: colors.warning, fontSize: 13, marginTop: 4 },
  scrollContent: { flex: 1 },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.background.border,
    backgroundColor: colors.background.surface,
  },
  controlIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.background.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlIconMuted: {
    backgroundColor: colors.accent,
  },
  controlIconLeave: {
    backgroundColor: colors.danger,
  },
});
