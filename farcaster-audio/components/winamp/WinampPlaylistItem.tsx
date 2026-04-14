import React, { memo } from "react";
import { Pressable, Text, View, Image, StyleSheet } from "react-native";
import { WINAMP } from "./winampTheme";
import type { Participant } from "@/types/space";

const AVATAR_SIZE = 24;

interface WinampPlaylistItemProps {
  participant: Participant;
  index: number;
  isHost: boolean;
  onPress: (participant: Participant) => void;
}

export const WinampPlaylistItem = memo(function WinampPlaylistItem({
  participant,
  index,
  isHost,
  onPress,
}: WinampPlaylistItemProps) {
  const isSpeaking = participant.is_speaking;
  const isSpeakerRole =
    participant.role === "host" ||
    participant.role === "co_host" ||
    participant.role === "speaker";
  const isMutedSpeaker = participant.is_muted && isSpeakerRole;
  const isEven = index % 2 === 0;

  const getTextColor = () => {
    if (isSpeaking) return WINAMP.playlist.speaking;
    if (isHost) return WINAMP.playlist.host;
    if (participant.role === "co_host") return WINAMP.accent.purple;
    if (participant.role === "speaker") return WINAMP.playlist.current;
    return WINAMP.playlist.text;
  };

  const getGlow = () => {
    if (isSpeaking) return WINAMP.playlist.speakingGlow;
    if (isHost) return WINAMP.playlist.hostGlow;
    return "transparent";
  };

  const getBorderColor = () => {
    if (isSpeaking) return WINAMP.accent.cyan;
    if (isHost) return WINAMP.playlist.host;
    if (participant.role === "co_host") return WINAMP.accent.purple;
    return WINAMP.bevel.dark;
  };

  const roleTag = isHost
    ? "HOST"
    : participant.role === "co_host"
      ? "CO"
      : participant.role === "speaker"
        ? "SPK"
        : "";

  const suffix = isMutedSpeaker ? "MUTED" : isSpeaking ? "LIVE" : "";
  const numStr = String(index + 1).padStart(2, "0");
  const initial = (participant.display_name || "?")[0].toUpperCase();

  return (
    <Pressable
      onPress={() => onPress(participant)}
      hitSlop={{ top: 5, bottom: 5 }}
      style={[
        styles.container,
        isEven && styles.containerAlt,
        isSpeaking && styles.containerSpeaking,
      ]}
      accessibilityLabel={`${participant.display_name}, ${participant.role}`}
      accessibilityRole="button"
    >
      {/* Speaking indicator bar */}
      {isSpeaking && <View style={styles.speakingBar} />}

      {/* Track number */}
      <Text style={[styles.num, { color: getTextColor() }]}>{numStr}.</Text>

      {/* Avatar */}
      <View style={[styles.avatarWrap, { borderColor: getBorderColor() }]}>
        {participant.pfp_url ? (
          <Image source={{ uri: participant.pfp_url }} style={styles.avatar} />
        ) : (
          <View style={styles.avatarFallback}>
            <Text style={[styles.avatarInitial, { color: getTextColor() }]}>
              {initial}
            </Text>
          </View>
        )}
        {/* Speaking pulse ring */}
        {isSpeaking && <View style={styles.speakingRing} />}
      </View>

      {/* Role badge */}
      {roleTag !== "" && (
        <View style={[styles.roleBadge, isHost && styles.roleBadgeHost]}>
          <Text
            style={[styles.roleBadgeText, isHost && styles.roleBadgeTextHost]}
          >
            {roleTag}
          </Text>
        </View>
      )}

      {/* Name */}
      <Text
        style={[
          styles.name,
          { color: getTextColor(), textShadowColor: getGlow() },
        ]}
        numberOfLines={1}
      >
        {participant.display_name}
      </Text>

      {/* Right side — status */}
      {suffix !== "" && (
        <Text
          style={[
            styles.suffix,
            isSpeaking && styles.suffixLive,
            isMutedSpeaker && styles.suffixMuted,
          ]}
        >
          {suffix}
        </Text>
      )}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 4,
    paddingHorizontal: 6,
    minHeight: 34,
    gap: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(75, 40, 120, 0.15)",
    position: "relative",
  },
  containerAlt: {
    backgroundColor: "rgba(75, 40, 120, 0.06)",
  },
  containerSpeaking: {
    backgroundColor: "rgba(0, 229, 255, 0.04)",
  },
  num: {
    fontFamily: WINAMP.fonts.pixel,
    fontSize: 7,
    width: 20,
  },
  // Avatar
  avatarWrap: {
    width: AVATAR_SIZE + 2,
    height: AVATAR_SIZE + 2,
    borderRadius: 2,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: 1,
  },
  avatarFallback: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: 1,
    backgroundColor: WINAMP.bevel.face,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarInitial: {
    fontFamily: WINAMP.fonts.pixel,
    fontSize: 8,
  },
  speakingRing: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 2,
    borderWidth: 1,
    borderColor: WINAMP.accent.cyan,
    shadowColor: WINAMP.accent.cyan,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 6,
  },
  // Role badge
  roleBadge: {
    borderWidth: 1,
    borderColor: WINAMP.bevel.mid,
    paddingHorizontal: 3,
    paddingVertical: 1,
  },
  roleBadgeHost: {
    borderColor: WINAMP.playlist.host,
    backgroundColor: "rgba(255, 107, 53, 0.1)",
  },
  roleBadgeText: {
    fontFamily: WINAMP.fonts.pixel,
    fontSize: 5,
    color: WINAMP.bevel.light,
  },
  roleBadgeTextHost: {
    color: WINAMP.playlist.host,
  },
  // Name
  name: {
    fontFamily: WINAMP.fonts.pixel,
    fontSize: 7,
    flex: 1,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 6,
  },
  // Status
  suffix: {
    fontFamily: WINAMP.fonts.pixel,
    fontSize: 5,
    color: WINAMP.lcd.textDim,
  },
  suffixLive: {
    color: WINAMP.accent.cyan,
    textShadowColor: WINAMP.playlist.speakingGlow,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 4,
  },
  suffixMuted: {
    color: WINAMP.accent.red,
  },
  // Speaking edge bar
  speakingBar: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: WINAMP.accent.cyan,
    shadowColor: WINAMP.accent.cyan,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 4,
  },
});
