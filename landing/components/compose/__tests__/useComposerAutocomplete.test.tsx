import { describe, expect, it } from "@jest/globals";
import {
  autocompleteContextKey,
  resultsForAutocompleteContext,
  shouldSuppressPendingAutocompleteKey,
} from "../useComposerAutocomplete";

describe("useComposerAutocomplete result identity", () => {
  const aliceRows = [{ username: "alice" }];
  const aliceContext = autocompleteContextKey("mention", {
    start: 0,
    query: "al",
  });
  const bobContext = autocompleteContextKey("mention", {
    start: 0,
    query: "bob",
  });

  it("clears prior results synchronously when the token query changes", () => {
    expect(
      resultsForAutocompleteContext(aliceRows, aliceContext, bobContext),
    ).toEqual([]);
    expect(
      resultsForAutocompleteContext(aliceRows, aliceContext, aliceContext),
    ).toBe(aliceRows);
  });

  it.each(["Enter", "Tab"])(
    "suppresses %s while the replacement query is pending",
    (key) => {
      expect(
        shouldSuppressPendingAutocompleteKey(key, bobContext, null),
      ).toBe(true);
      expect(
        shouldSuppressPendingAutocompleteKey(key, bobContext, bobContext),
      ).toBe(false);
    },
  );
});
