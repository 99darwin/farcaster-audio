import { View, Text, StyleSheet } from "react-native";
import { WINAMP } from "./winampTheme";

interface WinampTimeDisplayProps {
  elapsedFormatted: string;
}

export function WinampTimeDisplay({
  elapsedFormatted,
}: WinampTimeDisplayProps) {
  return (
    <View style={styles.container}>
      <View style={styles.display}>
        <Text style={styles.dimText}>88:88:88</Text>
        <Text style={styles.brightText}>{elapsedFormatted}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: WINAMP.lcd.bg,
    borderWidth: 2,
    borderTopColor: WINAMP.bevel.dark,
    borderLeftColor: WINAMP.bevel.dark,
    borderBottomColor: WINAMP.bevel.mid,
    borderRightColor: WINAMP.bevel.mid,
    paddingVertical: 2,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  display: {
    position: "relative",
  },
  dimText: {
    fontFamily: WINAMP.fonts.segment,
    fontSize: 18,
    color: WINAMP.time.textDim,
    letterSpacing: 1,
  },
  brightText: {
    fontFamily: WINAMP.fonts.segment,
    fontSize: 18,
    color: WINAMP.time.text,
    letterSpacing: 1,
    position: "absolute",
    top: 0,
    left: 0,
    textShadowColor: WINAMP.time.glow,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },
});
