import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  Modal,
  ScrollView,
  Pressable,
  Alert,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Avatar } from "@/components/common/Avatar";
import { Button } from "@/components/common/Button";
import { useSpaceStore } from "@/stores/spaceStore";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import * as api from "@/services/api";
import { isSafeImageUrl } from "@/utils/url";
import type { Participant, ParticipantRole } from "@/types/space";

interface HostControlsProps {
  visible: boolean;
  onClose: () => void;
  speakers: Participant[];
  handQueue: number[];
  participants: Participant[];
  onPromote: (fid: number) => void;
  onDemote: (fid: number) => void;
  onMute: (fid: number) => void;
  onKick: (fid: number) => void;
  onBan: (fid: number) => void;
  onEndSpace: () => void;
  onToggleRecording: () => void;
  isRecording: boolean;
  hostFid: number;
}

export function HostControls({
  visible,
  onClose,
  speakers,
  handQueue,
  participants,
  onPromote,
  onDemote,
  onMute,
  onKick,
  onBan,
  onEndSpace,
  onToggleRecording,
  isRecording,
  hostFid,
}: HostControlsProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const [isSyncing, setIsSyncing] = useState(false);

  const syncParticipants = useCallback(async () => {
    const room = useSpaceStore.getState().room;
    if (!room) return;
    setIsSyncing(true);
    try {
      if (room.is_farcaster_native && room.farcaster_room_id) {
        // Farcaster-native: fetch live participant list from upstream so
        // the host sees users who joined via the Farcaster app (they
        // don't go through Juke's join API, so they aren't in the store
        // until explicitly fetched).
        const upstream = await api.fetchFarcasterNativeSpaceParticipants(
          room.farcaster_room_id,
        );
        if (!upstream.length) return;
        const store = useSpaceStore.getState();
        const seenFids = new Set(store.participants.map((p) => p.fid));
        for (const p of upstream) {
          const u = p.user;
          if (!u?.fid) continue;
          const role: ParticipantRole = ((): ParticipantRole => {
            switch (p.role) {
              case "host":
                return "host";
              case "cohost":
                return "co_host";
              case "speaker":
                return "speaker";
              default:
                return "listener";
            }
          })();
          if (seenFids.has(u.fid)) {
            store.updateParticipant(u.fid, {
              role,
              display_name: u.display_name || u.username || `User ${u.fid}`,
              ...(isSafeImageUrl(u.pfp_url) ? { pfp_url: u.pfp_url } : {}),
              hand_raised: !!p.hand_raised,
            });
          } else {
            store.addParticipant({
              fid: u.fid,
              role,
              is_muted: role === "listener",
              is_speaking: false,
              hand_raised: !!p.hand_raised,
              display_name: u.display_name || u.username || `User ${u.fid}`,
              pfp_url: isSafeImageUrl(u.pfp_url) ? u.pfp_url : null,
            });
          }
        }
      } else {
        // Juke-hosted: sync roles + pfps + hand queue from Juke's DB.
        const data = await api.getRoom(room.id);
        const store = useSpaceStore.getState();
        store.setHandQueue(data.hand_queue ?? []);
        for (const p of data.participants) {
          store.updateParticipant(p.fid, { role: p.role, pfp_url: p.pfp_url });
        }
      }
    } catch {
      // best-effort
    } finally {
      setIsSyncing(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void syncParticipants();
  }, [visible, syncParticipants]);

  const listeners = participants.filter((p) => p.role === "listener");
  // Include hand_raised field (Farcaster-native) in addition to the
  // hand queue (Juke-hosted) so the host sees all raised hands.
  const handRaisedParticipants = participants.filter(
    (p) => handQueue.includes(p.fid) || p.hand_raised,
  );

  const confirmEndSpace = () => {
    Alert.alert(
      "End Space",
      "Are you sure you want to end this space for everyone?",
      [
        { text: "Cancel", style: "cancel" },
        { text: "End Space", style: "destructive", onPress: onEndSpace },
      ],
    );
  };

  const handleToggleRecording = () => {
    // TODO(consent): Two-party-consent jurisdictions (several US states, most
    // of the EU) legally require each participant to explicitly opt in before
    // their voice is recorded. Today we only confirm with the host. Before
    // shipping public recordings broadly, add a per-participant consent modal
    // triggered by the ``recording_state`` event so listeners/speakers can
    // leave or be excluded from the egress before capture starts.
    if (isRecording) {
      Alert.alert("Stop Recording", "Stop recording this space?", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Stop Recording",
          style: "destructive",
          onPress: onToggleRecording,
        },
      ]);
      return;
    }
    Alert.alert(
      "Record Space",
      "Audio will be saved for 30 days and appear on your profile.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Start Recording", onPress: onToggleRecording },
      ],
    );
  };

  const confirmKick = (fid: number, name: string) => {
    Alert.alert("Kick Participant", `Remove ${name} from this space?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Kick", style: "destructive", onPress: () => onKick(fid) },
    ]);
  };

  const confirmBan = (fid: number, name: string) => {
    Alert.alert("Ban Participant", `Ban ${name} from this space?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Ban", style: "destructive", onPress: () => onBan(fid) },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />
          <View style={styles.titleRow}>
            <Text style={styles.title}>Host Controls</Text>
            <Pressable
              onPress={() => void syncParticipants()}
              style={styles.refreshButton}
              disabled={isSyncing}
              accessibilityLabel="Refresh participant list"
              accessibilityRole="button"
            >
              <Ionicons
                name="refresh"
                size={20}
                color={
                  isSyncing ? colors.text.placeholder : colors.text.secondary
                }
              />
            </Pressable>
          </View>

          <ScrollView style={styles.scrollContent}>
            {/* Hand Queue */}
            {handRaisedParticipants.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>
                  Raised Hands ({handRaisedParticipants.length})
                </Text>
                {handRaisedParticipants.map((p) => (
                  <View key={p.fid} style={styles.participantRow}>
                    <Avatar
                      pfpUrl={p.pfp_url}
                      displayName={p.display_name}
                      size="sm"
                    />
                    <Text style={styles.participantName}>{p.display_name}</Text>
                    <View style={styles.actions}>
                      <Pressable
                        onPress={() => onPromote(p.fid)}
                        style={styles.iconButton}
                        accessibilityLabel={`Promote ${p.display_name} to speaker`}
                        accessibilityRole="button"
                      >
                        <Ionicons
                          name="checkmark-circle-outline"
                          size={18}
                          color={colors.success}
                        />
                      </Pressable>
                    </View>
                  </View>
                ))}
              </View>
            )}

            {/* Speakers */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>
                Speakers ({speakers.length})
              </Text>
              {speakers.map((s) => (
                <View key={s.fid} style={styles.participantRow}>
                  <Avatar
                    pfpUrl={s.pfp_url}
                    displayName={s.display_name}
                    size="sm"
                  />
                  <Text style={styles.participantName}>
                    {s.display_name} {s.fid === hostFid ? "(Host)" : ""}
                  </Text>
                  {s.fid !== hostFid && (
                    <View style={styles.actions}>
                      <Pressable
                        onPress={() => onMute(s.fid)}
                        style={styles.iconButton}
                        accessibilityLabel={`Mute ${s.display_name}`}
                        accessibilityRole="button"
                      >
                        <Ionicons
                          name="mic-off"
                          size={18}
                          color={colors.text.secondary}
                        />
                      </Pressable>
                      <Pressable
                        onPress={() => onDemote(s.fid)}
                        style={styles.iconButton}
                        accessibilityLabel={`Demote ${s.display_name} to listener`}
                        accessibilityRole="button"
                      >
                        <Ionicons
                          name="arrow-down-circle-outline"
                          size={18}
                          color={colors.text.secondary}
                        />
                      </Pressable>
                    </View>
                  )}
                </View>
              ))}
            </View>

            {/* Listeners */}
            {listeners.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>
                  Listeners ({listeners.length})
                </Text>
                {listeners.map((p) => (
                  <View key={p.fid} style={styles.participantRow}>
                    <Avatar
                      pfpUrl={p.pfp_url}
                      displayName={p.display_name}
                      size="sm"
                    />
                    <Text style={styles.participantName}>{p.display_name}</Text>
                    <View style={styles.actions}>
                      {p.hand_raised && (
                        <Ionicons
                          name="hand-left"
                          size={18}
                          color={colors.accent}
                        />
                      )}
                      <Pressable
                        onPress={() => onPromote(p.fid)}
                        style={styles.iconButton}
                        accessibilityLabel={`Promote ${p.display_name} to speaker`}
                        accessibilityRole="button"
                      >
                        <Ionicons
                          name="arrow-up-circle-outline"
                          size={18}
                          color={colors.success}
                        />
                      </Pressable>
                      <Pressable
                        onPress={() => confirmKick(p.fid, p.display_name)}
                        style={styles.iconButton}
                        accessibilityLabel={`Kick ${p.display_name}`}
                        accessibilityRole="button"
                      >
                        <Ionicons
                          name="remove-circle-outline"
                          size={18}
                          color={colors.error}
                        />
                      </Pressable>
                      <Pressable
                        onPress={() => confirmBan(p.fid, p.display_name)}
                        style={styles.iconButton}
                        accessibilityLabel={`Ban ${p.display_name}`}
                        accessibilityRole="button"
                      >
                        <Ionicons
                          name="ban-outline"
                          size={18}
                          color={colors.error}
                        />
                      </Pressable>
                    </View>
                  </View>
                ))}
              </View>
            )}

            {/* Recording */}
            <View style={styles.section}>
              <Pressable
                onPress={handleToggleRecording}
                style={styles.recordingRow}
                accessibilityRole="button"
                accessibilityLabel={
                  isRecording ? "Stop recording space" : "Record space"
                }
              >
                <View style={styles.recordingIconWrap}>
                  {isRecording ? (
                    <View style={styles.recordingDot} />
                  ) : (
                    <Ionicons
                      name="radio-button-on"
                      size={22}
                      color={colors.error}
                    />
                  )}
                </View>
                <View style={styles.recordingText}>
                  <Text style={styles.recordingTitle}>
                    {isRecording ? "Recording" : "Record Space"}
                  </Text>
                  <Text style={styles.recordingSubtitle}>
                    {isRecording
                      ? "Tap to stop. Recording will save to your profile."
                      : "Saved for 30 days on your profile."}
                  </Text>
                </View>
              </Pressable>
            </View>

            {/* Danger Zone */}
            <View style={[styles.section, styles.dangerSection]}>
              <Button
                title="End Space"
                onPress={confirmEndSpace}
                variant="danger"
                accessibilityLabel="End space for everyone"
              />
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    overlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: colors.background.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      maxHeight: "80%",
      paddingBottom: 40,
    },
    handle: {
      width: 40,
      height: 4,
      backgroundColor: colors.background.subtle,
      borderRadius: 2,
      alignSelf: "center",
      marginTop: 12,
    },
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      marginVertical: 16,
      paddingHorizontal: 16,
    },
    title: {
      color: colors.text.primary,
      fontSize: 20,
      fontWeight: "700",
      flex: 1,
      textAlign: "center",
    },
    refreshButton: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      position: "absolute",
      right: 16,
    },
    scrollContent: { paddingHorizontal: 16 },
    section: { marginBottom: 24 },
    sectionTitle: {
      color: colors.text.secondary,
      fontSize: 13,
      fontWeight: "600",
      textTransform: "uppercase",
      marginBottom: 12,
    },
    participantRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 8,
      minHeight: 44,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
    },
    participantName: { color: colors.text.primary, fontSize: 15, flex: 1 },
    actions: { flexDirection: "row", gap: 4 },
    iconButton: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 22,
    },
    dangerSection: {
      paddingTop: 16,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.background.border,
    },
    recordingRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      minHeight: 56,
    },
    recordingIconWrap: {
      width: 28,
      height: 28,
      alignItems: "center",
      justifyContent: "center",
    },
    recordingDot: {
      width: 14,
      height: 14,
      borderRadius: 7,
      backgroundColor: colors.error,
    },
    recordingText: { flex: 1 },
    recordingTitle: {
      color: colors.text.primary,
      fontSize: 16,
      fontWeight: "600",
    },
    recordingSubtitle: {
      color: colors.text.secondary,
      fontSize: 13,
      marginTop: 2,
    },
  }));
