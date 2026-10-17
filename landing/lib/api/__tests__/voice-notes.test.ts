import {
  clampDurationMs,
  pickRecorderMimeType,
  MAX_RECORDING_MS,
} from "@/lib/api/voice-notes";

describe("pickRecorderMimeType", () => {
  it("prefers audio/mp4 when supported (Safari + recent Chromium)", () => {
    const result = pickRecorderMimeType((t) => t === "audio/mp4");
    expect(result).toEqual({
      mimeType: "audio/mp4",
      uploadContentType: "audio/mp4",
    });
  });

  it("falls back to webm/opus and maps it onto an accepted content type", () => {
    // Firefox / older Chromium: only webm is recordable.
    const result = pickRecorderMimeType((t) => t.startsWith("audio/webm"));
    expect(result?.mimeType).toBe("audio/webm;codecs=opus");
    // Backend only accepts mp4|aac|mp3, so webm bytes ship as audio/mp4.
    expect(result?.uploadContentType).toBe("audio/mp4");
  });

  it("returns null when no candidate is supported (hide the mic button)", () => {
    expect(pickRecorderMimeType(() => false)).toBeNull();
  });

  it("keeps mp4 ahead of webm when both are supported", () => {
    const result = pickRecorderMimeType(() => true);
    expect(result?.mimeType).toBe("audio/mp4");
  });
});

describe("clampDurationMs", () => {
  it("caps at the backend 60s limit", () => {
    expect(clampDurationMs(120_000)).toBe(MAX_RECORDING_MS);
  });

  it("rounds fractional milliseconds to an integer", () => {
    expect(clampDurationMs(1234.7)).toBe(1235);
  });

  it("coerces zero / negative / NaN to a valid positive duration", () => {
    expect(clampDurationMs(0)).toBe(1);
    expect(clampDurationMs(-50)).toBe(1);
    expect(clampDurationMs(Number.NaN)).toBe(1);
  });

  it("passes through an in-range value unchanged", () => {
    expect(clampDurationMs(4200)).toBe(4200);
  });
});
