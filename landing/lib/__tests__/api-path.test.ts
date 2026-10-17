import { encodePathSegment } from "@/lib/api-path";
import { getRecording } from "@/lib/recordings";
import { getSpaceDetail, joinSpaceAsListener } from "@/lib/spaces";
import { getVoiceNote } from "@/lib/voice-notes";

const UUID = "3f2b8c3e-8f1a-4c7e-9d2a-1b2c3d4e5f60";

describe("encodePathSegment", () => {
  it("passes a UUID through unchanged", () => {
    expect(encodePathSegment(UUID)).toBe(UUID);
  });

  it("escapes separators so the value stays one segment", () => {
    expect(encodePathSegment("../admin?x=1#y")).toBe("..%2Fadmin%3Fx%3D1%23y");
    expect(encodePathSegment("%2e%2e")).toBe("%252e%252e");
  });

  it.each(["", ".", ".."])("rejects %p", (value) => {
    expect(encodePathSegment(value)).toBeNull();
  });
});

describe("backend fetch helpers", () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn(async () => new Response("{}", { status: 404 }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  function requestedPaths(): string[] {
    return fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
  }

  it("encodes ids so they can't reach another backend route", async () => {
    await getSpaceDetail("x/../../v1/admin");
    await joinSpaceAsListener("x/../y", "jwt");
    await getVoiceNote("a/b");
    await getRecording("c/d");
    expect(requestedPaths()).toEqual([
      "/v1/rooms/x%2F..%2F..%2Fv1%2Fadmin",
      "/v1/rooms/x%2F..%2Fy/join",
      "/v1/voice-notes/a%2Fb",
      "/v1/recordings/by-id/c%2Fd",
      "/v1/recordings/c%2Fd",
    ]);
  });

  it("does not fetch for dot segments", async () => {
    expect(await getSpaceDetail("..")).toBeNull();
    expect(await joinSpaceAsListener(".", "jwt")).toBeNull();
    expect(await getVoiceNote("..")).toBeNull();
    expect(await getRecording("..")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
