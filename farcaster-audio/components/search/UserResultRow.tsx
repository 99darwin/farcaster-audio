import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar } from "@/components/common/Avatar";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { spacing, typography } from "@/constants/theme";
import type { UserSearchItem } from "@/services/api";

interface UserResultRowProps {
  user: UserSearchItem;
  onPress?: (user: UserSearchItem) => void;
}

export function UserResultRow({ user, onPress }: UserResultRowProps) {
  const router = useRouter();
  const styles = useStyles();

  const handlePress = () => {
    if (onPress) {
      onPress(user);
      return;
    }
    router.push(`/profile/${user.fid}`);
  };

  const bio = user.bio?.trim() || null;

  return (
    <Pressable
      onPress={handlePress}
      style={styles.row}
      accessibilityRole="button"
      accessibilityLabel={`Open ${user.display_name || user.username}'s profile`}
    >
      <Avatar
        pfpUrl={user.pfp_url}
        displayName={user.display_name || user.username}
        size="md"
      />
      <View style={styles.info}>
        <Text style={styles.displayName} numberOfLines={1}>
          {user.display_name || user.username}
        </Text>
        <Text style={styles.username} numberOfLines={1}>
          @{user.username}
        </Text>
        {bio ? (
          <Text style={styles.bio} numberOfLines={1}>
            {bio}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      gap: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
    },
    info: {
      flex: 1,
      minWidth: 0,
    },
    displayName: {
      color: colors.text.primary,
      fontSize: typography.size.body,
      fontWeight: typography.weight.semibold,
    },
    username: {
      color: colors.text.secondary,
      fontSize: typography.size.sm,
      marginTop: 2,
    },
    bio: {
      color: colors.text.secondary,
      fontSize: typography.size.sm,
      marginTop: 2,
    },
  }));
