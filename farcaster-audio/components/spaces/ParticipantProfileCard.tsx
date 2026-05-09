import { useEffect, useCallback, useState } from "react";
import {
  View,
  Text,
  Modal,
  Pressable,
  ActivityIndicator,
  Alert,
  StyleSheet,
} from "react-native";
import Toast from "react-native-toast-message";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Avatar } from "@/components/common/Avatar";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { useAuthStore } from "@/stores/authStore";
import * as api from "@/services/api";
import type { NeynarUser } from "@/types/neynar";
import type { Participant } from "@/types/space";

interface ParticipantProfileCardProps {
  participant: Participant | null;
  visible: boolean;
  onClose: () => void;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function ParticipantProfileCard({
  participant,
  visible,
  onClose,
}: ParticipantProfileCardProps) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useStyles();
  const currentUser = useAuthStore((s) => s.user);
  const [user, setUser] = useState<NeynarUser | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isFollowLoading, setIsFollowLoading] = useState(false);

  const isOwnProfile = currentUser?.fid === participant?.fid;

  useEffect(() => {
    if (!visible || !participant) {
      setUser(null);
      return;
    }

    setIsLoading(true);
    api
      .getUserProfile(participant.fid)
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setIsLoading(false));
  }, [visible, participant?.fid]);

  const handleFollowToggle = useCallback(async () => {
    if (!user) return;
    const wasFollowing = user.viewer_context?.following ?? false;

    // Optimistic update
    setUser((prev) =>
      prev
        ? {
            ...prev,
            follower_count: prev.follower_count + (wasFollowing ? -1 : 1),
            viewer_context: {
              ...prev.viewer_context!,
              following: !wasFollowing,
            },
          }
        : null,
    );

    setIsFollowLoading(true);
    try {
      if (wasFollowing) {
        await api.unfollowUser(user.fid);
      } else {
        await api.followUser(user.fid);
      }
    } catch {
      // Rollback
      setUser((prev) =>
        prev
          ? {
              ...prev,
              follower_count: prev.follower_count + (wasFollowing ? 1 : -1),
              viewer_context: {
                ...prev.viewer_context!,
                following: wasFollowing,
              },
            }
          : null,
      );
    } finally {
      setIsFollowLoading(false);
    }
  }, [user]);

  const handleViewProfile = useCallback(() => {
    if (!participant) return;
    onClose();
    router.push(`/profile/${participant.fid}`);
  }, [participant, onClose, router]);

  const handleBlockToggle = useCallback(() => {
    if (!user || isOwnProfile) return;
    const isBlocked = user.viewer_context?.blocked ?? false;
    const applyBlocked = async () => {
      setUser((prev) =>
        prev
          ? {
              ...prev,
              viewer_context: {
                following: false,
                followed_by: false,
                ...prev.viewer_context,
                blocked: true,
              },
            }
          : null,
      );
      try {
        await api.blockUser(user.fid);
        Toast.show({ type: "success", text1: "User blocked" });
      } catch {
        Toast.show({ type: "error", text1: "Failed to block user" });
        setUser((prev) =>
          prev
            ? {
                ...prev,
                viewer_context: {
                  following: false,
                  followed_by: false,
                  ...prev.viewer_context,
                  blocked: false,
                },
              }
            : null,
        );
      }
    };

    if (isBlocked) {
      setUser((prev) =>
        prev
          ? {
              ...prev,
              viewer_context: {
                following: false,
                followed_by: false,
                ...prev.viewer_context,
                blocked: false,
              },
            }
          : null,
      );
      api
        .unblockUser(user.fid)
        .then(() => Toast.show({ type: "success", text1: "User unblocked" }))
        .catch(() => {
          Toast.show({ type: "error", text1: "Failed to unblock user" });
          setUser((prev) =>
            prev
              ? {
                  ...prev,
                  viewer_context: {
                    following: false,
                    followed_by: false,
                    ...prev.viewer_context,
                    blocked: true,
                  },
                }
              : null,
          );
        });
      return;
    }

    Alert.alert(
      "Block user?",
      "They won't be able to join spaces you host, and their content will be hidden from you.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Block", style: "destructive", onPress: applyBlocked },
      ],
    );
  }, [isOwnProfile, user]);

  if (!participant) return null;

  const isFollowing = user?.viewer_context?.following ?? false;
  const isBlocked = user?.viewer_context?.blocked ?? false;
  const bio = user?.profile?.bio?.text;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          {isLoading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator color={colors.purple} size="large" />
            </View>
          ) : (
            <>
              <View style={styles.header}>
                <Avatar
                  pfpUrl={participant.pfp_url}
                  displayName={participant.display_name}
                  size="lg"
                />
                <View style={styles.headerInfo}>
                  <View style={styles.nameRow}>
                    <Text style={styles.displayName} numberOfLines={1}>
                      {user?.display_name ?? participant.display_name}
                    </Text>
                    {user?.pro?.status === "subscribed" && (
                      <Ionicons
                        name="checkmark-circle"
                        size={16}
                        color={colors.purple}
                      />
                    )}
                  </View>
                  {user?.username && (
                    <Text style={styles.username}>@{user.username}</Text>
                  )}
                  <View style={styles.roleBadge}>
                    <Text style={styles.roleText}>{participant.role}</Text>
                  </View>
                </View>
              </View>

              {bio ? (
                <Text style={styles.bio} numberOfLines={3}>
                  {bio}
                </Text>
              ) : null}

              {user && (
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
              )}

              <View style={styles.actions}>
                {!isOwnProfile && user && !isBlocked && (
                  <Pressable
                    style={[
                      styles.followButton,
                      isFollowing && styles.followingButton,
                    ]}
                    onPress={handleFollowToggle}
                    disabled={isFollowLoading}
                  >
                    <Text
                      style={[
                        styles.followText,
                        isFollowing && styles.followingText,
                      ]}
                    >
                      {isFollowing ? "Following" : "Follow"}
                    </Text>
                  </Pressable>
                )}
                {!isOwnProfile && user && (
                  <Pressable
                    style={[
                      styles.blockButton,
                      isBlocked && styles.unblockButton,
                    ]}
                    onPress={handleBlockToggle}
                  >
                    <Text
                      style={[
                        styles.blockText,
                        isBlocked && styles.unblockText,
                      ]}
                    >
                      {isBlocked ? "Unblock" : "Block"}
                    </Text>
                  </Pressable>
                )}
                <Pressable
                  style={styles.profileButton}
                  onPress={handleViewProfile}
                >
                  <Text style={styles.profileButtonText}>View Profile</Text>
                </Pressable>
              </View>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0, 0, 0, 0.6)",
      justifyContent: "center",
      alignItems: "center",
      padding: 32,
    },
    card: {
      backgroundColor: colors.background.surface,
      borderRadius: 16,
      padding: 20,
      width: "100%",
      maxWidth: 340,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.background.border,
    },
    loadingContainer: {
      paddingVertical: 40,
      alignItems: "center",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
    },
    headerInfo: {
      flex: 1,
    },
    nameRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
    },
    displayName: {
      color: colors.text.primary,
      fontSize: 18,
      fontWeight: "700",
      flexShrink: 1,
    },
    username: {
      color: colors.text.secondary,
      fontSize: 14,
      marginTop: 2,
    },
    roleBadge: {
      backgroundColor: colors.background.subtle,
      borderRadius: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
      alignSelf: "flex-start",
      marginTop: 6,
    },
    roleText: {
      color: colors.text.secondary,
      fontSize: 11,
      fontWeight: "600",
      textTransform: "capitalize",
    },
    bio: {
      color: colors.text.body,
      fontSize: 14,
      lineHeight: 20,
      marginTop: 14,
    },
    statsRow: {
      flexDirection: "row",
      gap: 24,
      marginTop: 14,
    },
    stat: {
      alignItems: "center",
    },
    statCount: {
      color: colors.text.primary,
      fontSize: 16,
      fontWeight: "700",
    },
    statLabel: {
      color: colors.text.secondary,
      fontSize: 12,
      marginTop: 2,
    },
    actions: {
      marginTop: 18,
      gap: 10,
    },
    followButton: {
      backgroundColor: colors.purple,
      paddingVertical: 10,
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
    blockButton: {
      paddingVertical: 10,
      borderRadius: 20,
      alignItems: "center",
      borderWidth: 1,
      borderColor: colors.danger,
    },
    unblockButton: {
      borderColor: colors.background.border,
    },
    blockText: {
      color: colors.danger,
      fontSize: 15,
      fontWeight: "700",
    },
    unblockText: {
      color: colors.text.secondary,
    },
    profileButton: {
      paddingVertical: 10,
      borderRadius: 20,
      alignItems: "center",
      borderWidth: 1,
      borderColor: colors.background.border,
    },
    profileButtonText: {
      color: colors.text.primary,
      fontSize: 15,
      fontWeight: "600",
    },
  }));
