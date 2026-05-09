import {
  ActionSheetIOS,
  View,
  Text,
  Pressable,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Avatar } from "@/components/common/Avatar";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import type { NeynarUser } from "@/types/neynar";

export type ProfileTab = "casts" | "replies" | "voice_notes" | "recordings";

interface ProfileHeaderProps {
  user: NeynarUser;
  isOwnProfile: boolean;
  onFollowToggle: () => void;
  onBlockToggle: () => void;
  activeTab: ProfileTab;
  onTabChange: (tab: ProfileTab) => void;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function ProfileHeader({
  user,
  isOwnProfile,
  onFollowToggle,
  onBlockToggle,
  activeTab,
  onTabChange,
}: ProfileHeaderProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const isFollowing = user.viewer_context?.following ?? false;
  const isBlocked = user.viewer_context?.blocked ?? false;
  const bio = user.profile?.bio?.text;

  const handleMenuPress = () => {
    const blockLabel = isBlocked ? "Unblock user" : "Block user";
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ["Cancel", blockLabel],
        cancelButtonIndex: 0,
        destructiveButtonIndex: isBlocked ? undefined : 1,
      },
      (buttonIndex) => {
        if (buttonIndex === 1) onBlockToggle();
      },
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.topRow}>
        <Avatar
          pfpUrl={user.pfp_url}
          displayName={user.display_name}
          size="lg"
        />
        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={styles.statCount}>
              {formatCount(user.following_count)}
            </Text>
            <Text style={styles.statLabel}>Following</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statCount}>
              {formatCount(user.follower_count)}
            </Text>
            <Text style={styles.statLabel}>Followers</Text>
          </View>
        </View>
        {!isOwnProfile && (
          <Pressable
            style={styles.menuButton}
            onPress={handleMenuPress}
            accessibilityRole="button"
            accessibilityLabel="Profile options"
          >
            <Ionicons
              name="ellipsis-horizontal"
              size={20}
              color={colors.text.secondary}
            />
          </Pressable>
        )}
      </View>

      <View style={styles.nameSection}>
        <View style={styles.nameRow}>
          <Text style={styles.displayName}>{user.display_name}</Text>
          {user.pro?.status === "subscribed" && (
            <Ionicons name="checkmark-circle" size={18} color={colors.purple} />
          )}
        </View>
        <Text style={styles.username}>@{user.username}</Text>
      </View>

      {bio ? <Text style={styles.bio}>{bio}</Text> : null}

      {!isOwnProfile && !isBlocked && (
        <Pressable
          style={[styles.followButton, isFollowing && styles.followingButton]}
          onPress={onFollowToggle}
        >
          <Text
            style={[styles.followText, isFollowing && styles.followingText]}
          >
            {isFollowing ? "Following" : "Follow"}
          </Text>
        </Pressable>
      )}

      {!isOwnProfile && isBlocked && (
        <Pressable style={styles.blockedButton} onPress={onBlockToggle}>
          <Text style={styles.blockedText}>Unblock</Text>
        </Pressable>
      )}

      <View style={styles.tabRow}>
        <Pressable
          style={[styles.tab, activeTab === "casts" && styles.tabActive]}
          onPress={() => onTabChange("casts")}
        >
          <Text
            style={[
              styles.tabText,
              activeTab === "casts" && styles.tabTextActive,
            ]}
          >
            Casts
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tab, activeTab === "replies" && styles.tabActive]}
          onPress={() => onTabChange("replies")}
        >
          <Text
            style={[
              styles.tabText,
              activeTab === "replies" && styles.tabTextActive,
            ]}
          >
            Replies
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tab, activeTab === "voice_notes" && styles.tabActive]}
          onPress={() => onTabChange("voice_notes")}
        >
          <Text
            style={[
              styles.tabText,
              activeTab === "voice_notes" && styles.tabTextActive,
            ]}
          >
            Voice Notes
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tab, activeTab === "recordings" && styles.tabActive]}
          onPress={() => onTabChange("recordings")}
        >
          <Text
            style={[
              styles.tabText,
              activeTab === "recordings" && styles.tabTextActive,
            ]}
          >
            Recordings
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      padding: 16,
    },
    topRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 20,
    },
    statsRow: {
      flexDirection: "row",
      gap: 24,
      flex: 1,
    },
    menuButton: {
      width: 40,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
      marginRight: -8,
    },
    stat: {
      alignItems: "center",
    },
    statCount: {
      color: colors.text.primary,
      fontSize: 18,
      fontWeight: "700",
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
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    displayName: {
      color: colors.text.primary,
      fontSize: 20,
      fontWeight: "700",
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
      alignItems: "center",
    },
    followingButton: {
      backgroundColor: "transparent",
      borderWidth: 1,
      borderColor: colors.background.border,
    },
    followText: {
      color: colors.text.primary,
      fontSize: 15,
      fontWeight: "700",
    },
    followingText: {
      color: colors.text.secondary,
      fontWeight: "600",
    },
    blockedButton: {
      marginTop: 12,
      backgroundColor: "transparent",
      borderWidth: 1,
      borderColor: colors.background.border,
      paddingVertical: 8,
      borderRadius: 20,
      alignItems: "center",
    },
    blockedText: {
      color: colors.text.secondary,
      fontSize: 15,
      fontWeight: "700",
    },
    tabRow: {
      flexDirection: "row",
      marginTop: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
    },
    tab: {
      flex: 1,
      alignItems: "center",
      paddingVertical: 12,
      borderBottomWidth: 2,
      borderBottomColor: "transparent",
    },
    tabActive: {
      borderBottomColor: colors.purple,
    },
    tabText: {
      color: colors.text.secondary,
      fontSize: 15,
      fontWeight: "600",
    },
    tabTextActive: {
      color: colors.text.primary,
    },
  }));
