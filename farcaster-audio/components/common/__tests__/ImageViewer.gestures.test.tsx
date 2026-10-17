import React from "react";
import { Text } from "react-native";
import { act, render } from "@testing-library/react-native";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { ZoomableImage } from "@/components/common/ImageViewer";

type HandlerMap = Record<string, (...args: any[]) => void>;

class MockGestureBuilder {
  handlers: HandlerMap = {};
  simultaneous: MockGestureBuilder[] = [];

  enabled() { return this; }
  maxPointers() { return this; }
  activeOffsetY() { return this; }
  failOffsetX() { return this; }
  numberOfTaps() { return this; }
  simultaneousWithExternalGesture(...gestures: MockGestureBuilder[]) {
    this.simultaneous.push(...gestures);
    return this;
  }
  onStart(callback: HandlerMap[string]) {
    this.handlers.onStart = callback;
    return this;
  }
  onUpdate(callback: HandlerMap[string]) {
    this.handlers.onUpdate = callback;
    return this;
  }
  onEnd(callback: HandlerMap[string]) {
    this.handlers.onEnd = callback;
    return this;
  }
  onFinalize(callback: HandlerMap[string]) {
    this.handlers.onFinalize = callback;
    return this;
  }
  onTouchesDown(callback: HandlerMap[string]) {
    this.handlers.onTouchesDown = callback;
    return this;
  }
  onTouchesMove(callback: HandlerMap[string]) {
    this.handlers.onTouchesMove = callback;
    return this;
  }
}

const mockRegistry = () =>
  (globalThis as any).__imageViewerGestureRegistry as {
    pinches: MockGestureBuilder[];
    pans: MockGestureBuilder[];
    taps: MockGestureBuilder[];
  };

jest.mock("react-native-gesture-handler", () => {
  const React = require("react");
  const { View } = require("react-native");
  const registry = ((globalThis as any).__imageViewerGestureRegistry = {
    pinches: [],
    pans: [],
    taps: [],
  });
  const make = (bucket: MockGestureBuilder[]) => () => {
    const gesture = new MockGestureBuilder();
    bucket.push(gesture);
    return gesture;
  };
  return {
    Gesture: {
      Native: () => new MockGestureBuilder(),
      Pinch: make(registry.pinches),
      Pan: make(registry.pans),
      Tap: make(registry.taps),
      Simultaneous: (...gestures: MockGestureBuilder[]) => ({ gestures }),
      Exclusive: (...gestures: MockGestureBuilder[]) => ({ gestures }),
    },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
    GestureHandlerRootView: ({ children, ...props }: any) => (
      <View {...props}>{children}</View>
    ),
  };
});

jest.mock("react-native-reanimated", () => {
  const React = require("react");
  const { View } = require("react-native");
  (globalThis as any).__imageViewerRunOnJSCalls = [];
  return {
    __esModule: true,
    default: { View: (props: any) => React.createElement(View, props) },
    useSharedValue: (value: unknown) => React.useRef({ value }).current,
    useAnimatedStyle: (factory: () => unknown) => factory(),
    withSpring: (value: unknown) => value,
    withTiming: (value: unknown, _config?: unknown, done?: (ok: boolean) => void) => {
      done?.(true);
      return value;
    },
    withDecay: () => 0,
    runOnJS: (callback: (...args: any[]) => unknown) =>
      (...args: any[]) => {
        (globalThis as any).__imageViewerRunOnJSCalls.push(args);
        return callback(...args);
      },
  };
});

jest.mock("expo-image", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    Image: (props: any) =>
      React.createElement(View, { accessibilityLabel: props.source?.uri }),
  };
});

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { Ionicons: () => React.createElement(View) };
});

beforeEach(() => {
  mockRegistry().pinches.length = 0;
  mockRegistry().pans.length = 0;
  mockRegistry().taps.length = 0;
  (globalThis as any).__imageViewerRunOnJSCalls.length = 0;
});

