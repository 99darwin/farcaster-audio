import { describe, expect, it } from "@jest/globals";
import { REACTION_EMOJI } from "@/constants/emoji";

describe("REACTION_EMOJI", () => {
  it("contains the expanded fixed reaction set", () => {
    expect(REACTION_EMOJI.map((emoji) => emoji.key)).toEqual([
      "1f44f",
      "1f4af",
      "1f602",
      "1f62d",
      "1f44d",
      "1f525",
      "2764",
      "1f440",
      "1f64c",
      "1f914",
      "1f389",
      "1fae1",
    ]);
  });
});
