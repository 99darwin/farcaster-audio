/**
 * Cast-embed renderer for `https://farcaster.xyz/~/spaces/<uuid>` URLs.
 *
 * Behaviour:
 *   - Match the URL via `parseFarcasterSpaceUrl` (the SAME regex used by
 *     the discovery rail's link-then-navigate handler; this is the only
 *     gate between an arbitrary embed URL and the in-Juke navigation
 *     path).
 *   - Lazily resolve the room snapshot via Juke's backend proxy
 *     (`/v1/farcaster-spaces/{id}` → upstream via the service-FID
 *     bearer) so we can show host, title, live state, and listener
 *     count. The legacy `fetchAudioRoom` client-side path required a
 *     Mini-App custody bearer (dead) so every embed went straight to
 *     the missing/fallback branch and rendered blank.
 *   - Tap behavior: mirror the upstream space into a Juke `Room` row
 *     (idempotent on `farcaster_room_id`) and route to the in-app
 *     player. Falls back to a `farcaster.xyz` deep-link if the mirror
 *     fails (offline, 5xx) so the tap never feels broken.
 *   - Loading: skeleton card.
 *   - Error / not-found / no-bearer: return null so the parent renders
 *     the generic `OgPreview` link card instead.
 */

import { useEffect, useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  Linking,
} from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { useThemedStyles } from "@/hooks/useThemedStyles";
import { useTheme } from "@/hooks/useTheme";
import {
  fetchFarcasterNativeSpace,
  mirrorNativeRoom,
  type FarcasterNativeSpace,
} from "@/services/api";
import { markSpaceJoinIntent } from "@/utils/spaceJoinIntent";

interface FarcasterSpaceEmbedCardProps {
  /** Canonical lowercase UUID — pre-validated via `parseFarcasterSpaceUrl`. */
  spaceId: string;
  /** Fallback render when we can't show a Space card (no room data). */
  onFallback?: () => void;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; room: FarcasterNativeSpace }
  | { kind: "missing" };

const farcasterSpaceUrl = (id: string): string =>
  `https://farcaster.xyz/~/spaces/${encodeURIComponent(id)}`;

