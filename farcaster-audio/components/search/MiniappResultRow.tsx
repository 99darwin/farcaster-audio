import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useMiniAppStore } from "@/stores/miniappStore";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { radii, spacing, typography } from "@/constants/theme";
import { isValidMiniAppUrl } from "@/utils/url";
import type { MiniappResult } from "@/types/api";

interface MiniappResultRowProps {
  miniapp: MiniappResult;
  onPress?: (miniapp: MiniappResult) => void;
}

export function MiniappResultRow({ miniapp, onPress }: MiniappResultRowProps) {
  const styles = useStyles();
  const openMiniApp = useMiniAppStore((s) => s.openMiniApp);

  const handlePress = async () => {
    if (onPress) {
      onPress(miniapp);
      return;
    }
    const url = miniapp.frames_url;
    if (!isValidMiniAppUrl(url)) return;

    try {
      const { resolveMiniApp } = await import("@/services/manifest");
      const resolved = await resolveMiniApp(url);
      if (isValidMiniAppUrl(resolved.launchUrl)) {
        openMiniApp({
          url: resolved.launchUrl,
          domain: resolved.domain,
          manifest: resolved.manifest,
          config: resolved.config,
          location: { type: "launcher" },
        });
        return;
      }
    } catch {
      // fall through to external open
    }
    try {
      await Linking.openURL(url);
    } catch {
      // ignore — nothing we can do if the URL can't be opened
    }
  };

  const authorLabel = miniapp.author?.username
    ? `by @${miniapp.author.username}`
    : miniapp.author?.display_name
      ? `by ${miniapp.author.display_name}`
      : null;

  return (
    <Pressable
      onPress={handlePress}
      style={styles.row}
      accessibilityRole="button"
      accessibilityLabel={`Open miniapp ${miniapp.name}`}
    >
      {miniapp.image_url ? (
        <Image
          source={{ uri: miniapp.image_url }}
          style={styles.thumbnail}
          contentFit="cover"
        />
      ) : (
        <View style={[styles.thumbnail, styles.thumbnailFallback]}>
          <Text style={styles.thumbnailInitial}>
            {miniapp.name?.[0]?.toUpperCase() ?? "?"}
          </Text>
        </View>
      )}
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>
          {miniapp.name}
        </Text>
        {authorLabel ? (
          <Text style={styles.author} numberOfLines={1}>
            {authorLabel}
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
    thumbnail: {
      width: 56,
      height: 56,
      borderRadius: radii.md,
      backgroundColor: colors.background.subtle,
    },
    thumbnailFallback: {
      justifyContent: "center" as const,
      alignItems: "center" as const,
    },
    thumbnailInitial: {
      color: colors.text.primary,
      fontSize: typography.size.lg,
      fontWeight: typography.weight.bold,
    },
    info: {
      flex: 1,
      minWidth: 0,
    },
    name: {
      color: colors.text.primary,
      fontSize: typography.size.body,
      fontWeight: typography.weight.semibold,
    },
    author: {
      color: colors.text.secondary,
      fontSize: typography.size.sm,
      marginTop: 2,
    },
  }));
