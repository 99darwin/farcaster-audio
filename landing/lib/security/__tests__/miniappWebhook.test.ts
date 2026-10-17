import {
  MAX_MINIAPP_WEBHOOK_BYTES,
  parseJfsEnvelope,
  proxyStatusFor,
} from "@/lib/security/miniappWebhook";

const VALID = {
  header: "eyJmaWQiOjF9",
  payload: "eyJldmVudCI6Im1pbmlhcHBfYWRkZWQifQ",
  signature: "c2lnbmF0dXJl",
};

describe("parseJfsEnvelope", () => {
  it("returns exactly the three envelope fields", () => {
    expect(parseJfsEnvelope({ ...VALID, fid: 999, extra: "x" })).toEqual(VALID);
  });

  it("accepts padded base64url", () => {
    expect(
      parseJfsEnvelope({ ...VALID, signature: "c2lnbg==" }),
    ).not.toBeNull();
  });

  it.each([null, "str", 42, [VALID]])("rejects non-object %p", (raw) => {
    expect(parseJfsEnvelope(raw)).toBeNull();
  });

  it.each(["header", "payload", "signature"] as const)(
    "rejects a missing or empty %s",
    (field) => {
      const { [field]: _omitted, ...rest } = VALID;
      expect(parseJfsEnvelope(rest)).toBeNull();
      expect(parseJfsEnvelope({ ...VALID, [field]: "" })).toBeNull();
      expect(parseJfsEnvelope({ ...VALID, [field]: 123 })).toBeNull();
    },
  );

  it("rejects the legacy trusted-fid shape", () => {
    expect(
      parseJfsEnvelope({
        fid: 1,
        event: "miniapp_added",
        notification_url: "x",
      }),
    ).toBeNull();
  });

  it("rejects non-base64url characters", () => {
    expect(parseJfsEnvelope({ ...VALID, header: "a+b/c" })).toBeNull();
    expect(parseJfsEnvelope({ ...VALID, payload: "abc.def" })).toBeNull();
  });

  it("rejects oversized parts", () => {
    expect(parseJfsEnvelope({ ...VALID, header: "a".repeat(1025) })).toBeNull();
    expect(
      parseJfsEnvelope({ ...VALID, payload: "a".repeat(8193) }),
    ).toBeNull();
    expect(
      parseJfsEnvelope({ ...VALID, signature: "a".repeat(257) }),
    ).toBeNull();
  });

  it("keeps the body cap above the largest valid envelope", () => {
    const largest = JSON.stringify({
      header: "a".repeat(1024),
      payload: "a".repeat(8192),
      signature: "a".repeat(256),
    });
    expect(largest.length).toBeLessThan(MAX_MINIAPP_WEBHOOK_BYTES);
  });
});

describe("proxyStatusFor", () => {
  it("maps 2xx to 200", () => {
    expect(proxyStatusFor(200)).toBe(200);
    expect(proxyStatusFor(204)).toBe(200);
  });

  it.each([400, 401, 413, 429])(
    "passes verification verdict %d through",
    (code) => {
      expect(proxyStatusFor(code)).toBe(code);
    },
  );

  it.each([404, 422, 500, 503])("maps backend fault %d to 502", (code) => {
    expect(proxyStatusFor(code)).toBe(502);
  });
});
