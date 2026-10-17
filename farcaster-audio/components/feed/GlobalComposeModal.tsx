import { useCallback, useEffect, useRef, useState } from "react";
import { ComposeModal } from "@/components/feed/ComposeModal";
import { useFeed } from "@/hooks/useFeed";
import { useComposeStore } from "@/stores/composeStore";

/**
 * Persistent compose host for the tab area. It lives beside the Tabs navigator,
 * so a tab-bar request opens over whichever tab is currently visible instead
 * of being consumed by a hidden Home screen.
 */
export function GlobalComposeModal() {
  const composeSignal = useComposeStore((state) => state.composeSignal);
  const draft = useComposeStore((state) => state.draft);
  const clearDraft = useComposeStore((state) => state.clearDraft);
  // `useFeed` writes refresh results into the shared Zustand feed/voice-note
  // stores, so a successful global publish updates Home even when another tab
  // is visible; this is not component-local hook state.
  const { handlePublishCast } = useFeed();
  const handledSignalRef = useRef(composeSignal);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (composeSignal <= handledSignalRef.current) return;
    handledSignalRef.current = composeSignal;
    setIsVisible(true);
  }, [composeSignal]);

  const close = useCallback(() => {
    setIsVisible(false);
    clearDraft();
  }, [clearDraft]);

  return (
    <ComposeModal
      isVisible={isVisible}
      onClose={close}
      onPublish={handlePublishCast}
      defaultText={draft?.text}
      defaultEmbeds={draft?.embeds}
      initialChannelId={draft?.channelId}
    />
  );
}
