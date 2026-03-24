import { useState } from 'react';
import { View, Text, TextInput, Switch, StyleSheet, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Button } from '@/components/common/Button';
import { useSpaceStore } from '@/stores/spaceStore';
import { useLiveSpaces } from '@/hooks/useLiveSpaces';
import Toast from 'react-native-toast-message';
import * as api from '@/services/api';

export default function CreateSpaceScreen() {
  const router = useRouter();
  const joinSpace = useSpaceStore((s) => s.joinSpace);
  const { refresh: refreshSpaces } = useLiveSpaces();
  const [title, setTitle] = useState('');
  const [announceCast, setAnnounceCast] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  const handleCreate = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      Alert.alert('Error', 'Please enter a title for your space');
      return;
    }

    setIsCreating(true);
    try {
      const response = await api.createRoom({
        title: trimmedTitle,
        announce_cast: announceCast,
      });

      // Join the space store with host role
      joinSpace(response.room, [], 'host');

      // Refresh the spaces rail so it shows immediately
      refreshSpaces();

      // Navigate to the space
      router.replace(`/space/${response.room.id}`);
    } catch (err: any) {
      Toast.show({
        type: 'error',
        text1: 'Error',
        text2: err.response?.data?.detail || 'Failed to create space',
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.content}>
        <Text style={styles.label}>Space Title</Text>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="What do you want to talk about?"
          placeholderTextColor="#555577"
          maxLength={256}
          autoFocus
          returnKeyType="done"
          accessibilityLabel="Space title"
        />
        <Text style={styles.charCount}>{title.length}/256</Text>

        <View style={styles.optionRow}>
          <View style={styles.optionText}>
            <Text style={styles.optionLabel}>Announce on Farcaster</Text>
            <Text style={styles.optionDescription}>
              Post a cast to let your followers know
            </Text>
          </View>
          <Switch
            value={announceCast}
            onValueChange={setAnnounceCast}
            trackColor={{ false: '#3a3a5a', true: '#D85A30' }}
            thumbColor="#ffffff"
            accessibilityLabel="Announce on Farcaster"
          />
        </View>

        <View style={styles.buttonContainer}>
          <Button
            title="Start Space"
            onPress={handleCreate}
            isLoading={isCreating}
            disabled={!title.trim()}
            size="lg"
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f23',
  },
  content: {
    flex: 1,
    padding: 24,
  },
  label: {
    color: '#8888aa',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#1a1a2e',
    borderRadius: 12,
    padding: 16,
    color: '#ffffff',
    fontSize: 17,
    borderWidth: 1,
    borderColor: '#2a2a4a',
  },
  charCount: {
    color: '#555577',
    fontSize: 12,
    textAlign: 'right',
    marginTop: 4,
  },
  optionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 32,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#2a2a4a',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2a2a4a',
  },
  optionText: {
    flex: 1,
    marginRight: 16,
  },
  optionLabel: {
    color: '#ffffff',
    fontSize: 16,
  },
  optionDescription: {
    color: '#8888aa',
    fontSize: 13,
    marginTop: 2,
  },
  buttonContainer: {
    marginTop: 'auto',
    paddingBottom: 24,
  },
});
