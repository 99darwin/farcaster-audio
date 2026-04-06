import { useCallback } from 'react';
import { View, Text, FlatList, StyleSheet } from 'react-native';
import { WinampPlaylistItem } from './WinampPlaylistItem';
import { WINAMP, PANEL_MARGIN } from './winampTheme';
import type { Participant } from '@/types/space';

interface WinampPlaylistProps {
  participants: Participant[];
  hostFid: number;
  elapsedFormatted: string;
  onParticipantPress: (participant: Participant) => void;
}

const ROLE_ORDER: Record<string, number> = {
  host: 0,
  co_host: 1,
  speaker: 2,
  listener: 3,
};

export function WinampPlaylist({ participants, hostFid, elapsedFormatted, onParticipantPress }: WinampPlaylistProps) {
  const sorted = [...participants].sort(
    (a, b) => (ROLE_ORDER[a.role] ?? 4) - (ROLE_ORDER[b.role] ?? 4),
  );
  const speakerCount = participants.filter(
    (p) => p.role === 'host' || p.role === 'co_host' || p.role === 'speaker',
  ).length;

  const renderItem = useCallback(
    ({ item, index }: { item: Participant; index: number }) => (
      <WinampPlaylistItem
        participant={item}
        index={index}
        isHost={item.fid === hostFid}
        onPress={onParticipantPress}
      />
    ),
    [hostFid, onParticipantPress],
  );

  return (
    <View style={styles.container}>
      {/* Playlist title bar — like Winamp's playlist window */}
      <View style={styles.titleBar}>
        <View style={styles.titleCorner}>
          <View style={styles.cornerDot} />
        </View>
        <View style={styles.titleCenter}>
          <Text style={styles.titleText}>
            JUKE PLAYLIST EDITOR
          </Text>
        </View>
        <View style={styles.titleCorner}>
          <View style={styles.cornerDot} />
        </View>
      </View>

      {/* Column headers */}
      <View style={styles.headerRow}>
        <Text style={styles.headerText}>#</Text>
        <Text style={[styles.headerText, styles.headerName]}>PARTICIPANT</Text>
        <Text style={styles.headerText}>STATUS</Text>
      </View>

      {/* Participant list */}
      <FlatList
        data={sorted}
        keyExtractor={(item) => String(item.fid)}
        renderItem={renderItem}
        style={styles.list}
      />

      {/* Bottom info bar — mimics Winamp's playlist footer */}
      <View style={styles.footerBar}>
        <View style={styles.footerSection}>
          <Text style={styles.footerLabel}>{participants.length} entries</Text>
        </View>
        <View style={styles.footerDivider} />
        <View style={styles.footerSection}>
          <Text style={styles.footerLabel}>{speakerCount} on stage</Text>
        </View>
        <View style={styles.footerDivider} />
        <View style={styles.footerSection}>
          <Text style={styles.footerTime}>{elapsedFormatted}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: WINAMP.playlist.bg,
    borderWidth: 2,
    borderTopColor: WINAMP.bevel.dark,
    borderLeftColor: WINAMP.bevel.dark,
    borderBottomColor: WINAMP.bevel.mid,
    borderRightColor: WINAMP.bevel.mid,
    marginHorizontal: PANEL_MARGIN,
    marginBottom: PANEL_MARGIN,
  },
  titleBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: WINAMP.titleBar,
    borderWidth: 1,
    borderTopColor: WINAMP.titleBarActive,
    borderLeftColor: WINAMP.titleBarActive,
    borderBottomColor: WINAMP.titleBarDark,
    borderRightColor: WINAMP.titleBarDark,
  },
  titleCorner: {
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cornerDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: WINAMP.titleBarDark,
    borderWidth: 1,
    borderTopColor: WINAMP.titleBarActive,
    borderLeftColor: WINAMP.titleBarActive,
    borderBottomColor: WINAMP.titleBarDark,
    borderRightColor: WINAMP.titleBarDark,
  },
  titleCenter: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 2,
  },
  titleText: {
    fontFamily: WINAMP.fonts.pixel,
    fontSize: 7,
    color: '#ffffff',
    letterSpacing: 2,
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 0,
  },
  headerRow: {
    flexDirection: 'row',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderBottomWidth: 1,
    borderBottomColor: WINAMP.bevel.dark,
    backgroundColor: 'rgba(75, 40, 120, 0.08)',
  },
  headerText: {
    fontFamily: WINAMP.fonts.pixel,
    fontSize: 5,
    color: WINAMP.lcd.textDim,
    letterSpacing: 1,
  },
  headerName: {
    flex: 1,
    marginLeft: 26,
  },
  list: {
    flex: 1,
  },
  footerBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: WINAMP.bevel.dark,
    backgroundColor: WINAMP.chrome,
  },
  footerSection: {
    flex: 1,
    paddingVertical: 3,
    paddingHorizontal: 6,
    alignItems: 'center',
  },
  footerDivider: {
    width: 1,
    backgroundColor: WINAMP.bevel.dark,
  },
  footerLabel: {
    fontFamily: WINAMP.fonts.pixel,
    fontSize: 5,
    color: WINAMP.lcd.textDim,
  },
  footerTime: {
    fontFamily: WINAMP.fonts.pixel,
    fontSize: 5,
    color: WINAMP.accent.cyan,
    textShadowColor: 'rgba(0, 229, 255, 0.3)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 3,
  },
});
