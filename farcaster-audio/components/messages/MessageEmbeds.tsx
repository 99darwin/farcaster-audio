/**
 * Images and link previews attached to a message (`metadata.medias` /
 * `metadata.urls`). Only https public URLs render.
 */

import { memo } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { Image } from "expo-image";
import { radii, spacing, typography } from "@/constants/theme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { isSafeImageUrl, isValidMiniAppUrl } from "@/utils/url";
import type { MessageMetadata } from "@/types/messages";

/** Best-effort: a link the OS can't open (no handler) is simply not followed. */
function ignoreUnopenableLink(): void {}

const MAX_MEDIA_WIDTH = 240;
const MAX_MEDIA_HEIGHT = 320;
const LINK_IMAGE_HEIGHT = 120;

interface MessageEmbedsProps {
  metadata: MessageMetadata | null;
}

function fitMedia(width: number, height: number) {
  if (width <= 0 || height <= 0) {
    return { width: MAX_MEDIA_WIDTH, height: MAX_MEDIA_WIDTH };
  }
  const scale = Math.min(MAX_MEDIA_WIDTH / width, MAX_MEDIA_HEIGHT / height, 1);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function MessageEmbedsImpl({ metadata }: MessageEmbedsProps) {
  const styles = useStyles();
  if (!metadata) return null;
  const medias = metadata.medias.filter((m) => isSafeImageUrl(m.url));
  const link = metadata.urls.find((u) => isValidMiniAppUrl(u.url));
  if (medias.length === 0 && !link) return null;

  return (
    <View style={styles.container}>
      {medias.map((media) => (
        <Image
          key={media.url}
          source={{ uri: media.url }}
          style={[styles.media, fitMedia(media.width, media.height)]}
          contentFit="cover"
          accessibilityLabel="Image attachment"
        />
      ))}
      {link ? (
        <Pressable
          onPress={() => void Linking.openURL(link.url).catch(ignoreUnopenableLink)}
          style={({ pressed }) => [styles.link, pressed && styles.pressed]}
          accessibilityRole="link"
          accessibilityLabel={link.title ?? link.url}
        >
          {isSafeImageUrl(link.image_url) ? (
            <Image
              source={{ uri: link.image_url }}
              style={styles.linkImage}
              contentFit="cover"
            />
          ) : null}
          <View style={styles.linkBody}>
            {link.domain ? (
              <Text style={styles.domain} numberOfLines={1}>
                {link.domain}
              </Text>
            ) : null}
            <Text style={styles.title} numberOfLines={2}>
              {link.title ?? link.url}
            </Text>
            {link.description ? (
              <Text style={styles.description} numberOfLines={2}>
                {link.description}
              </Text>
            ) : null}
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}

export const MessageEmbeds = memo(MessageEmbedsImpl);

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: { gap: spacing.xs, marginTop: spacing.xs },
    media: { borderRadius: radii.md, backgroundColor: colors.background.subtle },
    link: {
      width: MAX_MEDIA_WIDTH,
      borderRadius: radii.md,
      overflow: "hidden",
      backgroundColor: colors.background.main,
      borderWidth: 1,
      borderColor: colors.background.border,
    },
    pressed: { opacity: 0.8 },
    linkImage: { width: "100%", height: LINK_IMAGE_HEIGHT },
    linkBody: { padding: spacing.sm, gap: 2 },
    domain: { fontSize: typography.size.sm, color: colors.text.secondary },
    title: {
      fontSize: typography.size.body2,
      fontWeight: typography.weight.semibold,
      color: colors.text.primary,
    },
    description: { fontSize: typography.size.sm, color: colors.text.secondary },
  }));
