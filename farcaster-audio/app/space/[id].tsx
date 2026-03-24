import { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import Toast from 'react-native-toast-message';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSpace } from '@/hooks/useSpace';
import { useSpacePermissions } from '@/hooks/useSpacePermissions';
import { useAuthStore } from '@/stores/authStore';
import { SpeakerGrid } from '@/components/spaces/SpeakerGrid';
import { ListenerList } from '@/components/spaces/ListenerList';
import { HandRaiseButton } from '@/components/spaces/HandRaiseButton';
import { HostControls } from '@/components/spaces/HostControls';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
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
  } = useSpace();
  const permissions = useSpacePermissions();
  const [isJoining, setIsJoining] = useState(false);
  const [showHostControls, setShowHostControls] = useState(false);

  useEffect(() => {
    if (!id || room?.id === id) return;
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
    await leaveRoom(id);
    router.back();
  }, [id, leaveRoom, router]);

  const handleRaiseHand = useCallback(async () => {
    if (!id) return;
    try {
      await api.raiseHand(id, { raised: !isHandRaised });
      // Store update happens via event
    } catch (err) {
      console.error('Failed to raise hand:', err);
    }
  }, [id, isHandRaised]);

  const handlePromote = useCallback(async (fid: number) => {
    if (!id) return;
    try {
      await api.promoteParticipant(id, fid);
    } catch (err) {
      Toast.show({ type: 'error', text1: 'Error', text2: 'Failed to promote participant' });
    }
  }, [id]);

  const handleDemote = useCallback(async (fid: number) => {
    if (!id) return;
    try {
      await api.demoteParticipant(id, fid);
    } catch (err) {
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
      router.back();
    } catch (err) {
      Toast.show({ type: 'error', text1: 'Error', text2: 'Failed to end space' });
    }
  }, [id, router]);

  if (isJoining || !room) {
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
      <View style={styles.controls}>
        {permissions.isListener && (
          <HandRaiseButton isRaised={isHandRaised} onPress={handleRaiseHand} />
        )}
        {permissions.canSelfMute && (
          <Button
            title={isMuted ? 'Unmute' : 'Mute'}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              toggleMute();
            }}
            variant={isMuted ? 'secondary' : 'primary'}
            accessibilityLabel={isMuted ? 'Unmute microphone' : 'Mute microphone'}
          />
        )}
        {permissions.canEndRoom && (
          <Button
            title="Host Controls"
            onPress={() => setShowHostControls(true)}
            variant="ghost"
          />
        )}
        <Button title="Leave" onPress={handleLeave} variant="danger" size="sm" accessibilityLabel="Leave space" />
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
  container: { flex: 1, backgroundColor: '#0f0f23' },
  header: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2a2a4a' },
  title: { color: '#ffffff', fontSize: 22, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#ef4444' },
  statusText: { color: '#ef4444', fontSize: 14, fontWeight: '600' },
  listenerCount: { color: '#8888aa', fontSize: 14 },
  reconnecting: { color: '#fbbf24', fontSize: 13, marginTop: 4 },
  scrollContent: { flex: 1 },
  controls: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#2a2a4a',
    backgroundColor: '#1a1a2e',
  },
});
