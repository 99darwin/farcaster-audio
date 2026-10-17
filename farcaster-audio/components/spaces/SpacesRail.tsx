import { useCallback } from "react";
import {
  View,
  ScrollView,
  Pressable,
  Text,
  StyleSheet,
  Linking,
} from "react-native";
import { useRouter } from "expo-router";
import { SpaceAvatar } from "@/components/spaces/SpaceAvatar";
import { FarcasterSpaceAvatar } from "@/components/spaces/FarcasterSpaceAvatar";
import { useLiveSpaces } from "@/hooks/useLiveSpaces";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { mirrorNativeRoom, type FarcasterNativeSpace } from "@/services/api";
import { markSpaceJoinIntent } from "@/utils/spaceJoinIntent";

const farcasterSpaceUrl = (id: string): string =>
  `https://farcaster.xyz/~/spaces/${encodeURIComponent(id)}`;

export function SpacesRail() {
  const router = useRouter();
  const styles = useStyles();
  const { discoverySpaces } = useLiveSpaces();

  const openFarcasterSpace = useCallback(
    async (space: FarcasterNativeSpace) => {
      // Upstream-discovered Farcaster space — Juke has no `Room` row
      // for it yet. Mirror it server-side (idempotent on
      // `farcaster_room_id`) then route to the in-app player. Joining
      // there mints a JFS bearer and connects to Farcaster's LiveKit
      // project directly. Fall back to the canonical web deep-link if
      // the mirror fails (offline, 5xx, etc).
      try {
        const room = await mirrorNativeRoom({
          farcaster_room_id: space.id,
          title: space.title ?? "",
          state: space.state,
          host_fid: space.host.fid,
          host_username: space.host.username ?? null,
          host_display_name: space.host.display_name ?? null,
          host_pfp_url: space.host.pfp_url ?? null,
          started_at: space.started_at ?? null,
          scheduled_at: space.scheduled_at ?? null,
          root_cast_hash: space.root_cast_hash ?? null,
        });
        markSpaceJoinIntent(room.id);
        router.push(`/space/${room.id}`);
      } catch {
        void Linking.openURL(farcasterSpaceUrl(space.id)).catch(() => {});
      }
    },
    [router],
  );

  // Split for the optional Juke-live ↔ scheduled divider, which only makes
  // sense when both buckets contain Juke-hosted rooms (the divider used to
  // separate live from scheduled in the pre-merge world). We preserve the
  // visual divider by walking the merged list and inserting one separator
  // between the last live entry and the first scheduled entry.
  const liveCount = discoverySpaces.filter((item) =>
    item.isFarcasterNative
      ? item.space.state === "live"
      : item.space.status === "active",
  ).length;
  const hasLive = liveCount > 0;
  const hasScheduled = discoverySpaces.length > liveCount;

  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        accessibilityLabel="Live and upcoming spaces"
      >
        <Pressable
          onPress={() => router.push("/space/create")}
          style={styles.createButton}
          accessibilityRole="button"
          accessibilityLabel="Create a space"
        >
          <View style={styles.createCircle}>
            <Text style={styles.createPlus}>+</Text>
          </View>
          <Text style={styles.createLabel}>Start</Text>
        </Pressable>
        {discoverySpaces.map((item, index) => {
          // Insert the live/scheduled divider exactly once, between the
          // last live entry and the first non-live entry.
          const showDivider = index === liveCount && hasLive && hasScheduled;

          if (item.isFarcasterNative) {
            const space = item.space;
            return (
              <View key={`fc-${space.id}`} style={styles.row}>
                {showDivider && <View style={styles.divider} />}
                <FarcasterSpaceAvatar
                  space={space}
                  onPress={() => {
                    void openFarcasterSpace(space);
                  }}
                />
              </View>
            );
          }

          const room = item.space;
          const isScheduled = room.status === "scheduled";
          return (
            <View key={`juke-${room.id}`} style={styles.row}>
              {showDivider && <View style={styles.divider} />}
              <SpaceAvatar
                room={room}
                isScheduled={isScheduled}
                onPress={() => {
                  markSpaceJoinIntent(room.id);
                  router.push(`/space/${room.id}`);
                }}
              />
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
    },
    scrollContent: {
      paddingHorizontal: 16,
      alignItems: "flex-start",
    },
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
    },
    divider: {
      width: 1,
      height: 48,
      backgroundColor: colors.background.border,
      marginHorizontal: 8,
      alignSelf: "center",
    },
    createButton: {
      alignItems: "center",
      width: 72,
    },
    createCircle: {
      width: 64,
      height: 64,
      borderRadius: 32,
      borderWidth: 2,
      borderColor: colors.background.subtle,
      borderStyle: "dashed",
      justifyContent: "center",
      alignItems: "center",
    },
    createPlus: {
      color: colors.text.secondary,
      fontSize: 28,
      lineHeight: 30,
    },
    createLabel: {
      color: colors.text.secondary,
      fontSize: 11,
      marginTop: 4,
    },
  }));
