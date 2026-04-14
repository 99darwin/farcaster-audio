import { View, Text, Pressable, StyleSheet } from "react-native";
import { WINAMP, PANEL_MARGIN } from "./winampTheme";

interface WinampTitleBarProps {
  onClose: () => void;
  onShade: () => void;
  isShaded: boolean;
}

function Rivet() {
  return (
    <View style={rivetStyles.outer} accessible={false}>
      <View style={rivetStyles.inner} />
    </View>
  );
}

const rivetStyles = StyleSheet.create({
  outer: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#3d2060",
    borderWidth: 1,
    borderTopColor: "#2a1040",
    borderLeftColor: "#2a1040",
    borderBottomColor: "#855DCD",
    borderRightColor: "#855DCD",
    alignItems: "center",
    justifyContent: "center",
  },
  inner: {
    width: 2,
    height: 2,
    borderRadius: 1,
    backgroundColor: "#855DCD",
  },
});

export function WinampTitleBar({
  onClose,
  onShade,
  isShaded,
}: WinampTitleBarProps) {
  return (
    <View style={styles.outer}>
      <View style={styles.container}>
        {/* Close button */}
        <Pressable
          onPress={onClose}
          hitSlop={{ top: 11, bottom: 11, left: 11, right: 11 }}
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
          accessibilityLabel="Close"
          accessibilityRole="button"
        >
          <Text style={styles.btnX}>{"\u2573"}</Text>
        </Pressable>

        {/* Left rivets */}
        <Rivet />

        {/* Title area with grooves */}
        <View style={styles.titleArea}>
          <View style={styles.grooveRow} accessible={false}>
            {Array.from({ length: 5 }).map((_, i) => (
              <View key={i} style={styles.groove} />
            ))}
          </View>
          <Text style={styles.title}>JUKE AUDIO</Text>
          <View style={styles.grooveRow} accessible={false}>
            {Array.from({ length: 5 }).map((_, i) => (
              <View key={i} style={styles.groove} />
            ))}
          </View>
        </View>

        {/* Right rivets */}
        <Rivet />

        {/* Shade button */}
        <Pressable
          onPress={onShade}
          hitSlop={{ top: 11, bottom: 11, left: 11, right: 11 }}
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
          accessibilityLabel={isShaded ? "Expand" : "Minimize"}
          accessibilityRole="button"
        >
          <Text style={styles.btnIcon}>{isShaded ? "\u25B2" : "\u25BC"}</Text>
        </Pressable>
      </View>
      {/* Bottom edge highlight */}
      <View style={styles.bottomEdge} />
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    marginHorizontal: PANEL_MARGIN,
    marginTop: PANEL_MARGIN,
  },
  container: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: WINAMP.titleBar,
    paddingHorizontal: 3,
    paddingVertical: 2,
    gap: 3,
    borderWidth: 2,
    borderTopColor: WINAMP.titleBarActive,
    borderLeftColor: WINAMP.titleBarActive,
    borderBottomColor: WINAMP.titleBarDark,
    borderRightColor: WINAMP.titleBarDark,
  },
  titleArea: {
    flex: 1,
    alignItems: "center",
    gap: 1,
  },
  grooveRow: {
    flexDirection: "row",
    width: "100%",
    gap: 1,
  },
  groove: {
    flex: 1,
    height: 1,
    backgroundColor: WINAMP.titleBarDark,
    marginVertical: 0.5,
  },
  title: {
    fontFamily: WINAMP.fonts.pixel,
    fontSize: 8,
    color: "#ffffff",
    letterSpacing: 3,
    textShadowColor: "rgba(0,0,0,0.8)",
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 0,
  },
  btn: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: WINAMP.bevel.face,
    borderWidth: 2,
    borderTopColor: WINAMP.bevel.light,
    borderLeftColor: WINAMP.bevel.light,
    borderBottomColor: WINAMP.bevel.dark,
    borderRightColor: WINAMP.bevel.dark,
  },
  btnPressed: {
    backgroundColor: WINAMP.button.pressed,
    borderTopColor: WINAMP.bevel.dark,
    borderLeftColor: WINAMP.bevel.dark,
    borderBottomColor: WINAMP.bevel.light,
    borderRightColor: WINAMP.bevel.light,
  },
  btnX: {
    fontSize: 10,
    color: WINAMP.accent.red,
    fontWeight: "900",
  },
  btnIcon: {
    fontSize: 8,
    color: "#cccccc",
  },
  bottomEdge: {
    height: 1,
    backgroundColor: WINAMP.titleBarDark,
  },
});
