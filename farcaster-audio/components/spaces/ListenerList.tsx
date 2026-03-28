import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useState, useCallback } from 'react';
import { Avatar } from '@/components/common/Avatar';
import { useAvatarPosition } from '@/contexts/AvatarPositionContext';
import { colors } from '@/constants/theme';
import type { Participant } from '@/types/space';

interface ListenerListProps {
  listeners: Participant[];
  onParticipantPress?: (participant: Participant) => void;
}

const COLLAPSED_COUNT = 14;

export function ListenerList({ listeners, onParticipantPress }: ListenerListProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { register } = useAvatarPosition();
  const visibleListeners = isExpanded ? listeners : listeners.slice(0, COLLAPSED_COUNT);

  const handleRef = useCallback((fid: number, ref: View | null) => {
    if (ref) register(fid, ref);
  }, [register]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Listeners ({listeners.length})</Text>
      <View style={styles.grid}>
        {visibleListeners.map((listener) => (
          <Pressable
            key={listener.fid}
            ref={(ref) => handleRef(listener.fid, ref)}
            style={styles.listenerItem}
            accessibilityLabel={listener.display_name}
            accessibilityRole="button"
            accessibilityHint="Tap to view profile"
            onPress={() => onParticipantPress?.(listener)}
          >
            <Avatar
              pfpUrl={listener.pfp_url}
              displayName={listener.display_name}
              size="sm"
            />
          </Pressable>
        ))}
      </View>
      {listeners.length > COLLAPSED_COUNT && (
        <Pressable
          onPress={() => setIsExpanded(!isExpanded)}
          style={styles.toggleButton}
          accessibilityLabel={isExpanded ? 'Show fewer listeners' : `Show all ${listeners.length} listeners`}
          accessibilityRole="button"
        >
          <Text style={styles.toggleText}>
            {isExpanded ? 'Show less' : `Show all ${listeners.length}`}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, paddingTop: 0 },
  title: { color: colors.text.secondary, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  listenerItem: { alignItems: 'center' },
  toggleButton: { minHeight: 44, justifyContent: 'center', alignItems: 'center', marginTop: 4 },
  toggleText: { color: colors.accent, fontSize: 14, textAlign: 'center' },
});
