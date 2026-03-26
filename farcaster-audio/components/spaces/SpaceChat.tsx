import { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Toast from 'react-native-toast-message';
import { useSpaceChat } from '@/hooks/useSpaceChat';
import { ThreadedReplies } from '@/components/feed/ThreadedReplies';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { publishCast, likeCast, removeLike, recastCast, removeRecast } from '@/services/neynar';
import { colors, glass } from '@/constants/theme';
import type { NeynarCast, NeynarCastWithReplies } from '@/types/neynar';

interface SpaceChatProps {
  castHash: string;
  viewerFid: number;
  keyboardVerticalOffset?: number;
  bottomInset?: number;
}

export function SpaceChat({ castHash, viewerFid, keyboardVerticalOffset = 0, bottomInset = 0 }: SpaceChatProps) {
  const router = useRouter();
  const { rootCast, replies, isLoading, refreshThread } = useSpaceChat(castHash, viewerFid);
  const [text, setText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await refreshThread();
    setIsRefreshing(false);
  }, [refreshThread]);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || isSending) return;
    setIsSending(true);
    try {
      await publishCast(trimmed, castHash);
      setText('');
      await refreshThread();
    } catch {
      Toast.show({ type: 'error', text1: 'Error', text2: 'Failed to send reply' });
    } finally {
      setIsSending(false);
    }
  }, [text, isSending, castHash, refreshThread]);

  const handleLike = useCallback(
    async (hash: string, isLiked: boolean) => {
      try {
        if (isLiked) await removeLike(hash);
        else await likeCast(hash);
        await refreshThread();
      } catch {}
    },
    [refreshThread],
  );

  const handleRecast = useCallback(
    async (hash: string, isRecasted: boolean) => {
      try {
        if (isRecasted) await removeRecast(hash);
        else await recastCast(hash);
        await refreshThread();
      } catch {}
    },
    [refreshThread],
  );

  const handleReply = useCallback((_cast: NeynarCast) => {
    // Focus the compose bar — for space chat we keep replies flat to the root
  }, []);

  const handleQuoteCast = useCallback(
    (cast: NeynarCast) => {
      router.push(`/cast/${cast.hash}`);
    },
    [router],
  );

  const handleCastPress = useCallback(
    (hash: string) => {
      router.push(`/cast/${hash}`);
    },
    [router],
  );

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={keyboardVerticalOffset}
    >
      <FlatList<NeynarCastWithReplies>
        data={replies}
        keyExtractor={(item) => item.hash}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={colors.accent}
          />
        }
        ListHeaderComponent={
          rootCast ? (
            <Pressable onPress={() => router.push(`/cast/${castHash}`)}>
              <View style={styles.threadHeader}>
                <Text style={styles.threadHeaderText} numberOfLines={2}>
                  {rootCast.text}
                </Text>
                <Ionicons name="open-outline" size={14} color={colors.text.secondary} />
              </View>
            </Pressable>
          ) : null
        }
        renderItem={({ item }) => (
          <ThreadedReplies
            replies={[item]}
            maxDepth={1}
            myFid={viewerFid}
            onLike={handleLike}
            onRecast={handleRecast}
            onQuoteCast={handleQuoteCast}
            onReply={handleReply}
            onCastPress={handleCastPress}
          />
        )}
        ListEmptyComponent={
          isLoading ? (
            <LoadingSpinner />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No comments yet — be the first to reply.</Text>
            </View>
          )
        }
        contentContainerStyle={styles.listContent}
      />

      {/* Compose bar */}
      <View style={[styles.composeBar, bottomInset > 0 && { paddingBottom: bottomInset + 8 }]}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Reply to this space..."
          placeholderTextColor={colors.text.secondary}
          multiline
          maxLength={1024}
          editable={!isSending}
        />
        <Pressable
          onPress={handleSend}
          disabled={!text.trim() || isSending}
          style={[styles.sendButton, (!text.trim() || isSending) && styles.sendButtonDisabled]}
          accessibilityLabel="Send reply"
          accessibilityRole="button"
        >
          <Ionicons
            name="send"
            size={20}
            color={!text.trim() || isSending ? colors.text.secondary : colors.accent}
          />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  listContent: { flexGrow: 1 },
  threadHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: glass.borderColor,
    backgroundColor: glass.overlayColor,
  },
  threadHeaderText: {
    flex: 1,
    color: colors.text.secondary,
    fontSize: 13,
  },
  empty: {
    alignItems: 'center',
    paddingTop: 40,
  },
  emptyText: {
    color: colors.text.secondary,
    fontSize: 15,
  },
  composeBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: glass.borderColor,
    backgroundColor: glass.overlayColor,
    gap: 8,
  },
  input: {
    flex: 1,
    color: colors.text.primary,
    fontSize: 15,
    maxHeight: 100,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: glass.borderColor,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
});