describe("ZoomableImage gesture lifetime", () => {
  it("keeps the active gesture objects mounted across zoom-state renders", () => {
    function Harness() {
      const [zoomed, setZoomed] = React.useState(false);
      const zoomedShared = React.useRef({ value: false }).current;
      const scrollGesture = React.useMemo(() => new MockGestureBuilder(), []);
      const dismissGesture = React.useMemo(() => new MockGestureBuilder(), []);
      return (
        <>
          <ZoomableImage
            uri="https://example.com/one.jpg"
            width={390}
            height={844}
            onZoomChange={setZoomed}
            zoomedShared={zoomedShared as any}
            scrollGesture={scrollGesture as any}
            dismissGesture={dismissGesture as any}
          />
          <Text testID="zoom-state">{String(zoomed)}</Text>
        </>
      );
    }

    const screen = render(<Harness />);

    expect(screen.getByTestId("zoom-state").props.children).toBe("false");
    expect(mockRegistry().pinches).toHaveLength(1);

    const pinch = mockRegistry().pinches[0];
    const pinchCount = mockRegistry().pinches.length;
    const panCount = mockRegistry().pans.length;

    act(() => {
      pinch.handlers.onStart({ focalX: 120, focalY: 240 });
    });

    expect((globalThis as any).__imageViewerRunOnJSCalls).toContainEqual([true]);
    expect(screen.getByTestId("zoom-state").props.children).toBe("true");

    // The parent render scheduled by setZoomed must not replace the active
    // pinch or one-finger zoom-pan recognizers.
    expect(mockRegistry().pinches).toHaveLength(pinchCount);
    expect(mockRegistry().pans).toHaveLength(panCount);

    act(() => {
      pinch.handlers.onUpdate({ scale: 2, focalX: 150, focalY: 260 });
      pinch.handlers.onEnd({}, true);
      pinch.handlers.onFinalize({}, true);
    });

    const doubleTap = mockRegistry().taps[0];
    act(() => {
      doubleTap.handlers.onEnd({ x: 150, y: 260 });
    });

    expect(screen.getByTestId("zoom-state").props.children).toBe("false");
    expect(mockRegistry().pinches).toHaveLength(pinchCount);
    expect(mockRegistry().pans).toHaveLength(panCount);
  });

  it("releases paging and dismiss arbitration after zoom, pan, and double-tap reset", () => {
    const scrollGesture = new MockGestureBuilder();
    const dismissGesture = new MockGestureBuilder();
    const zoomedShared = { value: false };

    function Harness() {
      const [zoomed, setZoomed] = React.useState(false);
      return (
        <>
          <ZoomableImage
            uri="https://example.com/one.jpg"
            width={390}
            height={844}
            onZoomChange={setZoomed}
            zoomedShared={zoomedShared as any}
            scrollGesture={scrollGesture as any}
            dismissGesture={dismissGesture as any}
          />
          <Text testID="zoom-state">{String(zoomed)}</Text>
        </>
      );
    }

    const screen = render(<Harness />);
    const pinch = mockRegistry().pinches[0];
    const zoomPan = mockRegistry().pans[0];
    const doubleTap = mockRegistry().taps[0];

    act(() => {
      pinch.handlers.onStart({ focalX: 120, focalY: 240 });
      pinch.handlers.onUpdate({ scale: 2, focalX: 150, focalY: 260 });
      pinch.handlers.onEnd({}, true);
      pinch.handlers.onFinalize({}, true);
      zoomPan.handlers.onStart({});
      zoomPan.handlers.onUpdate({ translationX: 32, translationY: 18 });
      zoomPan.handlers.onEnd(
        { velocityX: 0, velocityY: 0 },
        true,
      );
    });

    expect(screen.getByTestId("zoom-state").props.children).toBe("true");
    expect(zoomedShared.value).toBe(true);
    const zoomedStateManager = { fail: jest.fn() };
    act(() => {
      zoomPan.handlers.onTouchesMove(
        { numberOfTouches: 1 },
        zoomedStateManager,
      );
    });
    expect(zoomedStateManager.fail).not.toHaveBeenCalled();

    act(() => {
      doubleTap.handlers.onEnd({ x: 150, y: 260 });
    });

    expect(screen.getByTestId("zoom-state").props.children).toBe("false");
    expect(zoomedShared.value).toBe(false);
    expect(zoomPan.simultaneous).toEqual(
      expect.arrayContaining([scrollGesture, dismissGesture]),
    );

    // Failing the zoom-only pan at first finger-down also fails native iOS
    // pinch composition before the second finger arrives. It may release the
    // carousel only after a one-finger move, and must remain available for a
    // two-finger pinch.
    const twoFingerStateManager = { fail: jest.fn() };
    act(() => {
      zoomPan.handlers.onTouchesMove(
        { numberOfTouches: 2 },
        twoFingerStateManager,
      );
    });
    expect(twoFingerStateManager.fail).not.toHaveBeenCalled();

    const oneFingerStateManager = { fail: jest.fn() };
    act(() => {
      zoomPan.handlers.onTouchesMove(
        { numberOfTouches: 1 },
        oneFingerStateManager,
      );
    });
    expect(oneFingerStateManager.fail).toHaveBeenCalledTimes(1);
  });
});
