import {
  CSP_REPORT_GROUP,
  CSP_REPORT_PATH,
  FRAME_ANCESTORS_NONE,
  REPORTING_ENDPOINTS_VALUE,
  buildContentSecurityPolicy,
  createNonce,
  isUnframeablePath,
  toApiConnectSources,
  type ContentSecurityPolicyOptions,
} from "@/lib/security/csp";

const NONCE = "AAECAwQFBgcICQoLDA0ODw==";

const BASE_OPTIONS: ContentSecurityPolicyOptions = {
  nonce: NONCE,
  frameAncestors: ["https://client.farcaster.xyz", "https://*.farcaster.xyz"],
  apiBaseUrl: "https://your-api-host.example.com",
  hypersnapConnectSource: "https://haatz.quilibrium.com",
  isDevelopment: false,
};

/** Parse a serialized policy into directive -> sources. */
function parsePolicy(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const directive of policy.split("; ")) {
    const [name, ...sources] = directive.split(" ");
    expect(directives.has(name)).toBe(false);
    directives.set(name, sources);
  }
  return directives;
}

function directive(
  options: Partial<ContentSecurityPolicyOptions>,
  name: string,
): string[] {
  const sources = parsePolicy(
    buildContentSecurityPolicy({ ...BASE_OPTIONS, ...options }),
  ).get(name);
  if (!sources) throw new Error(`missing directive ${name}`);
  return sources;
}

describe("createNonce", () => {
  it("returns 128 bits of base64", () => {
    const nonce = createNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(Buffer.from(nonce, "base64")).toHaveLength(16);
  });

  it("is fresh on every call", () => {
    const nonces = new Set(Array.from({ length: 50 }, createNonce));
    expect(nonces.size).toBe(50);
  });
});

describe("buildContentSecurityPolicy", () => {
  it("locks scripts to the nonce with strict-dynamic in production", () => {
    expect(directive({}, "script-src")).toEqual([
      "'self'",
      `'nonce-${NONCE}'`,
      "'strict-dynamic'",
    ]);
  });

  it("never allows inline or eval script in production", () => {
    const policy = buildContentSecurityPolicy(BASE_OPTIONS);
    const scriptSources = directive({}, "script-src");
    expect(scriptSources).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
  });

  it("adds unsafe-eval only for the dev server", () => {
    const sources = directive({ isDevelopment: true }, "script-src");
    expect(sources).toContain("'unsafe-eval'");
    expect(sources).not.toContain("'unsafe-inline'");
  });

  it("sets the hardening directives", () => {
    const directives = parsePolicy(buildContentSecurityPolicy(BASE_OPTIONS));
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'self'"]);
    expect(directives.get("form-action")).toEqual(["'self'"]);
    expect(directives.get("default-src")).toEqual(["'self'"]);
  });

  it("limits connect-src to the API, Hypersnap node and inventoried hosts", () => {
    const sources = directive({}, "connect-src");
    expect(sources).toEqual(
      expect.arrayContaining([
        "'self'",
        "https://your-api-host.example.com",
        "wss://your-api-host.example.com",
        "https://haatz.quilibrium.com",
      ]),
    );
    expect(sources).not.toContain("https:");
    expect(sources).not.toContain("*");
  });

  it("follows the configured API and Hypersnap origins", () => {
    const sources = directive(
      {
        apiBaseUrl: "https://staging-api.example.com/base/",
        hypersnapConnectSource: "https://node.example.org",
      },
      "connect-src",
    );
    expect(sources).toEqual(
      expect.arrayContaining([
        "https://staging-api.example.com",
        "wss://staging-api.example.com",
        "https://node.example.org",
      ]),
    );
    expect(sources).not.toContain("https://your-api-host.example.com");
  });

  it("serializes frame-ancestors from the given sources", () => {
    expect(directive({ frameAncestors: ["*"] }, "frame-ancestors")).toEqual([
      "*",
    ]);
    expect(
      directive(
        { frameAncestors: ["https://a.example", "https://b.example:8443"] },
        "frame-ancestors",
      ),
    ).toEqual(["https://a.example", "https://b.example:8443"]);
  });

  it("serializes frame-ancestors 'none'", () => {
    expect(
      directive({ frameAncestors: FRAME_ANCESTORS_NONE }, "frame-ancestors"),
    ).toEqual(["'none'"]);
  });

  it("reports violations to the same-origin collector", () => {
    expect(directive({}, "report-uri")).toEqual(["/api/csp-report"]);
    expect(directive({}, "report-to")).toEqual([CSP_REPORT_GROUP]);
    expect(REPORTING_ENDPOINTS_VALUE).toBe(
      `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`,
    );
  });

  it("rejects an empty frame-ancestors list", () => {
    expect(() =>
      buildContentSecurityPolicy({ ...BASE_OPTIONS, frameAncestors: [] }),
    ).toThrow(TypeError);
  });

  it.each(["", "abc'; script-src *", "not base64!"])(
    "rejects a malformed nonce %p",
    (nonce) => {
      expect(() =>
        buildContentSecurityPolicy({ ...BASE_OPTIONS, nonce }),
      ).toThrow(TypeError);
    },
  );

  it("embeds a fresh nonce per call", () => {
    const first = createNonce();
    const second = createNonce();
    expect(buildContentSecurityPolicy({ ...BASE_OPTIONS, nonce: first })).not
      .toEqual(buildContentSecurityPolicy({ ...BASE_OPTIONS, nonce: second }));
  });
});

describe("toApiConnectSources", () => {
  it("pairs an https API with its wss origin", () => {
    expect(toApiConnectSources("https://your-api-host.example.com")).toEqual([
      "https://your-api-host.example.com",
      "wss://your-api-host.example.com",
    ]);
  });

  it("allows plain http only for a loopback dev API", () => {
    expect(toApiConnectSources("http://localhost:8000")).toEqual([
      "http://localhost:8000",
      "ws://localhost:8000",
    ]);
    expect(() => toApiConnectSources("http://your-api-host.example.com")).toThrow(
      TypeError,
    );
  });

  it("throws on a malformed URL", () => {
    expect(() => toApiConnectSources("not a url")).toThrow();
  });
});

describe("isUnframeablePath", () => {
  it.each([
    "/app",
    "/app/",
    "/app/login",
    "/app/space/abc",
    "/auth/embed-sign-in",
    "/developers",
    "/developers/admin",
  ])("refuses framing for %p", (pathname) => {
    expect(isUnframeablePath(pathname)).toBe(true);
  });

  it.each([
    "/",
    "/miniapp",
    "/miniapp/spaces/abc",
    "/embed/abc",
    "/space/abc",
    "/application",
    "/developers-guide",
    "/authors",
    "/v/abc",
  ])("leaves %p to the default or embed policy", (pathname) => {
    expect(isUnframeablePath(pathname)).toBe(false);
  });
});
