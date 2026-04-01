import { View, ScrollView, Pressable, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { SpaceAvatar } from '@/components/spaces/SpaceAvatar';
import { useSpaceStore } from '@/stores/spaceStore';
import { colors } from '@/constants/theme';

export function SpacesRail() {
  const router = useRouter();
  const activeLiveSpaces = useSpaceStore((s) => s.activeLiveSpaces);
  const scheduledSpaces = useSpaceStore((s) => s.scheduledSpaces);

  const hasActive = activeLiveSpaces.length > 0;
  const hasScheduled = scheduledSpaces.length > 0;

  return (
    <View style={styles.container}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scrollContent} accessibilityLabel="Live spaces">
        {activeLiveSpaces.map((room) => (
          <SpaceAvatar
            key={room.id}
            room={room}
            onPress={() => router.push(`/space/${room.id}`)}
          />
        ))}
        {hasActive && hasScheduled && <View style={styles.divider} />}
        {scheduledSpaces.map((room) => (
          <SpaceAvatar
            key={room.id}
            room={room}
            isScheduled
            onPress={() => router.push(`/space/${room.id}`)}
          />
        ))}
        <Pressable onPress={() => router.push('/space/create')} style={styles.createButton} accessibilityRole="button" accessibilityLabel="Create a space">
          <View style={styles.createCircle}>
            <Text style={styles.createPlus}>+</Text>
          </View>
          <Text style={styles.createLabel}>Start</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.background.border,
  },
  scrollContent: {
    paddingHorizontal: 16,
    alignItems: 'flex-start',
  },
  divider: {
    width: 1,
    height: 48,
    backgroundColor: colors.background.border,
    marginHorizontal: 8,
    alignSelf: 'center',
  },
  createButton: {
    alignItems: 'center',
    width: 72,
  },
  createCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 2,
    borderColor: colors.background.subtle,
    borderStyle: 'dashed',
    justifyContent: 'center',
    alignItems: 'center',
  },
  createPlus: {
    color: colors.text.secondary,
    fontSize: 28,
    lineHeight: 30,
  },
  createLabel: {
    color: colors.text.secondary,
    fontSize: 11,
    marginTop: 4,
  },
});
