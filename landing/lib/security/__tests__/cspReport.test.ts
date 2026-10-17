import {
  MAX_CSP_VIOLATIONS_PER_REQUEST,
  parseCspReports,
} from "@/lib/security/cspReport";

describe("parseCspReports", () => {
  it("reads the legacy report-uri format", () => {
    expect(
      parseCspReports({
        "csp-report": {
          "document-uri": "https://juke.audio/app/login",
          "blocked-uri": "wss://eu.livekit.example/rtc",
          "violated-directive": "connect-src",
          "effective-directive": "connect-src",
          "original-policy": "default-src 'self'",
        },
      }),
    ).toEqual([
      {
        documentUri: "https://juke.audio/app/login",
        blockedUri: "wss://eu.livekit.example/rtc",
        directive: "connect-src",
      },
    ]);
  });

  it("falls back to violated-directive when effective-directive is absent", () => {
    const [violation] = parseCspReports({
      "csp-report": { "violated-directive": "img-src" },
    });
    expect(violation.directive).toBe("img-src");
  });

  it("reads Reporting API batches and skips other report types", () => {
    expect(
      parseCspReports([
        {
          type: "csp-violation",
          body: {
            documentURL: "https://juke.audio/app",
            blockedURL: "https://new-bucket.example/upload",
            effectiveDirective: "connect-src",
          },
        },
        { type: "deprecation", body: { id: "x" } },
        { type: "csp-violation" },
      ]),
    ).toEqual([
      {
        documentUri: "https://juke.audio/app",
        blockedUri: "https://new-bucket.example/upload",
        directive: "connect-src",
      },
    ]);
  });

  it("strips query strings and fragments that may carry secrets", () => {
    const [violation] = parseCspReports({
      "csp-report": {
        "document-uri": "https://juke.audio/app/login?code=secret#frag",
        "blocked-uri":
          "https://storage.example/bucket/key?X-Amz-Signature=deadbeef",
      },
    });
    expect(violation.documentUri).toBe("https://juke.audio/app/login");
    expect(violation.blockedUri).toBe("https://storage.example/bucket/key");
  });

  it("reduces non-network URLs to their scheme and keeps keywords", () => {
    const [dataUri] = parseCspReports({
      "csp-report": { "blocked-uri": "data:text/html;base64,PHNjcmlwdD4=" },
    });
    const [inline] = parseCspReports({
      "csp-report": { "blocked-uri": "inline" },
    });
    expect(dataUri.blockedUri).toBe("data");
    expect(inline.blockedUri).toBe("inline");
  });

  it("caps field length and the number of violations per request", () => {
    const longPath = `https://juke.audio/${"a".repeat(1000)}`;
    const batch = Array.from({ length: 50 }, () => ({
      type: "csp-violation",
      body: { documentURL: longPath, effectiveDirective: "x".repeat(1000) },
    }));
    const violations = parseCspReports(batch);
    expect(violations).toHaveLength(MAX_CSP_VIOLATIONS_PER_REQUEST);
    expect(violations[0].documentUri.length).toBeLessThanOrEqual(256);
    expect(violations[0].directive.length).toBeLessThanOrEqual(256);
  });

  it.each([null, 42, "text", {}, { "csp-report": "nope" }, [1, "two"]])(
    "ignores unknown shape %p",
    (payload) => {
      expect(parseCspReports(payload)).toEqual([]);
    },
  );

  it("ignores non-string fields", () => {
    expect(
      parseCspReports({
        "csp-report": { "document-uri": 7, "blocked-uri": { a: 1 } },
      }),
    ).toEqual([{ documentUri: "", blockedUri: "", directive: "" }]);
  });
});
