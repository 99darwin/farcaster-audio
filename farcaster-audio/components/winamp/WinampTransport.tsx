import React, { memo } from "react";
import { View, Text, Pressable, StyleSheet, Alert } from "react-native";
import * as Haptics from "expo-haptics";
import { WINAMP, PANEL_MARGIN } from "./winampTheme";

interface WinampTransportProps {
  isMuted: boolean;
  isListener: boolean;
  hasHostControls: boolean;
  onToggleMute: () => void;
  onLeave: () => void;
  onPrev: () => void;
  onNext: () => void;
}

function TransportButton({
  icon,
  onPress,
  isActive,
  isDestructive,
  disabled,
  accessibilityLabel,
  wide,
}: {
  icon: string;
  onPress: () => void;
  isActive?: boolean;
  isDestructive?: boolean;
  disabled?: boolean;
  accessibilityLabel: string;
  wide?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        wide && styles.btnWide,
        isActive && styles.btnActive,
        isDestructive && styles.btnDestructive,
        pressed && styles.btnPressed,
        disabled && styles.btnDisabled,
      ]}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
    >
      {/* Inner shadow for depth */}
      <View
        style={[
          styles.btnInner,
          isActive && styles.btnInnerActive,
          isDestructive && styles.btnInnerDestructive,
        ]}
      >
        <Text
          style={[
            styles.btnIcon,
            isActive && styles.btnIconGlow,
            isDestructive && styles.btnIconRed,
            disabled && styles.btnIconDisabled,
          ]}
        >
          {icon}
        </Text>
      </View>
    </Pressable>
  );
}

export const WinampTransport = memo(function WinampTransport({
  isMuted,
  isListener,
  hasHostControls,
  onToggleMute,
  onLeave,
  onPrev,
  onNext,
}: WinampTransportProps) {
  const handleLeave = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    Alert.alert("Leave Space", "Are you sure you want to leave?", [
      { text: "Stay", style: "cancel" },
      { text: "Leave", style: "destructive", onPress: onLeave },
    ]);
  };

  const handleMute = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onToggleMute();
  };

  return (
    <View style={styles.outer}>
      <View style={styles.container}>
        <TransportButton
          icon={"\u23EE"}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onPrev();
          }}
          accessibilityLabel={
            hasHostControls
              ? "Host controls"
              : isListener
                ? "Raise hand"
                : "Previous"
          }
        />
        <TransportButton
          icon={"\u25B6"}
          onPress={handleMute}
          isActive={!isMuted && !isListener}
          disabled={isListener}
          accessibilityLabel="Unmute"
          wide
        />
        <TransportButton
          icon={"\u23F8"}
          onPress={handleMute}
          isActive={isMuted && !isListener}
          disabled={isListener}
          accessibilityLabel="Mute"
          wide
        />
        <TransportButton
          icon={"\u25A0"}
          onPress={handleLeave}
          isDestructive
          accessibilityLabel="Leave space"
        />
        <TransportButton
          icon={"\u23ED"}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onNext();
          }}
          accessibilityLabel="Share space"
        />
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  outer: {
    marginHorizontal: PANEL_MARGIN,
    paddingVertical: 3,
  },
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  btn: {
    width: 46,
    height: 34,
    backgroundColor: WINAMP.bevel.face,
    borderWidth: 2,
    borderTopColor: WINAMP.bevel.light,
    borderLeftColor: WINAMP.bevel.light,
    borderBottomColor: WINAMP.bevel.dark,
    borderRightColor: WINAMP.bevel.dark,
    padding: 2,
  },
  btnWide: {
    width: 54,
  },
  btnActive: {
    backgroundColor: WINAMP.button.highlight,
    borderTopColor: WINAMP.titleBarActive,
    borderLeftColor: WINAMP.titleBarActive,
    borderBottomColor: WINAMP.titleBarDark,
    borderRightColor: WINAMP.titleBarDark,
  },
  btnDestructive: {
    backgroundColor: "#1a0a0a",
    borderBottomColor: "#3a1515",
    borderRightColor: "#3a1515",
  },
  btnPressed: {
    borderTopColor: WINAMP.bevel.dark,
    borderLeftColor: WINAMP.bevel.dark,
    borderBottomColor: WINAMP.bevel.light,
    borderRightColor: WINAMP.bevel.light,
  },
  btnDisabled: {
    opacity: 0.4,
  },
  btnInner: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: WINAMP.button.pressed,
    borderWidth: 1,
    borderTopColor: WINAMP.bevel.dark,
    borderLeftColor: WINAMP.bevel.dark,
    borderBottomColor: WINAMP.bevel.mid,
    borderRightColor: WINAMP.bevel.mid,
  },
  btnInnerActive: {
    backgroundColor: WINAMP.titleBarDark,
    borderTopColor: WINAMP.titleBarDark,
    borderBottomColor: WINAMP.titleBarActive,
  },
  btnInnerDestructive: {
    backgroundColor: "#150808",
  },
  btnIcon: {
    fontSize: 16,
    color: "#aaaacc",
  },
  btnIconGlow: {
    color: "#ffffff",
    textShadowColor: WINAMP.accent.cyan,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 8,
  },
  btnIconRed: {
    color: WINAMP.accent.red,
    textShadowColor: "rgba(255, 34, 68, 0.6)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 6,
  },
  btnIconDisabled: {
    color: "#444466",
  },
});
