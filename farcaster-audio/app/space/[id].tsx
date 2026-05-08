import { useEffect, useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  Share,
  Image,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Toast from "react-native-toast-message";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSpace } from "@/hooks/useSpace";
import { useSpacePermissions } from "@/hooks/useSpacePermissions";
import { useAuthStore } from "@/stores/authStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useMiniAppStore } from "@/stores/miniappStore";
import { usePrefsStore } from "@/stores/prefsStore";
import { WinampPlayer } from "@/components/winamp/WinampPlayer";
import { SpeakerGrid } from "@/components/spaces/SpeakerGrid";
import { ListenerList } from "@/components/spaces/ListenerList";
import { HandRaiseButton } from "@/components/spaces/HandRaiseButton";
import { HostControls } from "@/components/spaces/HostControls";
import { ParticipantProfileCard } from "@/components/spaces/ParticipantProfileCard";
import { SpaceChat } from "@/components/spaces/SpaceChat";
import { EmojiReactionPanel } from "@/components/spaces/EmojiReactionPanel";
import { EmojiReactionOverlay } from "@/components/spaces/EmojiReactionOverlay";
import { MiniAppPicker } from "@/components/miniapp/MiniAppPicker";
import { RsvpAvatarRow } from "@/components/spaces/RsvpAvatarRow";
import { GlassView } from "@/components/common/GlassView";
import { Button } from "@/components/common/Button";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { AvatarPositionProvider } from "@/contexts/AvatarPositionContext";
import { colors, glass } from "@/constants/theme";
import { buildSpaceUrl } from "@/utils/shareLinks";
import { formatScheduledTime } from "@/utils/formatDate";
import * as api from "@/services/api";
import * as livekitService from "@/services/livekit";
import {
  addScheduledSpaceToNativeCalendar,
  isUpcomingScheduledRoom,
  openScheduledSpaceInGoogleCalendar,
  shareScheduledSpaceCalendar,
} from "@/services/calendar";
import type { Participant, Room } from "@/types/space";

// ─── Scheduled space view (no LiveKit, no participants) ───

