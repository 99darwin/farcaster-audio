import { View, ScrollView, Pressable, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { SpaceAvatar } from '@/components/spaces/SpaceAvatar';
import { useSpaceStore } from '@/stores/spaceStore';

export function SpacesRail() {
  const router = useRouter();
  const activeLiveSpaces = useSpaceStore((s) => s.activeLiveSpaces);

  if (activeLiveSpaces.length === 0) {
    return (
      <View style={styles.container}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scrollContent} accessibilityLabel="Live spaces">
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
    borderBottomColor: '#2a2a4a',
  },
  scrollContent: {
    paddingHorizontal: 16,
    alignItems: 'flex-start',
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
    borderColor: '#3a3a5a',
    borderStyle: 'dashed',
    justifyContent: 'center',
    alignItems: 'center',
  },
  createPlus: {
    color: '#8888aa',
    fontSize: 28,
    lineHeight: 30,
  },
  createLabel: {
    color: '#8888aa',
    fontSize: 11,
    marginTop: 4,
  },
});
