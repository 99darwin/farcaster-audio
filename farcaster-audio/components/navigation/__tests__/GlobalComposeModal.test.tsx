import React from "react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, render } from "@testing-library/react-native";
import { GlobalComposeModal } from "@/components/feed/GlobalComposeModal";
import { useComposeStore } from "@/stores/composeStore";

let mockComposeProps: Record<string, unknown> | null = null;
const mockHandlePublishCast =
  jest.fn<(...args: unknown[]) => Promise<{ hash: string }>>();

jest.mock("@/components/feed/ComposeModal", () => ({
  ComposeModal: (props: Record<string, unknown>) => {
    const React = require("react");
    const { Text } = require("react-native");
    mockComposeProps = props;
    return props.isVisible
      ? React.createElement(Text, null, "global composer visible")
      : null;
  },
}));

jest.mock("@/hooks/useFeed", () => ({
  useFeed: () => ({
    handlePublishCast: (...args: unknown[]) => mockHandlePublishCast(...args),
  }),
}));

describe("GlobalComposeModal", () => {
  beforeEach(() => {
    mockComposeProps = null;
    mockHandlePublishCast.mockReset();
    useComposeStore.setState({ composeSignal: 0, draft: null });
  });

  it("opens immediately in the mounted tab shell and consumes draft defaults", () => {
    const screen = render(<GlobalComposeModal />);
    expect(screen.queryByText("global composer visible")).toBeNull();

    act(() => {
      useComposeStore.getState().requestCompose({
        text: "A local draft",
        embeds: ["https://example.com"],
        channelId: "music",
      });
    });

    expect(screen.getByText("global composer visible")).toBeTruthy();
    expect(mockComposeProps).toMatchObject({
      isVisible: true,
      defaultText: "A local draft",
      defaultEmbeds: ["https://example.com"],
      initialChannelId: "music",
    });
  });

  it("closes in place and clears only the consumed draft", () => {
    render(<GlobalComposeModal />);
    act(() => {
      useComposeStore.getState().requestCompose({ text: "Draft" });
    });

    act(() => {
      (mockComposeProps?.onClose as () => void)();
    });

    expect(mockComposeProps).toMatchObject({ isVisible: false });
    expect(useComposeStore.getState().draft).toBeNull();
  });

  it("routes successful publishing through the shared feed refresh contract", async () => {
    render(<GlobalComposeModal />);
    mockHandlePublishCast.mockResolvedValue({ hash: "0xcast" });

    const result = await (
      mockComposeProps?.onPublish as (
        text: string,
        parent?: string,
        embeds?: string[],
      ) => Promise<{ hash: string }>
    )("hello", undefined, ["https://example.com"]);

    expect(mockHandlePublishCast).toHaveBeenCalledWith(
      "hello",
      undefined,
      ["https://example.com"],
    );
    expect(result).toEqual({ hash: "0xcast" });
  });
});
