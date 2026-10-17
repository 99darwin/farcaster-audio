import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { SignerLinkFlow } from "@/components/auth/SignerLinkFlow";
import { useAuthStore } from "@/stores/authStore";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import type { FarcasterUserSummary } from "@/services/farcasterLookup";

/**
 * Re-link for a signed-in user whose app signer isn't approved (read-only
 * mode). Runs the recovery-phrase link for the current FID; on approval the
 * fresh session replaces the read-only one.
 */
export default function LinkSignerScreen() {
  const router = useRouter();
  const styles = useStyles();
  const user = useAuthStore((s) => s.user);

  const initialUser = useMemo<FarcasterUserSummary | null>(
    () =>
      user
        ? {
            fid: user.fid,
            username: user.username,
            displayName: user.display_name || null,
            pfpUrl: user.pfp_url,
            custodyAddress: user.custody_address || null,
          }
        : null,
    [user],
  );

  const handleClose = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [router]);

  if (!initialUser) return <Redirect href="/login" />;

  return (
    <View style={styles.container}>
      <SignerLinkFlow
        mode="relink"
        initialUser={initialUser}
        onComplete={handleClose}
        onCancel={handleClose}
      />
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flex: 1,
      backgroundColor: colors.background.main,
      paddingHorizontal: 24,
      paddingTop: 24,
    },
  }));
