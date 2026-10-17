import { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  Switch,
  StyleSheet,
  Alert,
  Keyboard,
  Animated,
} from "react-native";
import { useRouter } from "expo-router";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Button } from "@/components/common/Button";
import { useSpaceStore } from "@/stores/spaceStore";
import { useAuthStore } from "@/stores/authStore";
import { useLiveSpaces } from "@/hooks/useLiveSpaces";
import { useFarcasterAppKey } from "@/hooks/useFarcasterAppKey";
import Toast from "react-native-toast-message";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { formatScheduledTime } from "@/utils/formatDate";
import * as api from "@/services/api";
import * as livekitService from "@/services/livekit";
import { signFarcasterClientBearer } from "@/services/snapSigner";
import { markSpaceJoinIntent } from "@/utils/spaceJoinIntent";

const MIN_SCHEDULE_AHEAD_MS = 5 * 60 * 1000;

export default function CreateSpaceScreen() {
  const router = useRouter();
  const { scheme, colors } = useTheme();
  const styles = useStyles();
  const user = useAuthStore((s) => s.user);
  const { refresh: refreshSpaces } = useLiveSpaces();
  const { ensureApproved: ensureFarcasterAppKey } = useFarcasterAppKey(
    user?.fid ?? 0,
  );
  const [title, setTitle] = useState("");
  const [jukeOnly, setJukeOnly] = useState(false);
  const [announceCast, setAnnounceCast] = useState(false);
  const [isScheduled, setIsScheduled] = useState(false);
  const [scheduledDate, setScheduledDate] = useState(() => {
    const d = new Date();
    d.setHours(d.getHours() + 1, 0, 0, 0);
    return d;
  });
  const [isCreating, setIsCreating] = useState(false);
  const keyboardPadding = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const showSub = Keyboard.addListener("keyboardWillShow", (e) => {
      Animated.timing(keyboardPadding, {
        toValue: e.endCoordinates.height,
        duration: e.duration,
        useNativeDriver: false,
      }).start();
    });
    const hideSub = Keyboard.addListener("keyboardWillHide", (e) => {
      Animated.timing(keyboardPadding, {
        toValue: 0,
        duration: e.duration,
        useNativeDriver: false,
      }).start();
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [keyboardPadding]);

  const handleCreate = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      Alert.alert("Error", "Please enter a title for your space");
      return;
    }

    if (
      isScheduled &&
      scheduledDate.getTime() < Date.now() + MIN_SCHEDULE_AHEAD_MS
    ) {
      Alert.alert(
        "Error",
        "Scheduled time must be at least 5 minutes in the future",
      );
      return;
    }

    setIsCreating(true);
    try {
      // Clean up any stale space state
      const storeState = useSpaceStore.getState();
      if (storeState.room) {
        try {
          await livekitService.disconnectFromRoom();
        } catch {}
        storeState.leaveSpace();
      }

      // Farcaster-native creation path (default).
      //
      // The caller signs a JFS Bearer with their on-device Ed25519 app
      // key and the backend forwards it to `client.farcaster.xyz` —
      // the upstream room is hosted by the caller's FID directly. The
      // app-key gate below ensures the key is approved on-chain before
      // we attempt to sign.
      //
      // Joining is fully in-app: `useSpace.joinRoom` mints a fresh JFS
      // bearer, calls `/v1/rooms/{id}/native-join`, and connects to
      // Farcaster's LiveKit project using the returned ws_url + token.
      if (!jukeOnly) {
        // Gate: native writes require an Ed25519 app key approved on
        // the user's FID. If not yet approved, this opens the Farcaster
        // approval flow and bails — the user retries after the AppState
        // watcher flips status on return.
        const gate = await ensureFarcasterAppKey();
        if (!gate.approved) {
          Toast.show({
            type: "info",
            text1: "Approve Juke on Farcaster",
            text2: gate.approvalUrl
              ? "Then return and tap Create again."
              : "Couldn't open Farcaster — try again.",
          });
          setIsCreating(false);
          return;
        }

        const userBearer = await signFarcasterClientBearer(user!.fid);

        const jukeRoom = await api.createFarcasterNativeRoom({
          title: trimmedTitle,
          user_jfs_bearer: userBearer,
          ...(isScheduled
            ? { scheduled_at: scheduledDate.toISOString() }
            : {}),
        });

        if (isScheduled) {
          Toast.show({
            type: "success",
            text1: "Space scheduled!",
            text2: formatScheduledTime(scheduledDate.toISOString()),
          });
          useSpaceStore.getState().addActiveLiveSpace(jukeRoom);
          refreshSpaces();
          markSpaceJoinIntent(jukeRoom.id);
          router.replace(`/space/${jukeRoom.id}`);
          return;
        }

        // Immediate native room — drop the host straight into the live
        // room screen. `useSpace.joinRoom` signs a fresh JFS bearer and
        // connects to Farcaster's LiveKit project; no app bounce, no
        // service-FID stand-in. Host role is derived from `room.host_fid`.
        useSpaceStore.getState().addActiveLiveSpace(jukeRoom);
        refreshSpaces();
        Toast.show({
          type: "success",
          text1: "Space created",
        });
        markSpaceJoinIntent(jukeRoom.id);
        router.replace(`/space/${jukeRoom.id}`);
        return;
      }

      // Juke-only creation path (existing behavior, behind an opt-out
      // toggle). Kept for the rare user who explicitly wants the
      // Juke-hosted LiveKit experience without a Warpcast mirror.
      const response = await api.createRoom({
        title: trimmedTitle,
        announce_cast: announceCast,
        ...(isScheduled ? { scheduled_at: scheduledDate.toISOString() } : {}),
      });

      if (isScheduled) {
        // Scheduled — no LiveKit connection, navigate to the space detail
        Toast.show({
          type: "success",
          text1: "Space scheduled!",
          text2: formatScheduledTime(scheduledDate.toISOString()),
        });
        refreshSpaces();
        markSpaceJoinIntent(response.room.id);
        router.replace(`/space/${response.room.id}`);
        return;
      }

      // Immediate — connect to LiveKit
      const hostParticipant = {
        fid: user!.fid,
        role: "host" as const,
        is_muted: false,
        is_speaking: false,
        hand_raised: false,
        display_name:
          user!.display_name || user!.username || `User ${user!.fid}`,
        pfp_url: user!.pfp_url ?? null,
      };

      useSpaceStore
        .getState()
        .joinSpace(response.room, [hostParticipant], "host");
      await livekitService.connectToRoom(
        response.livekit_ws_url!,
        response.livekit_token!,
      );
      await livekitService.enableMicrophone();
      useSpaceStore.getState().setConnected(true);
      useSpaceStore.getState().setMuted(false);

      refreshSpaces();
      markSpaceJoinIntent(response.room.id);
      router.replace(`/space/${response.room.id}`);
    } catch (err) {
      console.error("[CreateSpace] Error:", err);
      useSpaceStore.getState().leaveSpace();
      Toast.show({
        type: "error",
        text1: "Error",
        text2: api.getErrorMessage(err),
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Animated.View
      style={[styles.container, { paddingBottom: keyboardPadding }]}
    >
      <View style={styles.content}>
        <Text style={styles.label}>Space Title</Text>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="What do you want to talk about?"
          placeholderTextColor={colors.text.placeholder}
          maxLength={256}
          autoFocus
          returnKeyType="done"
          accessibilityLabel="Space title"
        />
        <Text style={styles.charCount}>{title.length}/256</Text>

        <View style={styles.optionRow}>
          <View style={styles.optionText}>
            <Text style={styles.optionLabel}>Juke-only space</Text>
            <Text style={styles.optionDescription}>
              Skip Farcaster — host on Juke's own audio rooms only
            </Text>
          </View>
          <Switch
            value={jukeOnly}
            onValueChange={setJukeOnly}
            trackColor={{
              false: colors.background.subtle,
              true: colors.accent,
            }}
            thumbColor={colors.text.primary}
            accessibilityLabel="Juke-only space"
          />
        </View>

        {jukeOnly && (
          <View style={styles.optionRow}>
            <View style={styles.optionText}>
              <Text style={styles.optionLabel}>Announce on Farcaster</Text>
              <Text style={styles.optionDescription}>
                Post a cast to let your followers know
              </Text>
            </View>
            <Switch
              value={announceCast}
              onValueChange={setAnnounceCast}
              trackColor={{
                false: colors.background.subtle,
                true: colors.accent,
              }}
              thumbColor={colors.text.primary}
              accessibilityLabel="Announce on Farcaster"
            />
          </View>
        )}

        <View style={styles.optionRow}>
          <View style={styles.optionText}>
            <Text style={styles.optionLabel}>Schedule for later</Text>
            <Text style={styles.optionDescription}>
              Set a date and time to go live
            </Text>
          </View>
          <Switch
            value={isScheduled}
            onValueChange={setIsScheduled}
            trackColor={{
              false: colors.background.subtle,
              true: colors.accent,
            }}
            thumbColor={colors.text.primary}
            accessibilityLabel="Schedule for later"
          />
        </View>

        {isScheduled && (
          <View style={styles.datePickerContainer}>
            <DateTimePicker
              value={scheduledDate}
              mode="datetime"
              display="spinner"
              minimumDate={new Date()}
              onChange={(_event, date) => {
                if (date) setScheduledDate(date);
              }}
              textColor={colors.text.primary}
              themeVariant={scheme}
              style={styles.datePicker}
            />
            <Text style={styles.scheduledLabel}>
              {formatScheduledTime(scheduledDate.toISOString())}
            </Text>
          </View>
        )}

        <View style={styles.buttonContainer}>
          <Button
            title={isScheduled ? "Schedule Space" : "Start Space"}
            onPress={handleCreate}
            isLoading={isCreating}
            disabled={!title.trim()}
            size="lg"
          />
        </View>
      </View>
    </Animated.View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flex: 1,
      backgroundColor: colors.background.main,
    },
    content: {
      flex: 1,
      padding: 24,
    },
    label: {
      color: colors.text.secondary,
      fontSize: 13,
      fontWeight: "600" as const,
      textTransform: "uppercase" as const,
      marginBottom: 8,
    },
    input: {
      backgroundColor: colors.background.surface,
      borderRadius: 12,
      padding: 16,
      color: colors.text.primary,
      fontSize: 17,
      borderWidth: 1,
      borderColor: colors.background.border,
    },
    charCount: {
      color: colors.text.placeholder,
      fontSize: 12,
      textAlign: "right" as const,
      marginTop: 4,
    },
    optionRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginTop: 16,
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.background.border,
    },
    optionText: {
      flex: 1,
      marginRight: 16,
    },
    optionLabel: {
      color: colors.text.primary,
      fontSize: 16,
    },
    optionDescription: {
      color: colors.text.secondary,
      fontSize: 13,
      marginTop: 2,
    },
    datePickerContainer: {
      marginTop: 8,
      alignItems: "center",
    },
    datePicker: {
      width: "100%",
      height: 180,
    },
    scheduledLabel: {
      color: colors.accent,
      fontSize: 15,
      fontWeight: "600" as const,
      marginTop: 4,
    },
    buttonContainer: {
      marginTop: "auto" as const,
      paddingBottom: 24,
    },
  }));
