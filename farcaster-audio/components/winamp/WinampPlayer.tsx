import { useState, useMemo } from "react";
import { View, Pressable, Text, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { WinampTitleBar } from "./WinampTitleBar";
import { WinampMarquee } from "./WinampMarquee";
import { WinampVisualizer } from "./WinampVisualizer";
import { WinampTimeDisplay } from "./WinampTimeDisplay";
import { WinampStatusLine } from "./WinampStatusLine";
import { WinampTransport } from "./WinampTransport";
import { WinampVolumeSlider } from "./WinampVolumeSlider";
import { WinampPlaylist } from "./WinampPlaylist";
import { WinampEQPanel } from "./WinampEQPanel";
import { WINAMP, PANEL_MARGIN } from "./winampTheme";
import { useElapsedTime } from "@/hooks/useElapsedTime";
import type { Participant, Room } from "@/types/space";

interface WinampPlayerProps {
  room: Room;
  participants: Participant[];
  speakers: Participant[];
  listeners: Participant[];
  myRole: string | null;
  isMuted: boolean;
  isConnected: boolean;
  isHandRaised: boolean;
  permissions: {
    canPromote: boolean;
    canMuteOthers: boolean;
    canKick: boolean;
    canEndRoom: boolean;
    isListener: boolean;
    canSelfMute: boolean;
  };
  reactions: Array<{ key: string; id: number; fid: number }>;
  onToggleMute: () => void;
  onLeave: () => void;
  onRaiseHand: () => void;
  onSendReaction: (key: string) => void;
  onParticipantPress: (participant: Participant) => void;
  onOpenHostControls: () => void;
  onShare: () => void;
}

// Decorative groove separator
function Groove() {
  return (
    <View style={grooveStyles.container}>
      <View style={grooveStyles.dark} />
      <View style={grooveStyles.light} />
    </View>
  );
}

const grooveStyles = StyleSheet.create({
  container: { marginHorizontal: PANEL_MARGIN, marginVertical: 1 },
  dark: { height: 1, backgroundColor: WINAMP.bevel.dark },
  light: { height: 1, backgroundColor: WINAMP.bevel.mid },
});

// Decorative seek bar (always at end = "LIVE")
function SeekBar() {
  return (
    <View style={seekStyles.container}>
      <View style={seekStyles.track}>
        <View style={seekStyles.fill} />
        <View style={seekStyles.liveIndicator}>
          <View style={seekStyles.liveDot} />
        </View>
      </View>
      <Text style={seekStyles.label}>LIVE</Text>
    </View>
  );
}

const seekStyles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: PANEL_MARGIN,
    gap: 4,
  },
  track: {
    flex: 1,
    height: 6,
    backgroundColor: WINAMP.lcd.bg,
    borderWidth: 1,
    borderTopColor: WINAMP.bevel.dark,
    borderLeftColor: WINAMP.bevel.dark,
    borderBottomColor: WINAMP.bevel.mid,
    borderRightColor: WINAMP.bevel.mid,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
  },
  fill: {
    flex: 1,
    height: "100%",
    backgroundColor: "rgba(107, 63, 160, 0.3)",
  },
  liveIndicator: {
    width: 10,
    height: 10,
    marginRight: -1,
    backgroundColor: WINAMP.bevel.face,
    borderWidth: 1,
    borderTopColor: WINAMP.bevel.light,
    borderLeftColor: WINAMP.bevel.light,
    borderBottomColor: WINAMP.bevel.dark,
    borderRightColor: WINAMP.bevel.dark,
    alignItems: "center",
    justifyContent: "center",
  },
  liveDot: {
    width: 3,
    height: 3,
    borderRadius: 2,
    backgroundColor: WINAMP.accent.cyan,
    shadowColor: WINAMP.accent.cyan,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 3,
  },
  label: {
    fontFamily: WINAMP.fonts.pixel,
    fontSize: 5,
    color: WINAMP.accent.cyan,
    width: 22,
    textShadowColor: "rgba(0, 229, 255, 0.4)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 3,
  },
});

// Toggle button (EQ / PL)
function ToggleButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={({ pressed }) => [
        toggleStyles.button,
        active && toggleStyles.buttonActive,
        pressed && toggleStyles.buttonPressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
    >
      <Text style={[toggleStyles.text, active && toggleStyles.textActive]}>
        {label}
      </Text>
      {active && <View style={toggleStyles.indicator} />}
    </Pressable>
  );
}

const toggleStyles = StyleSheet.create({
  button: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: WINAMP.bevel.face,
    borderWidth: 2,
    borderTopColor: WINAMP.bevel.light,
    borderLeftColor: WINAMP.bevel.light,
    borderBottomColor: WINAMP.bevel.dark,
    borderRightColor: WINAMP.bevel.dark,
    minWidth: 30,
    alignItems: "center",
    position: "relative",
  },
  buttonActive: {
    backgroundColor: WINAMP.titleBarDark,
    borderTopColor: WINAMP.bevel.dark,
    borderLeftColor: WINAMP.bevel.dark,
    borderBottomColor: WINAMP.bevel.light,
    borderRightColor: WINAMP.bevel.light,
  },
  buttonPressed: {
    backgroundColor: WINAMP.button.pressed,
  },
  text: {
    fontFamily: WINAMP.fonts.pixel,
    fontSize: 6,
    color: "#7a7a9a",
    letterSpacing: 1,
  },
  textActive: {
    color: WINAMP.accent.cyan,
    textShadowColor: "rgba(0, 229, 255, 0.5)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 4,
  },
  indicator: {
    position: "absolute",
    bottom: 0,
    left: 4,
    right: 4,
    height: 1,
    backgroundColor: WINAMP.accent.cyan,
  },
});

