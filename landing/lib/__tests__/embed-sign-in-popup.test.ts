/**
 * Embed web sign-in popup: the session only travels between same-origin
 * windows, and only from the window the embed opened.
 */

import { LOGIN_RESPONSE } from "@/lib/auth/__tests__/fixtures";
import {
  EMBED_SIGN_IN_MESSAGE_TYPE,
  EMBED_SIGN_IN_PATH,
  EmbedSignInPopupError,
  hasSameOriginOpener,
  isFramed,
  openEmbedSignInPopup,
  parseEmbedSignInMessage,
  postLoginResponseToOpener,
} from "@/lib/embed-sign-in-popup";

const JUKE_ORIGIN = "https://juke.audio";
const OTHER_ORIGIN = "https://evil.example";

type MessageHandler = (event: { origin: string; source: unknown; data: unknown }) => void;

function createFakePopup() {
  return { closed: false, close: jest.fn() };
}

function createFakeOpenerWindow(popup: ReturnType<typeof createFakePopup> | null) {
  const handlers = new Set<MessageHandler>();
  const win = {
    location: { origin: JUKE_ORIGIN },
    open: jest.fn(() => popup),
    addEventListener: jest.fn((type: string, handler: MessageHandler) => {
      if (type === "message") handlers.add(handler);
    }),
    removeEventListener: jest.fn((type: string, handler: MessageHandler) => {
      if (type === "message") handlers.delete(handler);
    }),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  };
  const dispatch = (event: { origin: string; source: unknown; data: unknown }) =>
    handlers.forEach((handler) => handler(event));
  return { win: win as unknown as Window, raw: win, handlers, dispatch };
}

const validMessage = { type: EMBED_SIGN_IN_MESSAGE_TYPE, response: LOGIN_RESPONSE };

afterEach(() => {
  jest.useRealTimers();
});

describe("parseEmbedSignInMessage", () => {
  it("accepts a well-formed sign-in message", () => {
    expect(parseEmbedSignInMessage(validMessage)).toEqual(LOGIN_RESPONSE);
  });

  it.each([
    ["null", null],
    ["a string", "hello"],
    ["another type", { ...validMessage, type: "other" }],
    ["a missing response", { type: EMBED_SIGN_IN_MESSAGE_TYPE }],
    ["an empty jwt", { ...validMessage, response: { ...LOGIN_RESPONSE, jwt: "" } }],
    [
      "a non-integer fid",
      { ...validMessage, response: { ...LOGIN_RESPONSE, user: { fid: "1" } } },
    ],
  ])("rejects %s", (_label, data) => {
    expect(parseEmbedSignInMessage(data)).toBeNull();
  });
});

describe("openEmbedSignInPopup", () => {
  it("opens the same-origin sign-in page synchronously", () => {
    const popup = createFakePopup();
    const { win, raw } = createFakeOpenerWindow(popup);
    const controller = new AbortController();

    void openEmbedSignInPopup({ win, signal: controller.signal }).catch(() => {});

    expect(raw.open).toHaveBeenCalledWith(
      `${JUKE_ORIGIN}${EMBED_SIGN_IN_PATH}`,
      expect.any(String),
      expect.stringContaining("popup"),
    );
    controller.abort();
  });

  it("resolves with the session posted by the popup it opened", async () => {
    const popup = createFakePopup();
    const { win, handlers, dispatch } = createFakeOpenerWindow(popup);

    const pending = openEmbedSignInPopup({ win });
    dispatch({ origin: JUKE_ORIGIN, source: popup, data: validMessage });

    await expect(pending).resolves.toEqual(LOGIN_RESPONSE);
    expect(handlers.size).toBe(0);
  });

  it("ignores messages from another origin or another window", async () => {
    jest.useFakeTimers();
    const popup = createFakePopup();
    const { win, dispatch } = createFakeOpenerWindow(popup);

    const pending = openEmbedSignInPopup({ win });
    dispatch({ origin: OTHER_ORIGIN, source: popup, data: validMessage });
    dispatch({ origin: JUKE_ORIGIN, source: createFakePopup(), data: validMessage });
    dispatch({ origin: JUKE_ORIGIN, source: popup, data: { type: "noise" } });
    popup.closed = true;
    jest.advanceTimersByTime(1000);

    await expect(pending).rejects.toMatchObject({ reason: "closed" });
  });

  it("rejects with blocked when the browser refuses the popup", async () => {
    const { win } = createFakeOpenerWindow(null);

    const error = await openEmbedSignInPopup({ win }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(EmbedSignInPopupError);
    expect((error as EmbedSignInPopupError).reason).toBe("blocked");
  });

  it("closes the popup and rejects when aborted", async () => {
    const popup = createFakePopup();
    const { win, handlers } = createFakeOpenerWindow(popup);
    const controller = new AbortController();

    const pending = openEmbedSignInPopup({ win, signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ reason: "aborted" });
    expect(popup.close).toHaveBeenCalled();
    expect(handlers.size).toBe(0);
  });

  it("does not open anything when already aborted", async () => {
    const { win, raw } = createFakeOpenerWindow(createFakePopup());
    const controller = new AbortController();
    controller.abort();

    await expect(
      openEmbedSignInPopup({ win, signal: controller.signal }),
    ).rejects.toMatchObject({ reason: "aborted" });
    expect(raw.open).not.toHaveBeenCalled();
  });
});

describe("popup side", () => {
  function createPopupWindow(opener: unknown) {
    const win: Record<string, unknown> = {
      location: { origin: JUKE_ORIGIN },
      opener,
    };
    win.self = win;
    win.top = win;
    return win;
  }

  it("posts the session only to its own origin", () => {
    const opener = { location: { origin: JUKE_ORIGIN }, postMessage: jest.fn() };
    const win = createPopupWindow(opener) as unknown as Window;

    expect(postLoginResponseToOpener(LOGIN_RESPONSE, win)).toBe(true);
    expect(opener.postMessage).toHaveBeenCalledWith(validMessage, JUKE_ORIGIN);
  });

  it("refuses a cross-origin opener", () => {
    const postMessage = jest.fn();
    const opener = {
      get location(): never {
        throw new Error("SecurityError: cross-origin");
      },
      postMessage,
    };
    const win = createPopupWindow(opener) as unknown as Window;

    expect(hasSameOriginOpener(win)).toBe(false);
    expect(postLoginResponseToOpener(LOGIN_RESPONSE, win)).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("refuses when opened directly", () => {
    const win = createPopupWindow(null) as unknown as Window;
    expect(hasSameOriginOpener(win)).toBe(false);
  });

  it("detects being framed", () => {
    const top = createPopupWindow(null) as unknown as Window;
    const framed = { ...createPopupWindow(null), top } as unknown as Window;
    expect(isFramed(top)).toBe(false);
    expect(isFramed(framed)).toBe(true);
  });
});
