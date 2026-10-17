import { ApiFetchError, apiFetch } from "@/lib/api/client";

jest.mock("@/lib/auth/session", () => ({ getJwt: jest.fn(() => null) }));
jest.mock("@/lib/auth/authRefresh", () => ({ refreshSession: jest.fn() }));

const realFetch = global.fetch;

function respondWith(status: number, body: string) {
  global.fetch = jest.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
}

afterEach(() => {
  global.fetch = realFetch;
});

describe("apiFetch error bodies", () => {
  it("carries upstream's message alongside the detail", async () => {
    respondWith(422, JSON.stringify({ detail: "upstream_rejected", message: "Recipient blocks DMs" }));
    const error = await apiFetch("/x", { skipAuthRefresh: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiFetchError);
    expect(error).toMatchObject({ status: 422, detail: "upstream_rejected", serverMessage: "Recipient blocks DMs" });
  });

  it("leaves serverMessage unset when absent or not a string", async () => {
    respondWith(400, JSON.stringify({ detail: "invalid_cursor", message: 42 }));
    const error = (await apiFetch("/x", { skipAuthRefresh: true }).catch((e: unknown) => e)) as ApiFetchError;
    expect(error.detail).toBe("invalid_cursor");
    expect(error.serverMessage).toBeUndefined();
  });

  it("still falls back to raw text for non-JSON bodies", async () => {
    respondWith(502, "Bad Gateway");
    const error = (await apiFetch("/x", { skipAuthRefresh: true }).catch((e: unknown) => e)) as ApiFetchError;
    expect(error).toMatchObject({ status: 502, detail: "Bad Gateway" });
    expect(error.serverMessage).toBeUndefined();
  });
});
