import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from '@/components/common/Avatar';
import { colors } from '@/constants/theme';
import type { NeynarUser } from '@/types/neynar';

export type ProfileTab = 'casts' | 'replies';

interface ProfileHeaderProps {
  user: NeynarUser;
  isOwnProfile: boolean;
  onFollowToggle: () => void;
  activeTab: ProfileTab;
  onTabChange: (tab: ProfileTab) => void;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function ProfileHeader({ user, isOwnProfile, onFollowToggle, activeTab, onTabChange }: ProfileHeaderProps) {
  const isFollowing = user.viewer_context?.following ?? false;
  const bio = user.profile?.bio?.text;

  return (
    <View style={styles.container}>
      <View style={styles.topRow}>
        <Avatar pfpUrl={user.pfp_url} displayName={user.display_name} size="lg" />
        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={styles.statCount}>{formatCount(user.following_count)}</Text>
            <Text style={styles.statLabel}>Following</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statCount}>{formatCount(user.follower_count)}</Text>
            <Text style={styles.statLabel}>Followers</Text>
          </View>
        </View>
      </View>

      <View style={styles.nameSection}>
        <View style={styles.nameRow}>
          <Text style={styles.displayName}>{user.display_name}</Text>
          {user.pro?.status === 'subscribed' && (
            <Ionicons name="checkmark-circle" size={18} color={colors.purple} />
          )}
        </View>
        <Text style={styles.username}>@{user.username}</Text>
      </View>

      {bio ? <Text style={styles.bio}>{bio}</Text> : null}

      {!isOwnProfile && (
        <Pressable
          style={[styles.followButton, isFollowing && styles.followingButton]}
          onPress={onFollowToggle}
        >
          <Text style={[styles.followText, isFollowing && styles.followingText]}>
            {isFollowing ? 'Following' : 'Follow'}
          </Text>
        </Pressable>
      )}

      <View style={styles.tabRow}>
        <Pressable
          style={[styles.tab, activeTab === 'casts' && styles.tabActive]}
          onPress={() => onTabChange('casts')}
        >
          <Text style={[styles.tabText, activeTab === 'casts' && styles.tabTextActive]}>
            Casts
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tab, activeTab === 'replies' && styles.tabActive]}
          onPress={() => onTabChange('replies')}
        >
          <Text style={[styles.tabText, activeTab === 'replies' && styles.tabTextActive]}>
            Replies
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 24,
    flex: 1,
  },
  stat: {
    alignItems: 'center',
  },
  statCount: {
    color: colors.text.primary,
    fontSize: 18,
    fontWeight: '700',
  },
  statLabel: {
    color: colors.text.secondary,
    fontSize: 13,
    marginTop: 2,
  },
  nameSection: {
    marginTop: 12,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  displayName: {
    color: colors.text.primary,
    fontSize: 20,
    fontWeight: '700',
  },
  username: {
    color: colors.text.secondary,
    fontSize: 15,
    marginTop: 2,
  },
  bio: {
    color: colors.text.body,
    fontSize: 15,
    lineHeight: 21,
    marginTop: 8,
  },
  followButton: {
    marginTop: 12,
    backgroundColor: colors.purple,
    paddingVertical: 8,
    borderRadius: 20,
    alignItems: 'center',
  },
  followingButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.background.border,
  },
  followText: {
    color: colors.text.primary,
    fontSize: 15,
    fontWeight: '700',
  },
  followingText: {
    color: colors.text.secondary,
    fontWeight: '600',
  },
  tabRow: {
    flexDirection: 'row',
    marginTop: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.background.border,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: colors.purple,
  },
  tabText: {
    color: colors.text.secondary,
    fontSize: 15,
    fontWeight: '600',
  },
  tabTextActive: {
    color: colors.text.primary,
  },
});
