import { describe, expect, it } from "@jest/globals";
import { getNotificationRoute } from "../notificationRouting";

describe("getNotificationRoute", () => {
  it("opens a deep reply as its own thread page", () => {
    expect(
      getNotificationRoute({
        cast_hash: "0xdeep",
        thread_hash: "0xroot",
        focus_hash: "0xdeep",
      }),
    ).toBe("/cast/0xdeep");
  });

  it("opens a root cast without a redundant context query", () => {
    expect(
      getNotificationRoute({
        cast_hash: "0xroot",
        thread_hash: "0xroot",
      }),
    ).toBe("/cast/0xroot");
  });

  it("uses the focused cast when older payloads provide only focus + thread", () => {
    expect(
      getNotificationRoute({
        focus_hash: "0xdeep",
        thread_hash: "0xroot",
      }),
    ).toBe("/cast/0xdeep");
  });

  it("accepts the new direct deep-reply route", () => {
    expect(
      getNotificationRoute({
        url: "/cast/0xdeep?contextHash=0xroot",
      }),
    ).toBe("/cast/0xdeep?contextHash=0xroot");
  });

  it("rejects unrelated and executable routes", () => {
    expect(getNotificationRoute({ url: "javascript:alert(1)" })).toBeNull();
    expect(getNotificationRoute({ url: "/admin" })).toBeNull();
    expect(
      getNotificationRoute({ url: "/cast/../../notification-settings" }),
    ).toBeNull();
    expect(getNotificationRoute({ url: "/cast/0xabc\\..\\settings" })).toBeNull();
  });
});
