import { View, Text, StyleSheet } from "react-native";
import { Avatar } from "@/components/common/Avatar";
import { colors } from "@/constants/theme";
import type { RsvpUser } from "@/types/space";

interface RsvpAvatarRowProps {
  users: RsvpUser[];
  count: number;
}

export function RsvpAvatarRow({ users, count }: RsvpAvatarRowProps) {
  if (count === 0) return null;

  return (
    <View
      style={styles.container}
      accessibilityRole="summary"
      accessibilityLabel={`${count} ${count === 1 ? "person" : "people"} going to this space`}
    >
      <View style={styles.avatars}>
        {users.slice(0, 5).map((user, i) => (
          <View
            key={user.fid}
            style={[styles.avatarWrap, i > 0 && { marginLeft: -8 }]}
          >
            <Avatar
              pfpUrl={user.pfp_url}
              displayName={user.display_name}
              size="sm"
            />
          </View>
        ))}
      </View>
      <Text style={styles.countText}>
        {count <= 5 ? `${count} going` : `+${count - users.length} more`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  avatars: {
    flexDirection: "row",
    alignItems: "center",
  },
  avatarWrap: {
    borderWidth: 2,
    borderColor: colors.background.main,
    borderRadius: 18,
  },
  countText: {
    color: colors.text.secondary,
    fontSize: 14,
    fontWeight: "500",
  },
});
