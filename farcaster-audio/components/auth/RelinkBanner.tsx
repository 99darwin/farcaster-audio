import { Pressable, Text } from "react-native";
import { useRouter } from "expo-router";
import { useThemedStyles } from "@/hooks/useThemedStyles";

interface RelinkBannerProps {
  topOffset: number;
}

/**
 * Shown app-wide in read-only mode (signer_status != approved): the user can
 * listen and browse, but posting needs the one-time recovery-phrase link.
 */
export function RelinkBanner({ topOffset }: RelinkBannerProps) {
  const styles = useStyles();
  const router = useRouter();

  return (
    <Pressable
      testID="relink-banner"
      onPress={() => router.push("/link-signer")}
      style={[styles.banner, { top: topOffset }]}
      accessibilityRole="button"
      accessibilityLabel="Read-only mode. Link Juke to your Farcaster account to post."
    >
      <Text style={styles.text}>
        Read-only · <Text style={styles.link}>Link Juke to post</Text>
      </Text>
    </Pressable>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    banner: {
      position: "absolute",
      alignSelf: "center",
      paddingVertical: 6,
      paddingHorizontal: 14,
      borderRadius: 16,
      backgroundColor: colors.background.surface,
      borderWidth: 1,
      borderColor: colors.warning,
      zIndex: 10,
    },
    text: { color: colors.text.body, fontSize: 13 },
    link: { color: colors.warning, fontWeight: "700" },
  }));
