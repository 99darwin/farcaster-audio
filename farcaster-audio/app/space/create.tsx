import { useState } from 'react';
import { View, Text, TextInput, Switch, StyleSheet, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Button } from '@/components/common/Button';
import { useSpaceStore } from '@/stores/spaceStore';
import { useLiveSpaces } from '@/hooks/useLiveSpaces';
import Toast from 'react-native-toast-message';
import { colors } from '@/constants/theme';
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
    } catch (err) {
      Toast.show({
        type: 'error',
        text1: 'Error',
        text2: api.getErrorMessage(err),
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
          placeholderTextColor={colors.text.placeholder}
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
            trackColor={{ false: colors.background.subtle, true: colors.accent }}
            thumbColor={colors.text.primary}
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
    backgroundColor: colors.background.main,
  },
  content: {
    flex: 1,
    padding: 24,
  },
  label: {
    color: colors.text.secondary,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  input: {
    backgroundColor: colors.background.surface,
    borderRadius: 12,
    padding: 16,
    color: colors.text.primary,
    fontSize: 17,
    borderWidth: 1,
    borderColor: colors.background.border,
  },
  charCount: {
    color: colors.text.placeholder,
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
    borderTopColor: colors.background.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.background.border,
  },
  optionText: {
    flex: 1,
    marginRight: 16,
  },
  optionLabel: {
    color: colors.text.primary,
    fontSize: 16,
  },
  optionDescription: {
    color: colors.text.secondary,
    fontSize: 13,
    marginTop: 2,
  },
  buttonContainer: {
    marginTop: 'auto',
    paddingBottom: 24,
  },
});
