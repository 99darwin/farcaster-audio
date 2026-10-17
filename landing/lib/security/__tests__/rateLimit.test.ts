import {
  clientIpFromHeaders,
  createFixedWindowLimiter,
} from "@/lib/security/rateLimit";

describe("createFixedWindowLimiter", () => {
  it("allows up to the limit per window, then blocks", () => {
    const limiter = createFixedWindowLimiter({
      limit: 2,
      windowMs: 1000,
      maxKeys: 10,
    });
    expect(limiter.isAllowed("a", 0)).toBe(true);
    expect(limiter.isAllowed("a", 10)).toBe(true);
    expect(limiter.isAllowed("a", 20)).toBe(false);
    expect(limiter.isAllowed("b", 20)).toBe(true);
  });

  it("resets after the window", () => {
    const limiter = createFixedWindowLimiter({
      limit: 1,
      windowMs: 1000,
      maxKeys: 10,
    });
    expect(limiter.isAllowed("a", 0)).toBe(true);
    expect(limiter.isAllowed("a", 999)).toBe(false);
    expect(limiter.isAllowed("a", 1000)).toBe(true);
  });

  it("never tracks more than maxKeys buckets", () => {
    const limiter = createFixedWindowLimiter({
      limit: 1,
      windowMs: 1000,
      maxKeys: 2,
    });
    expect(limiter.isAllowed("a", 0)).toBe(true);
    expect(limiter.isAllowed("b", 0)).toBe(true);
    expect(limiter.isAllowed("c", 0)).toBe(true); // evicts "a"
    expect(limiter.isAllowed("a", 0)).toBe(true); // fresh bucket
    expect(limiter.isAllowed("a", 1)).toBe(false);
  });
});

describe("clientIpFromHeaders", () => {
  it("prefers x-real-ip", () => {
    const headers = new Headers({
      "x-real-ip": "1.1.1.1",
      "x-forwarded-for": "2.2.2.2",
    });
    expect(clientIpFromHeaders(headers)).toBe("1.1.1.1");
  });

  it("falls back to the first x-forwarded-for entry", () => {
    const headers = new Headers({ "x-forwarded-for": "2.2.2.2, 3.3.3.3" });
    expect(clientIpFromHeaders(headers)).toBe("2.2.2.2");
  });

  it("returns unknown without headers", () => {
    expect(clientIpFromHeaders(new Headers())).toBe("unknown");
  });
});
