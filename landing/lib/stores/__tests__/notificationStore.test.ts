/**
 * Unit tests for the optimistic reaction/bookmark actions added to the
 * notifications store. The network layer is mocked — these exercise the pure
 * in-store cast mutation used by the interactive notifications feed.
 */

jest.mock("@/lib/api/notifications", () => ({
  getNotifications: jest.fn(),
}));

import { useNotificationStore } from "@/lib/stores/notificationStore";
import type { Notification, NotificationCast } from "@/lib/api/notifications";

function makeCast(overrides: Partial<NotificationCast> = {}): NotificationCast {
  return {
    hash: "0xcast",
    thread_hash: "0xcast",
    parent_hash: null,
    author: { fid: 1, username: "alice", display_name: "Alice", pfp_url: null },
    text: "hello",
    reactions: { likes_count: 2, recasts_count: 1 },
    viewer_context: { liked: false, recasted: false, bookmarked: false },
    ...overrides,
  };
}

function seed(notifications: Notification[]): void {
  useNotificationStore.setState({ notifications });
}

const INITIAL = useNotificationStore.getState();

afterEach(() => {
  useNotificationStore.setState(INITIAL, true);
});

describe("setCastReaction", () => {
  it("optimistically likes a matching cast and bumps the count", () => {
    seed([
      {
        type: "reply",
        most_recent_timestamp: "2026-07-06T00:00:00Z",
        seen: false,
        cast: makeCast(),
      },
    ]);

    useNotificationStore.getState().setCastReaction("0xcast", "like", true);

    const cast = useNotificationStore.getState().notifications[0].cast!;
    expect(cast.viewer_context?.liked).toBe(true);
    expect(cast.reactions?.likes_count).toBe(3);
  });

  it("decrements the count when unrecasting and never goes negative", () => {
    seed([
      {
        type: "recasts",
        most_recent_timestamp: "2026-07-06T00:00:00Z",
        seen: false,
        cast: makeCast({
          reactions: { likes_count: 0, recasts_count: 0 },
          viewer_context: { recasted: true },
        }),
      },
    ]);

    useNotificationStore.getState().setCastReaction("0xcast", "recast", false);

    const cast = useNotificationStore.getState().notifications[0].cast!;
    expect(cast.viewer_context?.recasted).toBe(false);
    expect(cast.reactions?.recasts_count).toBe(0);
  });

  it("is a no-op (same reference) when already in the requested state", () => {
    const before: Notification[] = [
      {
        type: "reply",
        most_recent_timestamp: "2026-07-06T00:00:00Z",
        seen: false,
        cast: makeCast({ viewer_context: { liked: true } }),
      },
    ];
    seed(before);
    const ref = useNotificationStore.getState().notifications;

    useNotificationStore.getState().setCastReaction("0xcast", "like", true);

    expect(useNotificationStore.getState().notifications).toBe(ref);
  });

  it("leaves non-matching casts untouched", () => {
    seed([
      {
        type: "reply",
        most_recent_timestamp: "2026-07-06T00:00:00Z",
        seen: false,
        cast: makeCast({ hash: "0xother" }),
      },
    ]);

    useNotificationStore.getState().setCastReaction("0xcast", "like", true);

    const cast = useNotificationStore.getState().notifications[0].cast!;
    expect(cast.viewer_context?.liked).toBe(false);
  });
});

describe("setCastBookmark", () => {
  it("toggles the viewer bookmark on a matching cast", () => {
    seed([
      {
        type: "mention",
        most_recent_timestamp: "2026-07-06T00:00:00Z",
        seen: false,
        cast: makeCast(),
      },
    ]);

    useNotificationStore.getState().setCastBookmark("0xcast", true);

    const cast = useNotificationStore.getState().notifications[0].cast!;
    expect(cast.viewer_context?.bookmarked).toBe(true);
  });
});
