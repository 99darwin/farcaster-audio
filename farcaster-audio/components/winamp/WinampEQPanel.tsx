import { View, Text, StyleSheet } from 'react-native';
import { EmojiReactionPanel } from '@/components/spaces/EmojiReactionPanel';
import { WINAMP, PANEL_MARGIN } from './winampTheme';

interface WinampEQPanelProps {
  onReaction: (key: string) => void;
}

export function WinampEQPanel({ onReaction }: WinampEQPanelProps) {
  return (
    <View style={styles.container}>
      {/* Mini title bar */}
      <View style={styles.titleBar}>
        <Text style={styles.titleText}>EQUALIZER — REACTIONS</Text>
      </View>
      <View style={styles.panel}>
        <EmojiReactionPanel onReaction={onReaction} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: PANEL_MARGIN,
    borderWidth: 2,
    borderTopColor: WINAMP.bevel.dark,
    borderLeftColor: WINAMP.bevel.dark,
    borderBottomColor: WINAMP.bevel.mid,
    borderRightColor: WINAMP.bevel.mid,
    backgroundColor: WINAMP.chrome,
  },
  titleBar: {
    backgroundColor: WINAMP.titleBar,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: WINAMP.titleBarDark,
  },
  titleText: {
    fontFamily: WINAMP.fonts.pixel,
    fontSize: 6,
    color: '#ffffff',
    textAlign: 'center',
    letterSpacing: 1,
  },
  panel: {
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
});
