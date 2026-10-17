import {
  readPartnerTokenFromHash,
  scrubAnalyticsUrl,
  stripPartnerToken,
} from "@/lib/embed-partner-token";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJmaWQiOjF9.sig";

describe("readPartnerTokenFromHash", () => {
  it("reads #token=", () => {
    expect(readPartnerTokenFromHash(`#token=${JWT}`)).toBe(JWT);
  });

  it("reads token among other fragment params", () => {
    expect(readPartnerTokenFromHash(`#audio=off&token=${JWT}`)).toBe(JWT);
  });

  it.each(["", "#", "#token=", "#other=1"])("returns null for %p", (hash) => {
    expect(readPartnerTokenFromHash(hash)).toBeNull();
  });
});

describe("stripPartnerToken", () => {
  it("removes the query token and keeps other params", () => {
    expect(
      stripPartnerToken(`https://juke.audio/embed/abc?audio=off&token=${JWT}`),
    ).toBe("https://juke.audio/embed/abc?audio=off");
  });

  it("removes the fragment token and an emptied fragment", () => {
    expect(stripPartnerToken(`https://juke.audio/embed/abc#token=${JWT}`)).toBe(
      "https://juke.audio/embed/abc",
    );
  });

  it("keeps unrelated fragment params", () => {
    expect(
      stripPartnerToken(`https://juke.audio/embed/abc#token=${JWT}&x=1`),
    ).toBe("https://juke.audio/embed/abc#x=1");
  });

  it("leaves a token-free URL unchanged", () => {
    const url = "https://juke.audio/embed/abc?audio=off#section";
    expect(stripPartnerToken(url)).toBe(url);
  });
});

describe("scrubAnalyticsUrl", () => {
  it("drops credential params and the fragment", () => {
    expect(
      scrubAnalyticsUrl(
        `https://juke.audio/embed/abc?audio=off&token=${JWT}&prepare_id=p#token=${JWT}`,
      ),
    ).toBe("https://juke.audio/embed/abc?audio=off");
  });

  it("returns null for an unparseable URL so the event is discarded", () => {
    expect(scrubAnalyticsUrl("::not a url")).toBeNull();
  });
});
