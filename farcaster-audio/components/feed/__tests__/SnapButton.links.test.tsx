/**
 * Snap button params are author-controlled. Unsafe URLs must never reach
 * Linking.openURL, and malformed cast hashes / fids must not be pushed as
 * routes (H3).
 */
import React from "react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import { Linking } from "react-native";

const mockPush = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock("@/hooks/useThemedStyles", () => ({
  useThemedStyles: (factory: (value: unknown) => unknown) =>
    factory({ colors: { text: { secondary: "#999" } } }),
}));

import { SnapButton } from "@/components/feed/snap/components/Button";
import { SnapContext, type SnapContextValue } from "@/components/feed/snap/context";
import type { SnapEvents } from "@/types/snap";

const openURL = jest.spyOn(Linking, "openURL");

const CONTEXT = {
  accent: "purple",
  elements: {},
  inputs: {},
  setInput: () => undefined,
  renderChildren: () => null,
  submitButton: async () => undefined,
  signerStatus: "approved",
  submitting: false,
} as unknown as SnapContextValue;

function pressButton(action: string, params: Record<string, unknown>) {
  const on = { press: { action, params } } as unknown as SnapEvents;
  const screen = render(
    <SnapContext.Provider value={CONTEXT}>
      <SnapButton id="b1" props={{ label: "Go" } as never} on={on} />
    </SnapContext.Provider>,
  );
  fireEvent.press(screen.getByText("Go"));
}

describe("SnapButton link safety", () => {
  beforeEach(() => {
    mockPush.mockReset();
    openURL.mockReset();
    openURL.mockResolvedValue(true);
  });

  it.each(["open_url", "open_snap", "open_mini_app"])(
    "%s opens a public https target",
    async (action) => {
      pressButton(action, { target: "https://example.com/x" });
      await Promise.resolve();
      expect(openURL).toHaveBeenCalledWith("https://example.com/x");
    },
  );

  it.each([
    ["open_url", "tel:+15555550100"],
    ["open_url", "javascript:alert(1)"],
    ["open_snap", "otherapp://pay"],
    ["open_mini_app", "https://127.0.0.1/"],
  ])("%s drops unsafe target %s", async (action, target) => {
    pressButton(action, { target });
    await Promise.resolve();
    expect(openURL).not.toHaveBeenCalled();
  });

  it("pushes a valid cast hash and drops a path-traversal one", () => {
    pressButton("view_cast", { hash: "0xabc123" });
    expect(mockPush).toHaveBeenCalledWith("/cast/0xabc123");
    mockPush.mockReset();
    pressButton("view_cast", { hash: "0xabc/../../settings" });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("pushes a valid fid and drops a malformed one", () => {
    pressButton("view_profile", { fid: 42 });
    expect(mockPush).toHaveBeenCalledWith("/profile/42");
    mockPush.mockReset();
    pressButton("view_profile", { fid: "42/../../admin" });
    expect(mockPush).not.toHaveBeenCalled();
  });
});
