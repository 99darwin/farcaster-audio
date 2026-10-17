import React from "react";
import { I18nManager, Text } from "react-native";
import { act, render } from "@testing-library/react-native";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  computeSwipeOffset,
  releaseVelocity,
  swipeActiveOffsetX,
  SWIPE_MAX_OFFSET,
  SWIPE_REPLY_THRESHOLD,
  SwipeToReply,
  shouldFireThresholdHaptic,
} from "@/components/messages/SwipeToReply";
import { makeMessage } from "@/components/messages/__fixtures__/messages";

type Handler = (...args: any[]) => void;

class MockPan {
  handlers: Record<string, Handler> = {};
  isEnabled = true;
  activeRange: number[] = [];
  enabled(value: boolean) {
    this.isEnabled = value;
    return this;
  }
  activeOffsetX(range: number[]) {
    this.activeRange = range;
    return this;
  }
  failOffsetY() {
    return this;
  }
  onBegin(callback: Handler) {
    this.handlers.onBegin = callback;
    return this;
  }
  onUpdate(callback: Handler) {
    this.handlers.onUpdate = callback;
    return this;
  }
  onEnd(callback: Handler) {
    this.handlers.onEnd = callback;
    return this;
  }
  onFinalize(callback: Handler) {
    this.handlers.onFinalize = callback;
    return this;
  }
}

const pans = () => (globalThis as any).__swipeToReplyPans as MockPan[];
const latestPan = () => pans()[pans().length - 1];

jest.mock("react-native-gesture-handler", () => {
  (globalThis as any).__swipeToReplyPans = [];
  return {
    Gesture: {
      Pan: () => {
        const pan = new MockPan();
        (globalThis as any).__swipeToReplyPans.push(pan);
        return pan;
      },
    },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  };
});

jest.mock("react-native-reanimated", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    __esModule: true,
    default: { View: (props: any) => React.createElement(View, props) },
    useSharedValue: (value: unknown) => React.useRef({ value }).current,
    useAnimatedStyle: (factory: () => unknown) => factory(),
    withSpring: (value: unknown) => value,
    runOnJS: (callback: (...args: any[]) => unknown) => callback,
  };
});

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

const mockSelection = jest.fn();
jest.mock("@/utils/haptics", () => ({
  haptic: { selection: () => mockSelection() },
}));

const MESSAGE = makeMessage({ message_id: "swiped" });

describe("shouldFireThresholdHaptic", () => {
  it("fires once past the threshold", () => {
    expect(shouldFireThresholdHaptic(-(SWIPE_REPLY_THRESHOLD - 1), false)).toBe(false);
    expect(shouldFireThresholdHaptic(-SWIPE_REPLY_THRESHOLD, false)).toBe(true);
    expect(shouldFireThresholdHaptic(-SWIPE_REPLY_THRESHOLD, true)).toBe(false);
  });
});

describe("computeSwipeOffset", () => {
  it("ignores rightward drags", () => {
    expect(computeSwipeOffset(40)).toBe(0);
  });

  it("tracks the finger up to the threshold, then rubber-bands and caps", () => {
    expect(computeSwipeOffset(-30)).toBe(-30);
    expect(computeSwipeOffset(-SWIPE_REPLY_THRESHOLD)).toBe(-SWIPE_REPLY_THRESHOLD);
    expect(computeSwipeOffset(-(SWIPE_REPLY_THRESHOLD + 40))).toBe(-(SWIPE_REPLY_THRESHOLD + 10));
    expect(computeSwipeOffset(-1000)).toBe(-SWIPE_MAX_OFFSET);
  });
});

describe("RTL mirroring", () => {
  it("counts only rightward travel and returns positive offsets", () => {
    expect(computeSwipeOffset(-40, true)).toBe(0);
    expect(computeSwipeOffset(30, true)).toBe(30);
    expect(computeSwipeOffset(SWIPE_REPLY_THRESHOLD + 40, true)).toBe(SWIPE_REPLY_THRESHOLD + 10);
    expect(computeSwipeOffset(1000, true)).toBe(SWIPE_MAX_OFFSET);
  });

  it("fires the threshold haptic on either side", () => {
    expect(shouldFireThresholdHaptic(SWIPE_REPLY_THRESHOLD, false)).toBe(true);
    expect(shouldFireThresholdHaptic(SWIPE_REPLY_THRESHOLD - 1, false)).toBe(false);
  });

  it("activates and carries velocity toward the reply side only", () => {
    const [ltrMin, ltrMax] = swipeActiveOffsetX(false);
    const [rtlMin, rtlMax] = swipeActiveOffsetX(true);
    expect(ltrMin).toBeLessThan(0);
    expect(ltrMax).toBeGreaterThan(1000);
    expect(rtlMin).toBeLessThan(-1000);
    expect(rtlMax).toBeGreaterThan(0);
    expect(releaseVelocity(-300, false)).toBe(-300);
    expect(releaseVelocity(300, false)).toBe(0);
    expect(releaseVelocity(300, true)).toBe(300);
    expect(releaseVelocity(-300, true)).toBe(0);
  });
});

