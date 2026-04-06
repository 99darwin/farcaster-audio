import { View, Text, StyleSheet } from 'react-native';
import { WINAMP, PANEL_MARGIN } from './winampTheme';

interface WinampStatusLineProps {
  participantCount: number;
  isConnected: boolean;
}

export function WinampStatusLine({ participantCount, isConnected }: WinampStatusLineProps) {
  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {/* Pulsing live dot */}
        <View style={styles.liveDotOuter}>
          <View style={[styles.liveDot, !isConnected && styles.liveDotWarn]} />
        </View>
        <Text style={[styles.text, styles.liveText]}>LIVE</Text>
        <View style={styles.divider} />
        <Text style={styles.text}>{participantCount}</Text>
        <Text style={styles.textDim}>ppl</Text>
        <View style={styles.divider} />
        <Text style={styles.text}>48</Text>
        <Text style={styles.textDim}>kbps</Text>
        <View style={styles.divider} />
        <Text style={styles.text}>44</Text>
        <Text style={styles.textDim}>kHz</Text>
        <View style={styles.divider} />
        <Text style={[styles.badge, isConnected ? styles.badgeStereo : styles.badgeMono]}>
          {isConnected ? 'STEREO' : 'MONO'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: WINAMP.lcd.bg,
    borderWidth: 2,
    borderTopColor: WINAMP.bevel.dark,
    borderLeftColor: WINAMP.bevel.dark,
    borderBottomColor: WINAMP.bevel.mid,
    borderRightColor: WINAMP.bevel.mid,
    paddingVertical: 3,
    paddingHorizontal: 6,
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  liveDotOuter: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255, 34, 68, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: WINAMP.accent.red,
    shadowColor: WINAMP.accent.red,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 4,
  },
  liveDotWarn: {
    backgroundColor: '#fbbf24',
    shadowColor: '#fbbf24',
  },
  text: {
    fontFamily: WINAMP.fonts.pixel,
    fontSize: 7,
    color: WINAMP.lcd.text,
  },
  liveText: {
    color: WINAMP.accent.red,
    textShadowColor: 'rgba(255, 34, 68, 0.5)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 4,
  },
  textDim: {
    fontFamily: WINAMP.fonts.pixel,
    fontSize: 6,
    color: WINAMP.lcd.textDim,
  },
  divider: {
    width: 1,
    height: 8,
    backgroundColor: WINAMP.bevel.mid,
  },
  badge: {
    fontFamily: WINAMP.fonts.pixel,
    fontSize: 6,
    paddingHorizontal: 3,
    paddingVertical: 1,
    borderWidth: 1,
  },
  badgeStereo: {
    color: WINAMP.accent.cyan,
    borderColor: WINAMP.accent.cyan,
    textShadowColor: 'rgba(0, 229, 255, 0.4)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 4,
  },
  badgeMono: {
    color: '#fbbf24',
    borderColor: '#fbbf24',
  },
});