function ScheduledSpaceScreen({ room, id }: { room: Room; id: string }) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const insets = useSafeAreaInsets();
  const [isStarting, setIsStarting] = useState(false);
  const [isGoing, setIsGoing] = useState(room.rsvp_summary?.is_going ?? false);
  const [rsvpCount, setRsvpCount] = useState(room.rsvp_summary?.count ?? 0);
  const [rsvpUsers, setRsvpUsers] = useState(room.rsvp_summary?.users ?? []);
  const [isTogglingRsvp, setIsTogglingRsvp] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isAddingToCalendar, setIsAddingToCalendar] = useState(false);
  const isHost = user?.fid === room.host_fid;
  const canAddToCalendar = isUpcomingScheduledRoom(room);

  const handleGoLive = async () => {
    setIsStarting(true);
    try {
      const response = await api.startRoom(id);

      const hostParticipant: Participant = {
        fid: user!.fid,
        role: "host",
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
        response.livekit_ws_url,
        response.livekit_token,
      );
      await livekitService.enableMicrophone();
      useSpaceStore.getState().setConnected(true);
      useSpaceStore.getState().setMuted(false);

      // Force re-render by replacing with same route — the room status in store
      // is now "active", so the parent component will render the live view
      router.replace(`/space/${id}`);
    } catch (err) {
      console.error("[ScheduledSpace] Go live error:", err);
      useSpaceStore.getState().leaveSpace();
      Toast.show({
        type: "error",
        text1: "Error",
        text2: api.getErrorMessage(err),
      });
    } finally {
      setIsStarting(false);
    }
  };

  const handleToggleRsvp = async () => {
    setIsTogglingRsvp(true);
    const wasGoing = isGoing;
    // Optimistic update
    setIsGoing(!wasGoing);
    setRsvpCount((c) => (wasGoing ? c - 1 : c + 1));
    try {
      if (wasGoing) {
        await api.unrsvpRoom(id);
      } else {
        await api.rsvpRoom(id);
      }
    } catch (err) {
      // Rollback
      setIsGoing(wasGoing);
      setRsvpCount((c) => (wasGoing ? c + 1 : c - 1));
      Toast.show({
        type: "error",
        text1: "Error",
        text2: api.getErrorMessage(err),
      });
    } finally {
      setIsTogglingRsvp(false);
    }
  };

  const handleCancel = () => {
    Alert.alert(
      "Cancel Space",
      "Are you sure you want to cancel this scheduled space?",
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Cancel Space",
          style: "destructive",
          onPress: async () => {
            setIsCancelling(true);
            try {
              await api.endRoom(id);
              Toast.show({ type: "info", text1: "Space cancelled" });
              router.back();
            } catch (err) {
              Toast.show({
                type: "error",
                text1: "Error",
                text2: api.getErrorMessage(err),
              });
              setIsCancelling(false);
            }
          },
        },
      ],
    );
  };

  const addToAppleCalendar = async () => {
    setIsAddingToCalendar(true);
    try {
      await addScheduledSpaceToNativeCalendar(room, id);
      Toast.show({
        type: "success",
        text1: "Added to Calendar",
        text2: formatScheduledTime(room.scheduled_at!),
      });
    } catch (err) {
      console.warn("[ScheduledSpace] Calendar add failed, sharing ICS:", err);
      try {
        await shareScheduledSpaceCalendar(room, id);
      } catch (shareErr) {
        Toast.show({
          type: "error",
          text1: "Calendar unavailable",
          text2: api.getErrorMessage(shareErr),
        });
      }
    } finally {
      setIsAddingToCalendar(false);
    }
  };

  const addToGoogleCalendar = async () => {
    setIsAddingToCalendar(true);
    try {
      await openScheduledSpaceInGoogleCalendar(room, id);
    } catch (err) {
      Toast.show({
        type: "error",
        text1: "Calendar unavailable",
        text2: api.getErrorMessage(err),
      });
    } finally {
      setIsAddingToCalendar(false);
    }
  };

  const handleAddToCalendar = () => {
    Alert.alert("Add to calendar", "Choose where to add this space.", [
      { text: "Apple Calendar", onPress: addToAppleCalendar },
      { text: "Google Calendar", onPress: addToGoogleCalendar },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const handleShareScheduledSpace = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Share.share({
      message: `"${room.title}" on Juke — ${room.scheduled_at ? formatScheduledTime(room.scheduled_at) : ""}`,
      url: buildSpaceUrl(id),
    });
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.scheduledContent}>
        {/* Host avatar */}
        <View style={styles.scheduledAvatarWrap}>
          {room.host.pfp_url ? (
            <Image
              source={{ uri: room.host.pfp_url }}
              style={styles.scheduledAvatar}
            />
          ) : (
            <View style={styles.scheduledAvatar}>
              <Text style={styles.scheduledAvatarText}>
                {(room.host.display_name || "?")[0].toUpperCase()}
              </Text>
            </View>
          )}
        </View>

        <Text style={styles.scheduledTitle}>{room.title}</Text>

        <Text style={styles.scheduledHost}>
          Hosted by {room.host.display_name || room.host.username}
        </Text>

        {room.scheduled_at && (
          <View style={styles.scheduledTimeBadge}>
            <Ionicons name="calendar-outline" size={16} color={colors.accent} />
            <Text style={styles.scheduledTimeText}>
              {formatScheduledTime(room.scheduled_at)}
            </Text>
          </View>
        )}

        {rsvpCount > 0 && <RsvpAvatarRow users={rsvpUsers} count={rsvpCount} />}

        {isHost ? (
          <View style={styles.scheduledActions}>
            <Button
              title="Go Live"
              onPress={handleGoLive}
              isLoading={isStarting}
              size="lg"
            />
            <View style={styles.scheduledSecondaryActions}>
              {canAddToCalendar && (
                <Pressable
                  onPress={handleAddToCalendar}
                  disabled={isAddingToCalendar}
                  style={styles.scheduledSecondaryAction}
                  accessibilityRole="button"
                  accessibilityLabel="Add this scheduled space to your calendar"
                  accessibilityState={{
                    disabled: isAddingToCalendar,
                    busy: isAddingToCalendar,
                  }}
                >
                  <Ionicons
                    name="calendar-outline"
                    size={17}
                    color={colors.text.secondary}
                  />
                  <Text style={styles.scheduledSecondaryText}>
                    {isAddingToCalendar ? "Opening..." : "Calendar"}
                  </Text>
                </Pressable>
              )}
              <Pressable
                onPress={handleShareScheduledSpace}
                style={styles.scheduledSecondaryAction}
                accessibilityLabel="Share space"
                accessibilityRole="button"
              >
                <Ionicons
                  name="share-outline"
                  size={17}
                  color={colors.text.secondary}
                />
                <Text style={styles.scheduledSecondaryText}>Share</Text>
              </Pressable>
              <Pressable
                onPress={handleCancel}
                disabled={isCancelling}
                style={styles.scheduledSecondaryAction}
                accessibilityRole="button"
                accessibilityLabel="Cancel this scheduled space"
              >
                <Text style={styles.scheduledSecondaryDangerText}>
                  {isCancelling ? "Cancelling..." : "Cancel"}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.scheduledActions}>
            <Pressable
              onPress={handleToggleRsvp}
              disabled={isTogglingRsvp}
              style={[styles.rsvpBtn, isGoing && styles.rsvpBtnActive]}
              accessibilityRole="button"
              accessibilityLabel={
                isGoing ? "Remove RSVP" : "RSVP to this space"
              }
              accessibilityState={{ selected: isGoing }}
            >
              <View style={styles.rsvpBtnContent}>
                <Text
                  style={[
                    styles.rsvpBtnText,
                    isGoing && styles.rsvpBtnTextActive,
                  ]}
                >
                  {isGoing ? "Going" : "I'm Going"}
                </Text>
                {isGoing && (
                  <Ionicons name="checkmark" size={16} color="#fff" />
                )}
              </View>
            </Pressable>
            <Text style={styles.scheduledWaiting}>
              Waiting for host to start...
            </Text>
            <View style={styles.scheduledSecondaryActions}>
              {canAddToCalendar && (
                <Pressable
                  onPress={handleAddToCalendar}
                  disabled={isAddingToCalendar}
                  style={styles.scheduledSecondaryAction}
                  accessibilityRole="button"
                  accessibilityLabel="Add this scheduled space to your calendar"
                  accessibilityState={{
                    disabled: isAddingToCalendar,
                    busy: isAddingToCalendar,
                  }}
                >
                  <Ionicons
                    name="calendar-outline"
                    size={17}
                    color={colors.text.secondary}
                  />
                  <Text style={styles.scheduledSecondaryText}>
                    {isAddingToCalendar ? "Opening..." : "Calendar"}
                  </Text>
                </Pressable>
              )}
              <Pressable
                onPress={handleShareScheduledSpace}
                style={styles.scheduledSecondaryAction}
                accessibilityLabel="Share space"
                accessibilityRole="button"
              >
                <Ionicons
                  name="share-outline"
                  size={17}
                  color={colors.text.secondary}
                />
                <Text style={styles.scheduledSecondaryText}>Share</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>

      <Pressable
        onPress={() => router.back()}
        style={[styles.scheduledBackBtn, { bottom: insets.bottom + 24 }]}
      >
        <Text style={styles.scheduledBackText}>Back</Text>
      </Pressable>
    </View>
  );
}

// ─── Main space screen ───

export default function SpaceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const {
    room,
    participants,
    handQueue,
    myRole,
    isConnected,
    isMuted,
    isHandRaised,
    reactions,
    joinRoom,
    leaveRoom,
    toggleMute,
    sendReaction,
    attachListeners,
    setOnRoomEnded,
  } = useSpace();
  const permissions = useSpacePermissions();
  const [isJoining, setIsJoining] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [showHostControls, setShowHostControls] = useState(false);
  const [selectedParticipant, setSelectedParticipant] =
    useState<Participant | null>(null);
  const [activeTab, setActiveTab] = useState<"participants" | "chat">(
    "participants",
  );
  const [isMiniAppPickerVisible, setIsMiniAppPickerVisible] = useState(false);
  const addedMiniApps = useMiniAppStore((s) => s.addedMiniApps);
  const openMiniApp = useMiniAppStore((s) => s.openMiniApp);
  const [scheduledRoom, setScheduledRoom] = useState<Room | null>(null);
  const [chatTargetAttemptedRoomId, setChatTargetAttemptedRoomId] = useState<
    string | null
  >(null);
  const winampMode = usePrefsStore((s) => s.winampMode);
  const insets = useSafeAreaInsets();
  const hasChatTab = !!room?.cast_hash;
  const isEnsuringChatTargetRef = useRef(false);

  // When the host ends the space, LiveKit fires a server-initiated disconnect.
  // Navigate all remaining participants back to the home screen.
  useEffect(() => {
    setOnRoomEnded(() => {
      Toast.show({
        type: "info",
        text1: "Space ended",
        text2: "The host ended this space",
      });
      router.replace("/");
    });
  }, [setOnRoomEnded, router]);

  useEffect(() => {
    if (!id) return;
    if (room?.id === id) {
      // Room already in store (came from create) — just attach LiveKit listeners
      attachListeners();
      return;
    }

    // Fetch room info first to check if it's scheduled
    setIsJoining(true);
    api
      .getRoom(id)
      .then((detail) => {
        if (detail.room.status === "scheduled") {
          setScheduledRoom(detail.room);
          setIsJoining(false);
          return;
        }
        // Active room — join normally
        return joinRoom(id).catch((err) => {
          Toast.show({
            type: "error",
            text1: "Error",
            text2: err.response?.data?.detail || "Failed to join space",
          });
          router.back();
        });
      })
      .catch((err) => {
        Toast.show({
          type: "error",
          text1: "Error",
          text2: api.getErrorMessage(err),
        });
        router.back();
      })
      .finally(() => setIsJoining(false));
  }, [id]);

  useEffect(() => {
    if (
      !id ||
      !room ||
      room.status !== "active" ||
      room.cast_hash ||
      chatTargetAttemptedRoomId === room.id ||
      isEnsuringChatTargetRef.current
    ) {
      return;
    }

    isEnsuringChatTargetRef.current = true;
    setChatTargetAttemptedRoomId(room.id);
    api
      .ensureRoomChatTarget(room.id)
      .then((updatedRoom) => {
        useSpaceStore.getState().setRoom(updatedRoom);
      })
      .catch(() => {
        Toast.show({
          type: "error",
          text1: "Couldn't start chat for this space.",
        });
      })
      .finally(() => {
        isEnsuringChatTargetRef.current = false;
      });
  }, [id, room, chatTargetAttemptedRoomId]);

  const handleLeave = useCallback(async () => {
    if (!id) return;
    setIsLeaving(true);
    router.replace("/");
    await leaveRoom(id);
  }, [id, leaveRoom, router]);

  const handleRaiseHand = useCallback(async () => {
    if (!id) return;
    try {
      const newState = !isHandRaised;
      await api.raiseHand(id, { raised: newState });
      useSpaceStore.getState().setHandRaised(newState);
    } catch (err) {
      console.error("Failed to raise hand:", err);
    }
  }, [id, isHandRaised]);

  const handlePromote = useCallback(
    async (fid: number) => {
      if (!id) return;
      useSpaceStore
        .getState()
        .updateParticipant(fid, { role: "speaker", is_muted: false });
      try {
        await api.promoteParticipant(id, fid);
      } catch (err) {
        useSpaceStore
          .getState()
          .updateParticipant(fid, { role: "listener", is_muted: true });
        Toast.show({
          type: "error",
          text1: "Error",
          text2: "Failed to promote participant",
        });
      }
    },
    [id],
  );

  const handleDemote = useCallback(
    async (fid: number) => {
      if (!id) return;
      useSpaceStore
        .getState()
        .updateParticipant(fid, { role: "listener", is_muted: true });
      try {
        await api.demoteParticipant(id, fid);
      } catch (err) {
        useSpaceStore.getState().updateParticipant(fid, { role: "speaker" });
        Toast.show({
          type: "error",
          text1: "Error",
          text2: "Failed to demote participant",
        });
      }
    },
    [id],
  );

  const handleMute = useCallback(
    async (fid: number) => {
      if (!id) return;
      try {
        await api.muteParticipant(id, fid);
      } catch (err) {
        Toast.show({
          type: "error",
          text1: "Error",
          text2: "Failed to mute participant",
        });
      }
    },
    [id],
  );

  const handleKick = useCallback(
    async (fid: number) => {
      if (!id) return;
      try {
        await api.kickParticipant(id, fid);
      } catch (err) {
        Toast.show({
          type: "error",
          text1: "Error",
          text2: "Failed to kick participant",
        });
      }
    },
    [id],
  );

  const handleBan = useCallback(
    async (fid: number) => {
      if (!id) return;
      try {
        await api.banParticipant(id, fid, { reason: "Removed by host" });
      } catch (err) {
        Toast.show({
          type: "error",
          text1: "Error",
          text2: "Failed to ban participant",
        });
      }
    },
    [id],
  );

  const handleEndSpace = useCallback(async () => {
    if (!id) return;
    try {
      await api.endRoom(id);
      router.replace("/");
      await leaveRoom(id);
    } catch (err) {
      Toast.show({
        type: "error",
        text1: "Error",
        text2: "Failed to end space",
      });
    }
  }, [id, router, leaveRoom]);

  const isRecording = useSpaceStore((s) => s.isRecording);

  const handleToggleRecording = useCallback(async () => {
    if (!id) return;
    // Optimistic update so the host's UI feels responsive.
    const prev = useSpaceStore.getState().isRecording;
    useSpaceStore.getState().setRecording(!prev);
    try {
      if (prev) {
        await api.stopRecording(id);
      } else {
        await api.startRecording(id);
      }
    } catch (err) {
      useSpaceStore.getState().setRecording(prev);
      Toast.show({
        type: "error",
        text1: "Error",
        text2: api.getErrorMessage(err),
      });
    }
  }, [id]);

  // Show scheduled space view
  if (scheduledRoom && id) {
    return <ScheduledSpaceScreen room={scheduledRoom} id={id} />;
  }

  if (isLeaving || isJoining || !room) {
    return <LoadingSpinner fullScreen />;
  }

  const speakers = participants.filter(
    (p) => p.role === "host" || p.role === "co_host" || p.role === "speaker",
  );
  const listeners = participants.filter((p) => p.role === "listener");

  // ─── Shared modals (used by both views) ───
  const modals = (
    <>
      <EmojiReactionOverlay reactions={reactions} />
      <ParticipantProfileCard
        participant={selectedParticipant}
        visible={!!selectedParticipant}
        onClose={() => setSelectedParticipant(null)}
      />
      <HostControls
        visible={showHostControls}
        onClose={() => setShowHostControls(false)}
        speakers={speakers}
        handQueue={handQueue}
        participants={participants}
        onPromote={handlePromote}
        onDemote={handleDemote}
        onMute={handleMute}
        onKick={handleKick}
        onBan={handleBan}
        onEndSpace={handleEndSpace}
        onToggleRecording={handleToggleRecording}
        isRecording={isRecording}
        hostFid={room.host_fid}
      />
      <MiniAppPicker
        visible={isMiniAppPickerVisible}
        onClose={() => setIsMiniAppPickerVisible(false)}
        addedMiniApps={addedMiniApps}
        onSelectMiniApp={(miniApp) => {
          setIsMiniAppPickerVisible(false);
          openMiniApp({
            url: miniApp.config.homeUrl,
            domain: miniApp.domain,
            manifest: null,
            config: miniApp.config,
            location: { type: "launcher" },
          });
        }}
      />
    </>
  );

  // ─── Winamp mode ───
  if (winampMode) {
    return (
      <AvatarPositionProvider>
        <WinampPlayer
          room={room}
          participants={participants}
          speakers={speakers}
          listeners={listeners}
          myRole={myRole}
          isMuted={isMuted}
          isConnected={isConnected}
          isHandRaised={isHandRaised}
          permissions={permissions}
          reactions={reactions}
          onToggleMute={toggleMute}
          onLeave={handleLeave}
          onRaiseHand={handleRaiseHand}
          onSendReaction={sendReaction}
          onParticipantPress={setSelectedParticipant}
          onOpenHostControls={() => setShowHostControls(true)}
          onShare={() =>
            Share.share({
              message: `Join "${room.title}" on Juke`,
              url: buildSpaceUrl(id),
            })
          }
        />
        {modals}
      </AvatarPositionProvider>
    );
  }

  // ─── Standard mode ───
  return (
    <AvatarPositionProvider>
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            style={styles.backBtn}
            accessibilityLabel="Go back"
          >
            <Ionicons
              name="chevron-back"
              size={24}
              color={colors.text.primary}
            />
          </Pressable>
          <View style={styles.headerText}>
            <Text style={styles.title}>{room.title}</Text>
            <View style={styles.statusRow}>
              <View style={styles.liveDot} />
              <Text style={styles.statusText}>Live</Text>
              <Text style={styles.listenerCount}>
                {participants.length}{" "}
                {participants.length === 1 ? "person" : "people"}
              </Text>
              {isRecording && (
                <View
                  style={styles.recBadge}
                  accessibilityLabel="This space is being recorded"
                >
                  <View style={styles.recDot} />
                  <Text style={styles.recText}>REC</Text>
                </View>
              )}
            </View>
            {!isConnected && (
              <Text style={styles.reconnecting}>Reconnecting...</Text>
            )}
          </View>
        </View>

        {hasChatTab && (
          <View style={styles.tabBar}>
            <Pressable
              style={[
                styles.tab,
                activeTab === "participants" && styles.tabActive,
              ]}
              onPress={() => setActiveTab("participants")}
              accessibilityRole="tab"
              accessibilityState={{ selected: activeTab === "participants" }}
            >
              <Ionicons
                name={
                  activeTab === "participants" ? "people" : "people-outline"
                }
                size={18}
                color={
                  activeTab === "participants"
                    ? colors.text.primary
                    : colors.text.secondary
                }
              />
              <Text
                style={[
                  styles.tabText,
                  activeTab === "participants" && styles.tabTextActive,
                ]}
              >
                Participants
              </Text>
            </Pressable>
            <Pressable
              style={[styles.tab, activeTab === "chat" && styles.tabActive]}
              onPress={() => setActiveTab("chat")}
              accessibilityRole="tab"
              accessibilityState={{ selected: activeTab === "chat" }}
            >
              <Ionicons
                name={
                  activeTab === "chat" ? "chatbubble" : "chatbubble-outline"
                }
                size={18}
                color={
                  activeTab === "chat"
                    ? colors.text.primary
                    : colors.text.secondary
                }
              />
              <Text
                style={[
                  styles.tabText,
                  activeTab === "chat" && styles.tabTextActive,
                ]}
              >
                Chat
              </Text>
            </Pressable>
          </View>
        )}

        {activeTab === "participants" || !hasChatTab ? (
          <ScrollView
            style={styles.scrollContent}
            contentContainerStyle={{ paddingBottom: insets.bottom + 80 }}
          >
            <SpeakerGrid
              speakers={speakers}
              hostFid={room.host_fid}
              onParticipantPress={setSelectedParticipant}
            />
            <ListenerList
              listeners={listeners}
              onParticipantPress={setSelectedParticipant}
            />
          </ScrollView>
        ) : (
          <SpaceChat
            castHash={room.cast_hash!}
            viewerFid={user!.fid}
            keyboardVerticalOffset={insets.bottom + 96}
            bottomInset={insets.bottom + 84}
          />
        )}

        {(activeTab === "participants" || !hasChatTab) && (
          <View style={[styles.reactionPanel, { bottom: insets.bottom + 92 }]}>
            <EmojiReactionPanel onReaction={sendReaction} />
          </View>
        )}

        <GlassView style={[styles.controls, { bottom: insets.bottom + 12 }]}>
          {permissions.isListener && (
            <HandRaiseButton
              isRaised={isHandRaised}
              onPress={handleRaiseHand}
            />
          )}
          {permissions.canSelfMute && (
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                toggleMute();
              }}
              style={[styles.controlIcon, isMuted && styles.controlIconMuted]}
              accessibilityLabel={
                isMuted ? "Unmute microphone" : "Mute microphone"
              }
              accessibilityRole="button"
            >
              <Ionicons
                name={isMuted ? "mic-off" : "mic"}
                size={24}
                color={colors.text.primary}
              />
            </Pressable>
          )}
          {(permissions.canPromote ||
            permissions.canMuteOthers ||
            permissions.canKick ||
            permissions.canEndRoom) && (
            <Pressable
              onPress={() => setShowHostControls(true)}
              style={styles.controlIcon}
              accessibilityLabel="Host controls"
              accessibilityRole="button"
            >
              <Ionicons
                name="settings-outline"
                size={24}
                color={colors.text.primary}
              />
            </Pressable>
          )}
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setIsMiniAppPickerVisible(true);
            }}
            style={styles.controlIcon}
            accessibilityLabel="Open mini app"
            accessibilityRole="button"
          >
            <Ionicons
              name="apps-outline"
              size={24}
              color={colors.text.primary}
            />
          </Pressable>
          <Pressable
            onPress={() => {
              if (!id || !room) return;
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              Share.share({
                message: `Join "${room.title}" on Juke`,
                url: buildSpaceUrl(id),
              });
            }}
            style={styles.controlIcon}
            accessibilityLabel="Share space"
            accessibilityRole="button"
          >
            <Ionicons
              name="share-outline"
              size={24}
              color={colors.text.primary}
            />
          </Pressable>
          <Pressable
            onPress={handleLeave}
            style={[styles.controlIcon, styles.controlIconLeave]}
            accessibilityLabel="Leave space"
            accessibilityRole="button"
          >
            <Ionicons
              name="exit-outline"
              size={24}
              color={colors.text.primary}
            />
          </Pressable>
        </GlassView>

        {modals}
      </View>
    </AvatarPositionProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background.main },
  // Standard mode header
  header: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.background.border,
  },
  backBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  headerText: { flex: 1 },
  title: { color: colors.text.primary, fontSize: 22, fontWeight: "700" },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.live,
  },
  statusText: { color: colors.error, fontSize: 14, fontWeight: "600" },
  listenerCount: { color: colors.text.secondary, fontSize: 14 },
  reconnecting: { color: colors.warning, fontSize: 13, marginTop: 4 },
  recBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: "rgba(255, 59, 48, 0.15)",
    marginLeft: 4,
  },
  recDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.error,
  },
  recText: {
    color: colors.error,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  tabBar: {
    flexDirection: "row",
    backgroundColor: glass.overlayColor,
    borderBottomWidth: 1,
    borderBottomColor: glass.borderColor,
  },
  tab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: {
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    borderBottomColor: colors.text.primary,
  },
  tabText: { color: colors.text.secondary, fontSize: 14, fontWeight: "500" },
  tabTextActive: { color: colors.text.primary },
  scrollContent: { flex: 1 },
  controls: {
    position: "absolute",
    alignSelf: "center",
    flexDirection: "row",
    justifyContent: "space-evenly",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    gap: 12,
    borderRadius: glass.capsuleRadius,
  },
  controlIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  controlIconMuted: { backgroundColor: glass.mutedOverlay },
  controlIconLeave: { backgroundColor: glass.dangerOverlay },
  reactionPanel: { position: "absolute", alignSelf: "center" },
  // Scheduled space styles
  scheduledContent: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  scheduledAvatarWrap: {
    marginBottom: 24,
  },
  scheduledAvatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.background.surface,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.background.border,
  },
  scheduledAvatarText: {
    color: colors.text.primary,
    fontSize: 28,
    fontWeight: "700",
  },
  scheduledTitle: {
    color: colors.text.primary,
    fontSize: 26,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 8,
  },
  scheduledHost: {
    color: colors.text.secondary,
    fontSize: 16,
    marginBottom: 20,
  },
  scheduledTimeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(216, 90, 48, 0.12)",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    marginBottom: 32,
  },
  scheduledTimeText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "600",
  },
  scheduledActions: {
    width: "100%",
    marginBottom: 16,
  },
  scheduledWaiting: {
    color: colors.text.secondary,
    fontSize: 15,
    marginTop: 14,
    marginBottom: 18,
  },
  scheduledSecondaryActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
    flexWrap: "wrap",
    marginTop: 18,
  },
  scheduledSecondaryAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 6,
  },
  scheduledSecondaryText: {
    color: colors.text.secondary,
    fontSize: 15,
    fontWeight: "600",
  },
  scheduledSecondaryDangerText: {
    color: colors.error,
    fontSize: 15,
    fontWeight: "600",
  },
  scheduledBackBtn: {
    position: "absolute",
    alignSelf: "center",
    minHeight: 44,
    minWidth: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  scheduledBackText: {
    color: colors.text.secondary,
    fontSize: 16,
    fontWeight: "500",
  },
  rsvpBtn: {
    borderWidth: 1.5,
    borderColor: colors.accent,
    borderRadius: 24,
    paddingVertical: 12,
    paddingHorizontal: 32,
    alignItems: "center",
    minHeight: 44,
  },
  rsvpBtnContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  rsvpBtnActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  rsvpBtnText: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: "700",
  },
  rsvpBtnTextActive: {
    color: "#fff",
  },
});
