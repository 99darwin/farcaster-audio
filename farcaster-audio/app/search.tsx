import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuthStore } from "@/stores/authStore";
import { useComposeStore } from "@/stores/composeStore";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import {
  useSearchQuery,
  type SearchTab,
} from "@/hooks/useSearchQuery";
import { useSearchCasts } from "@/hooks/useSearchCasts";
import { SearchBar } from "@/components/search/SearchBar";
import {
  TabStrip,
  type TabStripItem,
} from "@/components/search/TabStrip";
import { UserResultRow } from "@/components/search/UserResultRow";
import { ChannelResultRow } from "@/components/search/ChannelResultRow";
import { MiniappResultRow } from "@/components/search/MiniappResultRow";
import { CastSortToggle } from "@/components/search/CastSortToggle";
import { FeedList } from "@/components/feed/FeedList";
import { ComposeModal } from "@/components/feed/ComposeModal";
import { CastCard } from "@/components/feed/CastCard";
import { spacing, typography } from "@/constants/theme";
import type { NeynarCast } from "@/types/neynar";
import type { UserSearchItem } from "@/services/api";
import type { ChannelSearchItem, MiniappResult } from "@/types/api";

const ALL_TABS: TabStripItem<SearchTab>[] = [
  { key: "top", label: "Top" },
  { key: "people", label: "People" },
  { key: "casts", label: "Casts" },
  { key: "channels", label: "Channels" },
  { key: "miniapps", label: "Miniapps" },
];