export function FarcasterSpaceEmbedCard({
  spaceId,
  onFallback,
}: FarcasterSpaceEmbedCardProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  // Stash the latest `onFallback` in a ref so the resolution effect can
  // depend on `spaceId` alone. Parents commonly pass an inline arrow
  // (e.g. `() => setFallback(true)` from `OgPreview`); re-running the
  // backend fetch on every parent render would burn API calls.
  const onFallbackRef = useRef(onFallback);
  useEffect(() => {
    onFallbackRef.current = onFallback;
  }, [onFallback]);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    // `fetchFarcasterNativeSpace` already collapses 4xx/5xx/network
    // failures to `null` (no throws). When it resolves null we hand off
    // to the generic OG link card via the fallback ref.
    fetchFarcasterNativeSpace(spaceId).then((room) => {
      if (cancelled) return;
      if (!room) {
        setState({ kind: "missing" });
        onFallbackRef.current?.();
        return;
      }
      setState({ kind: "ready", room });
    });
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  const handlePress = useCallback(async () => {
    if (state.kind !== "ready") return;
    const room = state.room;
    // Mirror the upstream space into Juke and route to the in-app
    // player. The mirror endpoint is idempotent on `farcaster_room_id`
    // — repeat taps return the same `Room.id`. Fall back to the
    // canonical web deep-link if the mirror fails (offline, 5xx).
    try {
      const jukeRoom = await mirrorNativeRoom({
        farcaster_room_id: room.id,
        title: room.title ?? "",
        state: room.state,
        host_fid: room.host.fid,
        host_username: room.host.username ?? null,
        host_display_name: room.host.display_name ?? null,
        host_pfp_url: room.host.pfp_url ?? null,
        started_at: room.started_at ?? null,
        scheduled_at: room.scheduled_at ?? null,
      });
      markSpaceJoinIntent(jukeRoom.id);
      router.push(`/space/${jukeRoom.id}`);
    } catch {
      try {
        await Linking.openURL(farcasterSpaceUrl(spaceId));
      } catch {
        // Best-effort: any URL-handler error is non-fatal.
      }
    }
  }, [router, spaceId, state]);

  if (state.kind === "loading") {
    return (
      <View
        style={styles.container}
        accessibilityRole="progressbar"
        accessibilityLabel="Loading Farcaster space"
      >
        <View style={styles.avatarSkeleton} />
        <View style={styles.body}>
          <View style={styles.titleSkeleton} />
          <View style={styles.subtitleSkeleton} />
        </View>
        <ActivityIndicator color={colors.text.secondary} />
      </View>
    );
  }

  if (state.kind === "missing") {
    // Parent renders the generic link card via `onFallback`.
    return null;
  }

  const room = state.room;
  const host = room.host;
  const displayName = host.display_name ?? host.username ?? "—";
  const pfpUrl = host.pfp_url;
  const isLive = room.state === "live";
  const listeners = room.listener_count ?? 0;
  const title = room.title?.trim() ?? "Audio space";

  return (
    <Pressable
      onPress={() => {
        void handlePress();
      }}
      style={styles.container}
      accessibilityRole="button"
      accessibilityLabel={`Join ${title} on Farcaster, hosted by ${displayName}`}
    >
      {pfpUrl ? (
        <Image
          source={{ uri: pfpUrl }}
          style={styles.avatar}
          contentFit="cover"
          transition={200}
        />
      ) : (
        <View style={[styles.avatar, styles.avatarFallback]}>
          <Ionicons name="mic" size={20} color={colors.text.secondary} />
        </View>
      )}
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.metaRow}>
          {isLive ? (
            <View style={styles.liveBadge}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>LIVE</Text>
            </View>
          ) : (
            <Text style={styles.scheduledText}>Scheduled</Text>
          )}
          {isLive && listeners > 0 ? (
            <Text style={styles.listenerText}>{listeners} listening</Text>
          ) : null}
          <Text style={styles.hostText} numberOfLines={1}>
            {displayName}
          </Text>
        </View>
      </View>
      <View style={styles.joinButton}>
        <Text style={styles.joinText}>Join</Text>
      </View>
    </Pressable>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      marginTop: 8,
      borderWidth: 1,
      borderColor: colors.background.border,
      borderRadius: 12,
      padding: 12,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 12,
      backgroundColor: "rgba(133, 93, 205, 0.08)",
    },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.background.subtle,
    },
    avatarFallback: {
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    avatarSkeleton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.background.border,
    },
    body: {
      flex: 1,
      gap: 4,
      minWidth: 0,
    },
    titleSkeleton: {
      height: 14,
      width: "70%" as const,
      borderRadius: 4,
      backgroundColor: colors.background.border,
    },
    subtitleSkeleton: {
      height: 12,
      width: "40%" as const,
      borderRadius: 4,
      backgroundColor: colors.background.border,
    },
    title: {
      color: colors.text.primary,
      fontSize: 14,
      fontWeight: "600" as const,
    },
    metaRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
      flexWrap: "wrap" as const,
    },
    liveBadge: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 8,
      backgroundColor: colors.accent,
    },
    liveDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.text.primary,
    },
    liveText: {
      color: colors.text.primary,
      fontSize: 10,
      fontWeight: "700" as const,
      letterSpacing: 0.5,
    },
    scheduledText: {
      color: colors.text.secondary,
      fontSize: 12,
      fontWeight: "600" as const,
    },
    listenerText: {
      color: colors.text.secondary,
      fontSize: 12,
    },
    hostText: {
      color: colors.text.secondary,
      fontSize: 12,
      flexShrink: 1,
    },
    joinButton: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 999,
      backgroundColor: colors.purple,
    },
    joinText: {
      color: colors.text.primary,
      fontSize: 13,
      fontWeight: "700" as const,
    },
  }));
