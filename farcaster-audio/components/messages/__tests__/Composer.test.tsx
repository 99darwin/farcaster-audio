import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Composer, DRAFT_SAVE_DEBOUNCE_MS } from "@/components/messages/Composer";
import { composerDraftKey } from "@/services/composerDrafts";
import { ALICE, makeMessage } from "@/components/messages/__fixtures__/messages";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("expo-image", () => ({ Image: () => null }));
jest.mock("@/components/common/MentionSuggestions", () => ({ MentionSuggestions: () => null }));
jest.mock("@/services/messagesApi", () => ({
  previewMetadata: jest.fn(() => new Promise(() => {})),
  isAbortError: () => false,
}));

function renderComposer(overrides: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const props = {
    replyTarget: null,
    isReadOnly: false,
    bottomInset: 0,
    onCancelReply: jest.fn(),
    onSubmit: jest.fn(async () => true),
    ...overrides,
  };
  return { ...render(<Composer {...props} />), props };
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe("Composer", () => {
  it("submits trimmed-nonempty text and clears the draft", async () => {
    const { getByTestId, props } = renderComposer();
    fireEvent.changeText(getByTestId("composer-input"), "hello there");
    await act(async () => {
      fireEvent.press(getByTestId("composer-send"));
    });
    expect(props.onSubmit).toHaveBeenCalledWith({ text: "hello there", processMetadata: true });
    expect(getByTestId("composer-input").props.value).toBe("");
  });

  it("restores the draft when the parent refuses it", async () => {
    const onSubmit = jest.fn(async () => false);
    const { getByTestId } = renderComposer({ onSubmit });
    fireEvent.changeText(getByTestId("composer-input"), "too long");
    await act(async () => {
      fireEvent.press(getByTestId("composer-send"));
    });
    await waitFor(() => expect(getByTestId("composer-input").props.value).toBe("too long"));
  });

  it("ignores whitespace-only drafts", () => {
    const { getByTestId, props } = renderComposer();
    fireEvent.changeText(getByTestId("composer-input"), "   ");
    fireEvent.press(getByTestId("composer-send"));
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("shows and cancels the reply preview", () => {
    const replyTarget = makeMessage({ message_id: "r1", sender: ALICE, text: "quoted" });
    const { getByTestId, getByText, props } = renderComposer({ replyTarget });
    expect(getByTestId("composer-reply-preview")).toBeTruthy();
    expect(getByText("quoted")).toBeTruthy();
    fireEvent.press(getByTestId("composer-cancel-reply"));
    expect(props.onCancelReply).toHaveBeenCalled();
  });

  it("is free for the next message as soon as the parent accepts the send", async () => {
    // The thread screen resolves after the optimistic insert, while
    // delivery is still in flight.
    const deliveries: Array<() => void> = [];
    const onSubmit = jest.fn(async () => {
      void new Promise<void>((resolve) => deliveries.push(resolve));
      return true;
    });
    const { getByTestId } = renderComposer({ onSubmit });
    fireEvent.changeText(getByTestId("composer-input"), "first");
    await act(async () => {
      fireEvent.press(getByTestId("composer-send"));
    });
    fireEvent.changeText(getByTestId("composer-input"), "second");
    await act(async () => {
      fireEvent.press(getByTestId("composer-send"));
    });
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith({ text: "second", processMetadata: true });
    expect(deliveries).toHaveLength(2);
  });
});

describe("Composer drafts", () => {
  const KEY = composerDraftKey(7, "conv-1") as string;

  it("restores a saved draft when the thread opens", async () => {
    await AsyncStorage.setItem(KEY, "half-written");
    const { getByTestId } = renderComposer({ draftKey: KEY });
    await waitFor(() => expect(getByTestId("composer-input").props.value).toBe("half-written"));
  });

  it("saves typing (debounced) and flushes on unmount", async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId, unmount } = renderComposer({ draftKey: KEY });
      await act(async () => {
        await Promise.resolve();
      });
      fireEvent.changeText(getByTestId("composer-input"), "draft one");
      await act(async () => {
        jest.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
      });
      expect(await AsyncStorage.getItem(KEY)).toBe("draft one");

      fireEvent.changeText(getByTestId("composer-input"), "draft two");
      unmount();
      await act(async () => {
        await Promise.resolve();
      });
      expect(await AsyncStorage.getItem(KEY)).toBe("draft two");
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps what the user typed before the restore landed", async () => {
    await AsyncStorage.setItem(KEY, "old draft");
    const { getByTestId } = renderComposer({ draftKey: KEY });
    fireEvent.changeText(getByTestId("composer-input"), "new text");
    await waitFor(async () => expect(await AsyncStorage.getItem(KEY)).toBe("new text"));
    expect(getByTestId("composer-input").props.value).toBe("new text");
  });

  it("clears the draft on send", async () => {
    await AsyncStorage.setItem(KEY, "send me");
    const { getByTestId, unmount } = renderComposer({ draftKey: KEY });
    await waitFor(() => expect(getByTestId("composer-input").props.value).toBe("send me"));
    await act(async () => {
      fireEvent.press(getByTestId("composer-send"));
    });
    unmount();
    await waitFor(async () => expect(await AsyncStorage.getItem(KEY)).toBeNull());
  });

  it("keys drafts per viewer and thread", async () => {
    const other = composerDraftKey(8, "conv-1") as string;
    await AsyncStorage.setItem(other, "someone else's");
    const { getByTestId } = renderComposer({ draftKey: KEY });
    await act(async () => {
      await Promise.resolve();
    });
    expect(getByTestId("composer-input").props.value).toBe("");
  });
});