export function WinampPlayer({
  room,
  participants,
  speakers,
  listeners,
  myRole,
  isMuted,
  isConnected,
  isHandRaised,
  permissions,
  reactions,
  onToggleMute,
  onLeave,
  onRaiseHand,
  onSendReaction,
  onParticipantPress,
  onOpenHostControls,
  onShare,
}: WinampPlayerProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [isShaded, setIsShaded] = useState(false);
  const [showEQ, setShowEQ] = useState(false);
  const { formatted: elapsedFormatted } = useElapsedTime(room.started_at);

  const hasHostControls =
    permissions.canPromote ||
    permissions.canMuteOthers ||
    permissions.canKick ||
    permissions.canEndRoom;

  const activeSpeakerCount = useMemo(
    () => participants.filter((p) => p.is_speaking).length,
    [participants],
  );

  const handlePrev = () => {
    if (hasHostControls) {
      onOpenHostControls();
    } else if (permissions.isListener) {
      onRaiseHand();
    }
  };

  // Shaded mode — compact title bar only
  if (isShaded) {
    return (
      <View style={[styles.shell, { paddingTop: insets.top }]}>
        <View style={styles.shellInner}>
          <WinampTitleBar
            onClose={() => router.back()}
            onShade={() => setIsShaded(false)}
            isShaded
          />
          {/* Mini status in shade mode */}
          <View style={styles.shadedInfo}>
            <View style={styles.shadedDot} />
            <Text style={styles.shadedText} numberOfLines={1}>
              {room.title} — {participants.length}ppl
            </Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.shell,
        { paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      {/* Outer chrome panel with border */}
      <View style={styles.shellInner}>
        {/* ═══ MAIN WINDOW ═══ */}
        <WinampTitleBar
          onClose={() => router.back()}
          onShade={() => setIsShaded(true)}
          isShaded={false}
        />

        {/* Marquee */}
        <WinampMarquee
          title={room.title}
          hostName={room.host?.display_name || room.host?.username || "Unknown"}
          listenerCount={listeners.length}
        />

        <Groove />

        {/* Visualizer */}
        <WinampVisualizer
          activeSpeakerCount={activeSpeakerCount}
          isSpeaking={!isMuted && myRole !== "listener"}
        />

        <Groove />

        {/* Time + Status row — side by side like real Winamp */}
        <View style={styles.infoRow}>
          <WinampTimeDisplay elapsedFormatted={elapsedFormatted} />
          <WinampStatusLine
            participantCount={participants.length}
            isConnected={isConnected}
          />
        </View>

        <Groove />

        {/* Seek bar (decorative — always "live") */}
        <SeekBar />

        {/* Transport controls */}
        <WinampTransport
          isMuted={isMuted}
          isListener={permissions.isListener}
          hasHostControls={hasHostControls}
          onToggleMute={onToggleMute}
          onLeave={onLeave}
          onPrev={handlePrev}
          onNext={onShare}
        />

        {/* Volume + toggles row */}
        <View style={styles.controlsRow}>
          <View style={styles.volumeWrap}>
            <WinampVolumeSlider />
          </View>
          <View style={styles.togglesWrap}>
            <ToggleButton
              label="EQ"
              active={showEQ}
              onPress={() => setShowEQ(!showEQ)}
            />
            <ToggleButton label="PL" active={true} onPress={() => {}} />
          </View>
        </View>

        <Groove />

        {/* ═══ EQ PANEL (reactions) ═══ */}
        {showEQ && (
          <>
            <WinampEQPanel onReaction={onSendReaction} />
            <Groove />
          </>
        )}

        {/* ═══ PLAYLIST WINDOW ═══ */}
        <WinampPlaylist
          participants={participants}
          hostFid={room.host_fid}
          elapsedFormatted={elapsedFormatted}
          onParticipantPress={onParticipantPress}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: WINAMP.bg,
  },
  shellInner: {
    flex: 1,
    backgroundColor: WINAMP.chrome,
    marginHorizontal: 2,
    marginBottom: 2,
    borderWidth: 2,
    borderTopColor: WINAMP.bevel.mid,
    borderLeftColor: WINAMP.bevel.mid,
    borderBottomColor: WINAMP.bevel.dark,
    borderRightColor: WINAMP.bevel.dark,
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: 2,
    marginHorizontal: PANEL_MARGIN,
  },
  controlsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: PANEL_MARGIN,
    gap: 6,
    paddingVertical: 2,
  },
  volumeWrap: {
    flex: 1,
  },
  togglesWrap: {
    flexDirection: "row",
    gap: 3,
  },
  // Shaded mode
  shadedInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: WINAMP.lcd.bg,
  },
  shadedDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: WINAMP.accent.red,
    shadowColor: WINAMP.accent.red,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 3,
  },
  shadedText: {
    fontFamily: WINAMP.fonts.pixel,
    fontSize: 7,
    color: WINAMP.lcd.text,
    flex: 1,
  },
});
