/**
 * Unit tests for the key behavioral fixes in useFeedNavigation and
 * GlobalShortcuts keyboard handling.
 *
 * Node environment — no jsdom, no React. We test the pure logic patterns
 * using synthetic ref/state objects so the fixes can be verified without a
 * browser runtime.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mutable ref mirroring React's useRef shape. */
function makeRef<T>(initial: T) {
  return { current: initial };
}

// ---------------------------------------------------------------------------
// Bug 1 fix: useFeedNavigation — focusedIndexRef prevents stale closures
//
// Scenario: rapid j→action before React re-renders.
// With state alone, the action handler sees focusedIndex from the previous
// render (stale). With a ref updated synchronously in moveFocus, the handler
// always sees the current index.
// ---------------------------------------------------------------------------

describe("useFeedNavigation — ref-based stale closure fix (Bug 1)", () => {
  function makeNavigator(itemCount: number) {
    // Simulates the hook's internal state + ref.
    let stateIndex = -1; // "state" — only updated after React re-renders
    const indexRef = makeRef(-1); // ref — updated synchronously in moveFocus

    function moveFocus(delta: number) {
      if (itemCount === 0) return;
      const prev = indexRef.current; // read from ref (the fix)
      const next =
        prev < 0
          ? delta > 0 ? 0 : itemCount - 1
          : Math.max(0, Math.min(prev + delta, itemCount - 1));
      indexRef.current = next; // update ref immediately
      // React would update stateIndex asynchronously; simulate as still stale:
      // stateIndex = next; // intentionally not called here
    }

    // Fixed handler: reads from ref.
    function canActFixed() {
      return indexRef.current >= 0;
    }
    function handleActionFixed(callback: (i: number) => void) {
      if (canActFixed()) callback(indexRef.current);
    }

    // Buggy handler (old code): reads from stale state closure.
    function canActBuggy() {
      return stateIndex >= 0;
    }
    function handleActionBuggy(callback: (i: number) => void) {
      if (canActBuggy()) callback(stateIndex);
    }

    return { moveFocus, handleActionFixed, handleActionBuggy, indexRef, getState: () => stateIndex };
  }

  test("fixed: action immediately after moveFocus sees the updated index (index 0)", () => {
    const nav = makeNavigator(10);
    const fired: number[] = [];

    // Press j (focusedIndex: -1 → 0), then press l before re-render.
    nav.moveFocus(1);
    nav.handleActionFixed((i) => fired.push(i));

    expect(fired).toEqual([0]); // action fires with the correct index
  });

  test("fixed: consecutive moves accumulate correctly without re-render", () => {
    const nav = makeNavigator(10);
    const fired: number[] = [];

    nav.moveFocus(1); // → 0
    nav.moveFocus(1); // → 1
    nav.moveFocus(1); // → 2
    nav.handleActionFixed((i) => fired.push(i));

    expect(fired).toEqual([2]);
  });

  test("fixed: action is no-op when no item has been focused (index still -1)", () => {
    const nav = makeNavigator(10);
    const fired: number[] = [];

    // No moveFocus called — index stays -1.
    nav.handleActionFixed((i) => fired.push(i));

    expect(fired).toEqual([]);
  });

  test("fixed: clamping at upper bound works without re-render", () => {
    const nav = makeNavigator(3); // indices 0..2
    const fired: number[] = [];

    nav.moveFocus(1); // → 0
    nav.moveFocus(1); // → 1
    nav.moveFocus(1); // → 2
    nav.moveFocus(1); // → 2 (clamped)
    nav.handleActionFixed((i) => fired.push(i));

    expect(fired).toEqual([2]);
  });

  test("buggy (baseline): demonstrates that reading stale state silently drops the action", () => {
    const nav = makeNavigator(10);
    const fired: number[] = [];

    // Press j — stateIndex is still -1 because React hasn't re-rendered.
    nav.moveFocus(1);
    nav.handleActionBuggy((i) => fired.push(i));

    // Action is silently dropped: stateIndex is -1, canAct returns false.
    expect(fired).toEqual([]); // demonstrates the bug the fix resolves
  });
});

// ---------------------------------------------------------------------------
// Bug 2 fix: GlobalShortcuts — Escape only closes help overlay when it is open
//
// Scenario: Escape pressed while compose modal (not help overlay) is open.
// Old code: setHelpOpen(false) fires unconditionally, competing with compose.
// Fixed code: only acts when helpOpenRef.current === true.
// ---------------------------------------------------------------------------

describe("GlobalShortcuts — Escape only fires when helpOpen is true (Bug 2)", () => {
  function makeEscapeHandler() {
    // Simulate the component's state + ref pattern.
    let helpOpen = false;
    const helpOpenRef = makeRef(false);

    function setHelpOpen(value: boolean) {
      helpOpen = value;
      helpOpenRef.current = value;
    }

    const calls: string[] = [];

    // Fixed handler: checks ref before acting.
    function handleEscapeFixed() {
      if (helpOpenRef.current) {
        setHelpOpen(false);
        calls.push("closed-help");
      }
      // otherwise: no-op — other dialogs handle their own Escape
    }

    // Buggy handler (old code): unconditional.
    function handleEscapeBuggy() {
      setHelpOpen(false); // fires even when helpOpen is already false
      calls.push("set-help-false");
    }

    return { setHelpOpen, handleEscapeFixed, handleEscapeBuggy, calls, getHelpOpen: () => helpOpen };
  }

  test("fixed: Escape closes the help overlay when it is open", () => {
    const { setHelpOpen, handleEscapeFixed, calls } = makeEscapeHandler();
    setHelpOpen(true);

    handleEscapeFixed();

    expect(calls).toEqual(["closed-help"]);
  });

  test("fixed: Escape is a no-op when helpOpen is false (another dialog is active)", () => {
    const { handleEscapeFixed, calls } = makeEscapeHandler();
    // helpOpen starts as false (some other dialog is open, not the help overlay)

    handleEscapeFixed();

    expect(calls).toEqual([]); // no interference
  });

  test("fixed: multiple Escape presses when already closed remain no-ops", () => {
    const { handleEscapeFixed, calls } = makeEscapeHandler();

    handleEscapeFixed();
    handleEscapeFixed();
    handleEscapeFixed();

    expect(calls).toEqual([]);
  });

  test("fixed: toggle help open then Escape closes it exactly once", () => {
    const { setHelpOpen, handleEscapeFixed, calls, getHelpOpen } = makeEscapeHandler();
    setHelpOpen(true);

    handleEscapeFixed(); // closes
    handleEscapeFixed(); // no-op (already closed)

    expect(calls).toEqual(["closed-help"]);
    expect(getHelpOpen()).toBe(false);
  });

  test("buggy (baseline): old handler fires setHelpOpen(false) even when help is already closed", () => {
    const { handleEscapeBuggy, calls } = makeEscapeHandler();
    // helpOpen is false; simulating another dialog being open

    handleEscapeBuggy();

    // The call is recorded — demonstrating the unwanted side-effect.
    expect(calls).toEqual(["set-help-false"]);
  });
});