describe("SwipeToReply in RTL", () => {
  beforeEach(() => {
    pans().length = 0;
    mockSelection.mockClear();
    jest.replaceProperty(I18nManager, "isRTL", true);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("replies on a rightward drag past the threshold and ignores leftward drags", () => {
    const onReply = jest.fn();
    render(
      <SwipeToReply isEnabled message={MESSAGE} onReply={onReply}>
        <Text>bubble</Text>
      </SwipeToReply>,
    );
    const pan = latestPan();
    expect(pan.activeRange).toEqual(swipeActiveOffsetX(true));

    act(() => {
      pan.handlers.onBegin({});
      pan.handlers.onUpdate({ translationX: -(SWIPE_REPLY_THRESHOLD + 30) });
      pan.handlers.onEnd({});
      pan.handlers.onFinalize({});
    });
    expect(onReply).not.toHaveBeenCalled();

    act(() => {
      pan.handlers.onBegin({});
      pan.handlers.onUpdate({ translationX: SWIPE_REPLY_THRESHOLD + 30 });
      pan.handlers.onEnd({ velocityX: 400 });
      pan.handlers.onFinalize({});
    });
    expect(mockSelection).toHaveBeenCalledTimes(1);
    expect(onReply).toHaveBeenCalledWith(MESSAGE);
  });
});

describe("SwipeToReply", () => {
  beforeEach(() => {
    pans().length = 0;
    mockSelection.mockClear();
  });

  it("fires one haptic at the threshold and replies on release past it", () => {
    const onReply = jest.fn();
    render(
      <SwipeToReply isEnabled message={MESSAGE} onReply={onReply}>
        <Text>bubble</Text>
      </SwipeToReply>,
    );
    const pan = latestPan();

    act(() => {
      pan.handlers.onBegin({});
      pan.handlers.onUpdate({ translationX: -20 });
      pan.handlers.onUpdate({ translationX: -(SWIPE_REPLY_THRESHOLD + 5) });
      pan.handlers.onUpdate({ translationX: -(SWIPE_REPLY_THRESHOLD + 30) });
    });
    expect(mockSelection).toHaveBeenCalledTimes(1);

    act(() => {
      pan.handlers.onEnd({});
      pan.handlers.onFinalize({});
    });
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply).toHaveBeenCalledWith(MESSAGE);
  });

  it("does not repeat the haptic when dragging back and forth in one gesture", () => {
    render(
      <SwipeToReply isEnabled message={MESSAGE} onReply={jest.fn()}>
        <Text>bubble</Text>
      </SwipeToReply>,
    );
    const pan = latestPan();
    act(() => {
      pan.handlers.onBegin({});
      pan.handlers.onUpdate({ translationX: -(SWIPE_REPLY_THRESHOLD + 5) });
      pan.handlers.onUpdate({ translationX: -10 });
      pan.handlers.onUpdate({ translationX: -(SWIPE_REPLY_THRESHOLD + 5) });
    });
    expect(mockSelection).toHaveBeenCalledTimes(1);

    // A new gesture re-arms the latch.
    act(() => {
      pan.handlers.onEnd({ velocityX: -300 });
      pan.handlers.onFinalize({});
      pan.handlers.onBegin({});
      pan.handlers.onUpdate({ translationX: -(SWIPE_REPLY_THRESHOLD + 5) });
    });
    expect(mockSelection).toHaveBeenCalledTimes(2);
  });

  it("does not reply when released before the threshold", () => {
    const onReply = jest.fn();
    render(
      <SwipeToReply isEnabled message={MESSAGE} onReply={onReply}>
        <Text>bubble</Text>
      </SwipeToReply>,
    );
    const pan = latestPan();
    act(() => {
      pan.handlers.onBegin({});
      pan.handlers.onUpdate({ translationX: -(SWIPE_REPLY_THRESHOLD - 1) });
      pan.handlers.onEnd({});
      pan.handlers.onFinalize({});
    });
    expect(onReply).not.toHaveBeenCalled();
    expect(mockSelection).not.toHaveBeenCalled();
  });

  it("disables the gesture when replies aren't allowed", () => {
    render(
      <SwipeToReply isEnabled={false} message={MESSAGE} onReply={jest.fn()}>
        <Text>bubble</Text>
      </SwipeToReply>,
    );
    expect(latestPan().isEnabled).toBe(false);
  });

  it("activates on leftward drags in LTR", () => {
    render(
      <SwipeToReply isEnabled message={MESSAGE} onReply={jest.fn()}>
        <Text>bubble</Text>
      </SwipeToReply>,
    );
    expect(latestPan().activeRange).toEqual(swipeActiveOffsetX(false));
  });
});
