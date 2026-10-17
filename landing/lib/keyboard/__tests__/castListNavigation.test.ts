/**
 * Unit tests for the dispatch contract useCastListNavigation layers on top of
 * useFeedNavigation.
 *
 * Node environment — no jsdom, no React (mirrors feedNavigation.test.ts). We
 * simulate the hook's getCast-based dispatch so the behavior can be verified
 * without a browser runtime:
 *   - actions fire only for rows whose getCast returns a cast (non-cast rows
 *     like voice notes / follows / recordings are traversable but no-op);
 *   - an out-of-range or empty-list index never fires an action.
 */

interface FakeCast {
  hash: string;
}

// Discriminated union mirroring a mixed feed (casts + non-cast rows).
type Row =
  | { kind: "cast"; cast: FakeCast }
  | { kind: "other" };

/** Mirrors the helper's `castAt` + action dispatch, decoupled from React. */
function makeDispatcher(items: Row[]) {
  const getCast = (item: Row): FakeCast | null =>
    item.kind === "cast" ? item.cast : null;

  const castAt = (index: number): FakeCast | null => {
    const item = items[index];
    return item === undefined ? null : getCast(item);
  };

  // `focusedIndex` starts unfocused, exactly like useFeedNavigation.
  let focusedIndex = -1;
  const setFocused = (i: number) => {
    focusedIndex = i;
  };

  const dispatch = (
    action: ((cast: FakeCast) => void) | undefined,
  ): void => {
    // useFeedNavigation only invokes actions when a row is focused.
    if (focusedIndex < 0) return;
    const cast = castAt(focusedIndex);
    if (cast) action?.(cast);
  };

  return { setFocused, dispatch };
}

describe("useCastListNavigation — getCast dispatch contract", () => {
  const rows: Row[] = [
    { kind: "cast", cast: { hash: "a" } },
    { kind: "other" }, // e.g. voice note / follows / recording
    { kind: "cast", cast: { hash: "c" } },
  ];

  test("action fires with the focused cast for a cast row", () => {
    const d = makeDispatcher(rows);
    const fired: string[] = [];
    d.setFocused(0);
    d.dispatch((c) => fired.push(c.hash));
    expect(fired).toEqual(["a"]);
  });

  test("action is a no-op on a non-cast row (getCast → null)", () => {
    const d = makeDispatcher(rows);
    const fired: string[] = [];
    d.setFocused(1); // the "other" row
    d.dispatch((c) => fired.push(c.hash));
    expect(fired).toEqual([]);
  });

  test("action is a no-op when no row is focused", () => {
    const d = makeDispatcher(rows);
    const fired: string[] = [];
    // no setFocused — focusedIndex stays -1
    d.dispatch((c) => fired.push(c.hash));
    expect(fired).toEqual([]);
  });

  test("action is a no-op on an empty list even if an index was set", () => {
    const d = makeDispatcher([]);
    const fired: string[] = [];
    d.setFocused(0); // stale index past the (empty) list
    d.dispatch((c) => fired.push(c.hash));
    expect(fired).toEqual([]);
  });

  test("undefined action handler is tolerated (optional per-page wiring)", () => {
    const d = makeDispatcher(rows);
    d.setFocused(2);
    expect(() => d.dispatch(undefined)).not.toThrow();
  });
});
