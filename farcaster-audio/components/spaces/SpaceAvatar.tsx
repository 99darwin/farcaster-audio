import { Pressable, Text, StyleSheet, View } from 'react-native';
import { Avatar } from '@/components/common/Avatar';
import { colors } from '@/constants/theme';
import type { Room } from '@/types/space';

interface SpaceAvatarProps {
  room: Room;
  onPress: () => void;
}

export function SpaceAvatar({ room, onPress }: SpaceAvatarProps) {
  return (
    <Pressable onPress={onPress} style={styles.container} accessibilityLabel={`${room.title}, ${room.listener_count + room.speaker_count} people`}>
      <Avatar
        pfpUrl={room.host.pfp_url}
        displayName={room.host.display_name}
        size="lg"
        isLive
      />
      <Text style={styles.name} numberOfLines={1}>
        {room.host.display_name.split(' ')[0]}
      </Text>
      <View style={styles.listenerBadge}>
        <Text style={styles.listenerCount}>{room.listener_count + room.speaker_count}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', width: 72, marginRight: 12, position: 'relative' },
  name: { color: colors.text.light, fontSize: 11, marginTop: 4, textAlign: 'center' },
  listenerBadge: {
    position: 'absolute', top: -2, right: 2,
    backgroundColor: colors.accent, borderRadius: 8,
    paddingHorizontal: 4, paddingVertical: 1, minWidth: 16, alignItems: 'center',
  },
  listenerCount: { color: colors.text.primary, fontSize: 10, fontWeight: '700' },
});
