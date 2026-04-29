import { useCallback, useEffect, useRef, useState } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  type ListRenderItem,
} from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/constants/theme";
import { haptic } from "@/utils/haptics";
import { searchGifs, type GiphyGif } from "@/services/giphy";

const SEARCH_DEBOUNCE_MS = 250;
const COLUMN_COUNT = 2;

interface GifPickerProps {
  isVisible: boolean;
  onClose: () => void;
  onSelect: (gif: GiphyGif) => void;
}

export function GifPicker({ isVisible, onClose, onSelect }: GifPickerProps) {
  const [query, setQuery] = useState("");
  const [gifs, setGifs] = useState<GiphyGif[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(async (q: string) => {
    const id = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const { results, nextOffset: next } = await searchGifs(q, 0);
      if (id !== requestIdRef.current) return;
      setGifs(results);
      setNextOffset(next);
    } catch (err) {
      if (id !== requestIdRef.current) return;
      const message =
        err instanceof Error ? err.message : "Failed to load GIFs";
      setError(message);
      setGifs([]);
      setNextOffset(null);
    } finally {
      if (id === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      runSearch(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, isVisible, runSearch]);

  useEffect(() => {
    if (!isVisible) {
      setQuery("");
      setGifs([]);
      setNextOffset(0);
      setError(null);
      requestIdRef.current++;
    }
  }, [isVisible]);

  const handleEndReached = useCallback(async () => {
    if (nextOffset === null || isLoadingMore || isLoading) return;
    const id = requestIdRef.current;
    setIsLoadingMore(true);
    try {
      const { results, nextOffset: next } = await searchGifs(query, nextOffset);
      if (id !== requestIdRef.current) return;
      setGifs((prev) => [...prev, ...results]);
      setNextOffset(next);
    } catch {
      // pagination failures are non-fatal
    } finally {
      if (id === requestIdRef.current) {
        setIsLoadingMore(false);
      }
    }
  }, [nextOffset, isLoadingMore, isLoading, query]);

  const handleSelect = useCallback(
    (gif: GiphyGif) => {
      haptic.selection();
      onSelect(gif);
      onClose();
    },
    [onSelect, onClose],
  );

  const renderItem: ListRenderItem<GiphyGif> = useCallback(
    ({ item }) => {
      const aspectRatio =
        item.width > 0 && item.height > 0 ? item.width / item.height : 1;
      return (
        <Pressable
          onPress={() => handleSelect(item)}
          style={styles.tile}
          accessibilityLabel="Select GIF"
          accessibilityRole="button"
        >
          <Image
            source={{ uri: item.previewUrl }}
            style={[styles.tileImage, { aspectRatio }]}
            contentFit="cover"
            transition={120}
          />
        </Pressable>
      );
    },
    [handleSelect],
  );

  const keyExtractor = useCallback((item: GiphyGif) => item.id, []);

  return (
    <Modal
      visible={isVisible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>GIFs</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>

        <View style={styles.searchBar}>
          <Ionicons
            name="search"
            size={16}
            color={colors.text.placeholder}
            style={styles.searchIcon}
          />
          <TextInput
            style={styles.searchInput}
            placeholder="Search GIPHY"
            placeholderTextColor={colors.text.placeholder}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
          />
          {query.length > 0 && (
            <Pressable
              onPress={() => setQuery("")}
              hitSlop={8}
              accessibilityLabel="Clear search"
              accessibilityRole="button"
            >
              <Ionicons
                name="close-circle"
                size={16}
                color={colors.text.secondary}
              />
            </Pressable>
          )}
        </View>

        {isLoading && gifs.length === 0 ? (
          <View style={styles.centered}>
            <ActivityIndicator size="small" color={colors.text.secondary} />
          </View>
        ) : error ? (
          <View style={styles.centered}>
            <Text style={styles.emptyText}>{error}</Text>
          </View>
        ) : gifs.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.emptyText}>No GIFs found</Text>
          </View>
        ) : (
          <FlatList
            data={gifs}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            numColumns={COLUMN_COUNT}
            columnWrapperStyle={styles.row}
            contentContainerStyle={styles.list}
            onEndReached={handleEndReached}
            onEndReachedThreshold={0.6}
            keyboardShouldPersistTaps="handled"
            ListFooterComponent={
              isLoadingMore ? (
                <View style={styles.footerLoader}>
                  <ActivityIndicator
                    size="small"
                    color={colors.text.secondary}
                  />
                </View>
              ) : null
            }
          />
        )}

        <Text style={styles.attribution}>Powered by GIPHY</Text>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.main,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.background.border,
  },
  title: {
    color: colors.text.primary,
    fontSize: 17,
    fontWeight: "600",
  },
  cancelText: {
    color: colors.text.secondary,
    fontSize: 16,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.background.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.background.border,
  },
  searchIcon: {
    opacity: 0.8,
  },
  searchInput: {
    flex: 1,
    color: colors.text.body,
    fontSize: 15,
    padding: 0,
  },
  list: {
    padding: 8,
    paddingBottom: 24,
  },
  row: {
    gap: 8,
  },
  tile: {
    flex: 1,
    marginBottom: 8,
    backgroundColor: colors.background.surface,
    borderRadius: 8,
    overflow: "hidden",
  },
  tileImage: {
    width: "100%",
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  emptyText: {
    color: colors.text.secondary,
    fontSize: 14,
    textAlign: "center",
  },
  footerLoader: {
    paddingVertical: 16,
    alignItems: "center",
  },
  attribution: {
    color: colors.text.placeholder,
    fontSize: 11,
    textAlign: "center",
    paddingVertical: 6,
  },
});
