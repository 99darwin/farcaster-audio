import { FRAME_ANCESTORS_NONE } from "@/lib/security/csp";
import {
  FRAME_ANCESTORS_EMBED_PERMISSIVE,
  fetchEmbedPolicy,
  frameAncestorsForEmbedPolicy,
  parseEmbedPath,
  parseEmbedPolicy,
  resolveEmbedFrameAncestors,
  toFrameAncestorSource,
} from "@/lib/security/embedFrameAncestors";

const API = "https://api.example.test";
const ROOM_ID = "3f2b8c3e-8f1a-4c7e-9d2a-1b2c3d4e5f60";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fetchReturning(response: Response | Error): jest.Mock {
  return jest.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
}

async function resolveWith(
  fetchImpl: typeof fetch,
  pathname = `/embed/${ROOM_ID}`,
): Promise<readonly string[]> {
  return resolveEmbedFrameAncestors(pathname, { apiBaseUrl: API, fetchImpl });
}

describe("frameAncestorsForEmbedPolicy", () => {
  it("allows any ancestor for a legacy room with no owning app (null)", () => {
    expect(
      frameAncestorsForEmbedPolicy({ status: "ok", allowedOrigins: null }),
    ).toBe(FRAME_ANCESTORS_EMBED_PERMISSIVE);
  });

  it("blocks framing for a suspended app (empty list)", () => {
    expect(
      frameAncestorsForEmbedPolicy({ status: "ok", allowedOrigins: [] }),
    ).toBe(FRAME_ANCESTORS_NONE);
  });

  it("returns the app's origins when it lists some", () => {
    expect(
      frameAncestorsForEmbedPolicy({
        status: "ok",
        allowedOrigins: ["https://partner.example"],
      }),
    ).toEqual(["https://partner.example"]);
  });

  it("fails closed when the lookup failed", () => {
    expect(frameAncestorsForEmbedPolicy({ status: "failed" })).toBe(
      FRAME_ANCESTORS_NONE,
    );
  });
});

describe("parseEmbedPolicy", () => {
  it.each([
    ["a non-object", "nope"],
    ["null", null],
    ["a body without allowed_origins", {}],
    ["a non-array allowed_origins", { allowed_origins: "https://a.example" }],
  ])("treats %s as a failed lookup", (_label, body) => {
    expect(parseEmbedPolicy(body)).toEqual({ status: "failed" });
  });

  it("canonicalizes origins and drops entries that aren't origins", () => {
    expect(
      parseEmbedPolicy({
        allowed_origins: [
          "https://Partner.Example/",
          "https://partner.example",
          "http://localhost:3000",
          "*",
          "https://a.example; script-src *",
          "https://a.example/path",
          "javascript:alert(1)",
          "https://*.example.com",
          42,
        ],
      }),
    ).toEqual({
      status: "ok",
      allowedOrigins: ["https://partner.example", "http://localhost:3000"],
    });
  });

  it("turns a list of only invalid entries into an explicit block", () => {
    const lookup = parseEmbedPolicy({ allowed_origins: ["*", "null"] });
    expect(frameAncestorsForEmbedPolicy(lookup)).toBe(FRAME_ANCESTORS_NONE);
  });
});

describe("toFrameAncestorSource", () => {
  it("rejects credentials in the origin", () => {
    expect(toFrameAncestorSource("https://user:pw@a.example")).toBeNull();
  });
});

describe("fetchEmbedPolicy", () => {
  it("requests the encoded room id", async () => {
    const fetchImpl = fetchReturning(jsonResponse({ allowed_origins: null }));
    await fetchEmbedPolicy("a b/../c", { apiBaseUrl: API, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `${API}/v1/rooms/a%20b%2F..%2Fc/embed-policy`,
    );
  });

  it("fails closed on a dot-segment id without a request", async () => {
    const fetchImpl = fetchReturning(jsonResponse({ allowed_origins: null }));
    await expect(
      fetchEmbedPolicy("..", { apiBaseUrl: API, fetchImpl }),
    ).resolves.toEqual({ status: "failed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aborts a stalled lookup and fails closed", async () => {
    const fetchImpl = jest.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    await expect(
      fetchEmbedPolicy(ROOM_ID, {
        apiBaseUrl: API,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 5,
      }),
    ).resolves.toEqual({ status: "failed" });
  });
});

describe("resolveEmbedFrameAncestors", () => {
  it("is permissive for a legacy room", async () => {
    expect(
      await resolveWith(fetchReturning(jsonResponse({ allowed_origins: null }))),
    ).toBe(FRAME_ANCESTORS_EMBED_PERMISSIVE);
  });

  it("is 'none' for a suspended app's room", async () => {
    expect(
      await resolveWith(fetchReturning(jsonResponse({ allowed_origins: [] }))),
    ).toBe(FRAME_ANCESTORS_NONE);
  });

  it("returns the app's origins", async () => {
    expect(
      await resolveWith(
        fetchReturning(
          jsonResponse({ allowed_origins: ["https://partner.example"] }),
        ),
      ),
    ).toEqual(["https://partner.example"]);
  });

  it.each([
    ["a 404", jsonResponse({ detail: "Room not found" }, 404)],
    ["a 500", jsonResponse({ detail: "boom" }, 500)],
    ["a network error", new Error("ECONNRESET")],
    ["a non-JSON body", new Response("<html>", { status: 200 })],
  ])("fails closed on %s", async (_label, response) => {
    expect(await resolveWith(fetchReturning(response))).toBe(
      FRAME_ANCESTORS_NONE,
    );
  });

  it("is permissive for the reserved demo page without a lookup", async () => {
    const fetchImpl = fetchReturning(jsonResponse({ allowed_origins: [] }));
    expect(await resolveWith(fetchImpl, "/embed/demo")).toBe(
      FRAME_ANCESTORS_EMBED_PERMISSIVE,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is 'none' for a malformed path without a lookup", async () => {
    const fetchImpl = fetchReturning(jsonResponse({ allowed_origins: null }));
    expect(await resolveWith(fetchImpl, "/embed/%E0%A4%A")).toBe(
      FRAME_ANCESTORS_NONE,
    );
    expect(await resolveWith(fetchImpl, "/embed/")).toBe(FRAME_ANCESTORS_NONE);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("parseEmbedPath", () => {
  it("extracts the space id from nested paths", () => {
    expect(parseEmbedPath(`/embed/${ROOM_ID}/anything`)).toEqual({
      kind: "space",
      spaceId: ROOM_ID,
    });
  });
});
