import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuthStore } from '@/stores/authStore';
import { useSpaceStore } from '@/stores/spaceStore';
import { Avatar } from '@/components/common/Avatar';
import { colors, spacing } from '@/constants/theme';
import * as livekitService from '@/services/livekit';
import * as api from '@/services/api';

export default function SettingsScreen() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const room = useSpaceStore((s) => s.room);
  const leaveSpace = useSpaceStore((s) => s.leaveSpace);

  const handleLogout = async () => {
    if (room) {
      try { await api.leaveRoom(room.id); } catch {}
      await livekitService.disconnectFromRoom();
      leaveSpace();
    }
    router.dismiss();
    await logout();
  };

  return (
    <View style={styles.container}>
      {user && (
        <Pressable
          style={styles.profile}
          onPress={() => {
            router.dismiss();
            router.push(`/profile/${user.fid}`);
          }}
          accessibilityRole="button"
          accessibilityLabel="View your profile"
        >
          <Avatar pfpUrl={user.pfp_url ?? null} displayName={user.display_name || user.username || ''} size="lg" />
          <View style={styles.profileText}>
            <Text style={styles.displayName}>{user.display_name}</Text>
            <Text style={styles.username}>@{user.username}</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.text.secondary} />
        </Pressable>
      )}

      {user?.is_admin && (
        <View style={styles.section}>
          <Pressable
            style={styles.row}
            onPress={() => {
              router.dismiss();
              router.push('/admin');
            }}
            accessibilityRole="button"
            accessibilityLabel="Admin panel"
          >
            <Ionicons name="shield-checkmark-outline" size={20} color={colors.purple} />
            <Text style={styles.rowText}>Admin</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.text.secondary} style={{ marginLeft: 'auto' }} />
          </Pressable>
        </View>
      )}

      <View style={styles.section}>
        <Pressable style={styles.row} onPress={handleLogout} accessibilityRole="button" accessibilityLabel="Log out">
          <Ionicons name="log-out-outline" size={20} color={colors.danger} />
          <Text style={styles.rowTextDanger}>Log Out</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.main,
  },
  profile: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing['2xl'],
    gap: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.background.border,
  },
  profileText: {
    flex: 1,
  },
  displayName: {
    color: colors.text.primary,
    fontSize: 18,
    fontWeight: '700',
  },
  username: {
    color: colors.text.secondary,
    fontSize: 14,
    marginTop: 2,
  },
  section: {
    marginTop: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.background.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.background.border,
    backgroundColor: colors.background.surface,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing['2xl'],
    paddingVertical: 14,
  },
  rowText: {
    color: colors.text.primary,
    fontSize: 16,
  },
  rowTextDanger: {
    color: colors.danger,
    fontSize: 16,
  },
});