export default function SearchScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const user = useAuthStore((s) => s.user);
  const styles = useStyles();
  const { colors } = useTheme();
  const composeDraft = useComposeStore((s) => s.draft);
  const clearDraft = useComposeStore((s) => s.clearDraft);

  const {
    query,
    setQuery,
    activeTab,
    setActiveTab,
    castSort,
    setCastSort,
    results,
    isLoading,
    errors,
    meta,
  } = useSearchQuery();

  const trimmedQuery = query.trim();

  const {
    items: castItems,
    meta: castListMeta,
    isLoading: castsLoading,
    isRefreshing: castsRefreshing,
    hasMore: castsHasMore,
    error: castsError,
    fetch: refetchCasts,
    fetchMore: fetchMoreCasts,
    refresh: refreshCasts,
    handleLike: handleCastLike,
    handleRecast: handleCastRecast,
    handleBookmark: handleCastBookmark,
    handlePublishCast,
  } = useSearchCasts(trimmedQuery, castSort, {
    enabled: activeTab === "casts",
  });

  // Tab switching is a thin setter. `useSearchCasts` is gated on
  // `enabled: activeTab === "casts"` and handles its own fetch.
  const onTabChange = useCallback(
    (next: SearchTab) => {
      setActiveTab(next);
    },
    [setActiveTab],
  );

  // Compose modal for reply/quote interactions on the Casts tab.
  const [isComposeVisible, setIsComposeVisible] = useState(false);
  const [replyTarget, setReplyTarget] = useState<NeynarCast | null>(null);
  const [quoteCastTarget, setQuoteCastTarget] = useState<NeynarCast | null>(
    null,
  );

  const openReply = useCallback((cast: NeynarCast) => {
    setReplyTarget(cast);
    setQuoteCastTarget(null);
    setIsComposeVisible(true);
  }, []);

  const openQuoteCast = useCallback((cast: NeynarCast) => {
    setQuoteCastTarget(cast);
    setReplyTarget(null);
    setIsComposeVisible(true);
  }, []);

  const closeCompose = useCallback(() => {
    setIsComposeVisible(false);
    setReplyTarget(null);
    setQuoteCastTarget(null);
    clearDraft();
  }, [clearDraft]);

  const handleCancel = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/");
    }
  }, [router]);

  const handleCastPress = useCallback(
    (hash: string) => router.push(`/cast/${hash}`),
    [router],
  );

  const myFid = user?.fid ?? 0;

  // Active tabs: hide miniapps when backend reports it's unsupported.
  const visibleTabs = useMemo<TabStripItem<SearchTab>[]>(() => {
    if (meta.miniappsUnsupported) {
      return ALL_TABS.filter((t) => t.key !== "miniapps");
    }
    return ALL_TABS;
  }, [meta.miniappsUnsupported]);

  // If the user is on a tab that just got hidden, fall back to "top".
  useEffect(() => {
    if (!visibleTabs.some((t) => t.key === activeTab)) {
      setActiveTab("top");
    }
  }, [activeTab, setActiveTab, visibleTabs]);

  const renderEmptyPrompt = () => (
    <View style={styles.emptyState}>
      <Text style={styles.emptyTitle}>Search Farcaster</Text>
      <Text style={styles.emptyHelp}>
        Try{" "}
        <Text style={styles.code}>from:dwr &quot;channel&quot;</Text> or{" "}
        <Text style={styles.code}>before:2026-01-01</Text>
      </Text>
    </View>
  );

  const renderZeroResults = (label: string) => (
    <View style={styles.zeroState}>
      <Text style={styles.zeroText}>
        No {label} match &ldquo;{trimmedQuery}&rdquo;
      </Text>
    </View>
  );

  const renderTopBody = () => {
    const top = results.top;
    const noResults =
      !isLoading.top &&
      top.users.length === 0 &&
      top.casts.length === 0 &&
      top.channels.length === 0;

    if (isLoading.top && noResults) {
      return (
        <View style={styles.loading}>
          <ActivityIndicator size="small" color={colors.text.secondary} />
        </View>
      );
    }
    if (noResults) return renderZeroResults("results");

    return (
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {top.users.length > 0 ? (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>People</Text>
              <Pressable
                onPress={() => setActiveTab("people")}
                hitSlop={8}
                accessibilityRole="button"
              >
                <Text style={styles.sectionLink}>See all</Text>
              </Pressable>
            </View>
            {top.users.map((u: UserSearchItem) => (
              <UserResultRow key={u.fid} user={u} />
            ))}
          </View>
        ) : null}

        {top.casts.length > 0 ? (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Casts</Text>
              <Pressable
                onPress={() => setActiveTab("casts")}
                hitSlop={8}
                accessibilityRole="button"
              >
                <Text style={styles.sectionLink}>See all</Text>
              </Pressable>
            </View>
            {top.casts.map((cast: NeynarCast) => (
              <CastCard
                key={cast.hash}
                cast={cast}
                myFid={myFid}
                onLike={handleCastLike}
                onRecast={handleCastRecast}
                onBookmark={handleCastBookmark}
                onQuoteCast={openQuoteCast}
                onReply={openReply}
                onPress={() => handleCastPress(cast.hash)}
              />
            ))}
          </View>
        ) : null}

        {top.channels.length > 0 ? (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Channels</Text>
              <Pressable
                onPress={() => setActiveTab("channels")}
                hitSlop={8}
                accessibilityRole="button"
              >
                <Text style={styles.sectionLink}>See all</Text>
              </Pressable>
            </View>
            {top.channels.map((c: ChannelSearchItem) => (
              <ChannelResultRow key={c.id} channel={c} />
            ))}
          </View>
        ) : null}
      </ScrollView>
    );
  };

  const renderPeopleBody = () => {
    if (isLoading.people && results.people.length === 0) {
      return (
        <View style={styles.loading}>
          <ActivityIndicator size="small" color={colors.text.secondary} />
        </View>
      );
    }
    if (results.people.length === 0) return renderZeroResults("people");
    return (
      <FlatList
        data={results.people}
        keyExtractor={(item) => String(item.fid)}
        renderItem={({ item }) => <UserResultRow user={item} />}
        keyboardShouldPersistTaps="handled"
      />
    );
  };

  const renderChannelsBody = () => {
    if (isLoading.channels && results.channels.length === 0) {
      return (
        <View style={styles.loading}>
          <ActivityIndicator size="small" color={colors.text.secondary} />
        </View>
      );
    }
    if (results.channels.length === 0) return renderZeroResults("channels");
    return (
      <FlatList
        data={results.channels}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <ChannelResultRow channel={item} />}
        keyboardShouldPersistTaps="handled"
      />
    );
  };

  const renderMiniappsBody = () => {
    if (isLoading.miniapps && results.miniapps.length === 0) {
      return (
        <View style={styles.loading}>
          <ActivityIndicator size="small" color={colors.text.secondary} />
        </View>
      );
    }
    if (results.miniapps.length === 0) return renderZeroResults("miniapps");
    return (
      <FlatList
        data={results.miniapps}
        keyExtractor={(item: MiniappResult, idx) =>
          `${item.frames_url}-${idx}`
        }
        renderItem={({ item }) => <MiniappResultRow miniapp={item} />}
        keyboardShouldPersistTaps="handled"
      />
    );
  };

  const renderCastsBody = () => {
    // Prefer the materialized hook result; meta from the hook overrides the
    // hook-query meta because the materialized list is the source of truth.
    const effectiveMeta = castListMeta ?? meta.casts;
    const unknownAuthor = effectiveMeta?.unknown_author === true;
    const unknownAuthorName =
      effectiveMeta?.parsed?.author_username ?? null;

    return (
      <View style={styles.flex}>
        <CastSortToggle value={castSort} onChange={setCastSort} />
        {unknownAuthor ? (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>
              No user named @{unknownAuthorName ?? "?"}
            </Text>
          </View>
        ) : null}
        <FeedList
          items={castItems}
          myFid={myFid}
          isLoading={castsLoading}
          isRefreshing={castsRefreshing}
          hasMore={castsHasMore}
          onRefresh={refreshCasts}
          onEndReached={fetchMoreCasts}
          onLike={handleCastLike}
          onRecast={handleCastRecast}
          onBookmark={handleCastBookmark}
          onQuoteCast={openQuoteCast}
          onReply={openReply}
          error={castsError}
          onRetry={refetchCasts}
          emptyTitle={`No casts match "${trimmedQuery}"`}
          emptySubtitle="Try a different query or sort"
        />
      </View>
    );
  };

  const renderBody = () => {
    if (!trimmedQuery) return renderEmptyPrompt();
    switch (activeTab) {
      case "top":
        return renderTopBody();
      case "people":
        return renderPeopleBody();
      case "casts":
        return renderCastsBody();
      case "channels":
        return renderChannelsBody();
      case "miniapps":
        return renderMiniappsBody();
    }
  };

  const errorForTab =
    activeTab === "casts" ? null : errors[activeTab] ?? null;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <SearchBar value={query} onChangeText={setQuery} onCancel={handleCancel} />
      {trimmedQuery ? (
        <TabStrip
          tabs={visibleTabs}
          activeKey={activeTab}
          onChange={onTabChange}
        />
      ) : null}
      {errorForTab ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{errorForTab}</Text>
        </View>
      ) : null}
      <View style={styles.body}>{renderBody()}</View>

      <ComposeModal
        isVisible={isComposeVisible}
        onClose={closeCompose}
        onPublish={handlePublishCast}
        replyTo={replyTarget}
        quoteCast={quoteCastTarget}
        defaultText={composeDraft?.text}
        defaultEmbeds={composeDraft?.embeds}
      />
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flex: 1,
      backgroundColor: colors.background.main,
    },
    body: {
      flex: 1,
    },
    flex: {
      flex: 1,
    },
    emptyState: {
      flex: 1,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      paddingHorizontal: spacing.xl,
      gap: spacing.sm,
    },
    emptyTitle: {
      color: colors.text.primary,
      fontSize: typography.size.xl,
      fontWeight: typography.weight.semibold,
    },
    emptyHelp: {
      color: colors.text.secondary,
      fontSize: typography.size.sm,
      textAlign: "center" as const,
    },
    code: {
      color: colors.text.body,
      fontWeight: typography.weight.semibold,
    },
    zeroState: {
      flex: 1,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      padding: spacing.xl,
    },
    zeroText: {
      color: colors.text.secondary,
      fontSize: typography.size.body,
      textAlign: "center" as const,
    },
    loading: {
      padding: spacing.xl,
      alignItems: "center" as const,
    },
    scrollContent: {
      paddingBottom: spacing["3xl"],
    },
    section: {
      marginTop: spacing.sm,
    },
    sectionHeader: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: spacing.sm,
    },
    sectionTitle: {
      color: colors.text.primary,
      fontSize: typography.size.lg,
      fontWeight: typography.weight.bold,
    },
    sectionLink: {
      color: colors.accent,
      fontSize: typography.size.sm,
      fontWeight: typography.weight.semibold,
    },
    banner: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: colors.background.subtle,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
    },
    bannerText: {
      color: colors.text.body,
      fontSize: typography.size.sm,
    },
  }));
