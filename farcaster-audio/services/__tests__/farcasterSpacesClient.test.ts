/**
 * Tests for the Farcaster-native audio-spaces HTTP client.
 *
 * Coverage:
 *   - join happy path / partial-result throw
 *   - list envelopes parsed correctly
 *   - 404 → null on fetchAudioRoom
 *   - 500 → throws on fetchAudioRoom
 *   - NoBearerError when bearer missing or bound to another fid
 *   - error redaction: bearer never appears in thrown error message
 *   - fidFromIdentity edge cases
 *   - raise-hand / accept-speaker body shapes
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// --- bearer mock --------------------------------------------------------
const mockBearer: {
  current: {
    secret: string;
    expiresAt: number;
    custodyAddress: string;
    fid: number;
  } | null;
} = {
  current: {
    secret: "super-secret-bearer-token-DO-NOT-LEAK",
    expiresAt: Date.now() + 60_000,
    custodyAddress: "0x1234567890abcdef1234567890abcdef12345678",
    fid: 12345,
  },
};

const mockClearBearer = jest.fn(async () => {});
jest.mock("@/services/farcasterBearer", () => ({
  getFarcasterBearer: jest.fn(async () => mockBearer.current),
  clearFarcasterBearer: () => mockClearBearer(),
}));

// --- session mock: the signed-in Juke user the bearer must belong to ----
const mockSessionUser: { current: { fid: number } | null } = {
  current: { fid: 12345 },
};
jest.mock("@/stores/authStore", () => ({
  useAuthStore: { getState: () => ({ user: mockSessionUser.current }) },
}));

// --- fetch mock ---------------------------------------------------------
type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

const fetchHandler: { current: FetchHandler } = {
  current: async () => {
    throw new Error("fetch not set up for this test");
  },
};

beforeEach(() => {
  mockSessionUser.current = { fid: 12345 };
  mockClearBearer.mockClear();
  mockBearer.current = {
    secret: "super-secret-bearer-token-DO-NOT-LEAK",
    expiresAt: Date.now() + 60_000,
    custodyAddress: "0x1234567890abcdef1234567890abcdef12345678",
    fid: 12345,
  };
  fetchHandler.current = async () => {
    throw new Error("fetch not set up for this test");
  };
});

// @ts-expect-error -- jest test env, no fetch typing
global.fetch = jest.fn((url: string, init?: RequestInit) =>
  fetchHandler.current(url, init),
);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain" },
  });
}

// Import AFTER mocks are wired up.
import {
  FarcasterSpacesError,
  NoBearerError,
  acceptSpeaker,
  fetchAudioRoom,
  fidFromIdentity,
  joinAudioRoom,
  listLiveAudioRooms,
  raiseHand,
} from "@/services/farcasterSpacesClient";

describe("farcasterSpacesClient", () => {
  // -------------------------------------------------------------------
  // joinAudioRoom
  // -------------------------------------------------------------------
  describe("joinAudioRoom", () => {
    it("returns wsUrl + token + room on success", async () => {
      fetchHandler.current = async (url, init) => {
        expect(url).toBe("https://client.farcaster.xyz/v1/audio-room/join");
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body).toEqual({ roomId: "room-abc" });
        const headers = init?.headers as Record<string, string>;
        expect(headers.authorization).toBe(
          "Bearer super-secret-bearer-token-DO-NOT-LEAK",
        );
        return jsonResponse({
          result: {
            wsUrl: "wss://example.livekit.cloud",
            token: "lk-jwt-blob",
            role: "listener",
            room: { id: "room-abc", host: { fid: 1 }, state: "live" },
            viewerFid: 12345,
          },
        });
      };

      const result = await joinAudioRoom("room-abc");
      expect(result.wsUrl).toBe("wss://example.livekit.cloud");
      expect(result.token).toBe("lk-jwt-blob");
      expect(result.role).toBe("listener");
      expect(result.room.id).toBe("room-abc");
      expect(result.viewerFid).toBe(12345);
    });

    it("throws FarcasterSpacesError when wsUrl missing", async () => {
      fetchHandler.current = async () =>
        jsonResponse({
          result: {
            // wsUrl deliberately absent
            token: "lk-jwt-blob",
            room: { id: "room-abc", host: { fid: 1 }, state: "live" },
          },
        });
      await expect(joinAudioRoom("room-abc")).rejects.toBeInstanceOf(
        FarcasterSpacesError,
      );
    });

    it("throws FarcasterSpacesError when room payload missing", async () => {
      fetchHandler.current = async () =>
        jsonResponse({
          result: {
            wsUrl: "wss://example.livekit.cloud",
            token: "lk-jwt-blob",
            // room deliberately absent
          },
        });
      await expect(joinAudioRoom("room-abc")).rejects.toBeInstanceOf(
        FarcasterSpacesError,
      );
    });

    it("defaults role to listener if server omits it", async () => {
      fetchHandler.current = async () =>
        jsonResponse({
          result: {
            wsUrl: "wss://x.livekit.cloud",
            token: "tok",
            room: { id: "r", host: { fid: 1 }, state: "live" },
          },
        });
      const result = await joinAudioRoom("r");
      expect(result.role).toBe("listener");
    });
  });

  // -------------------------------------------------------------------
  // list envelopes
  // -------------------------------------------------------------------
  describe("listLiveAudioRooms", () => {
    it("parses {result: {rooms: [...]}} envelope", async () => {
      fetchHandler.current = async (url) => {
        expect(url).toBe(
          "https://client.farcaster.xyz/v1/audio-rooms?limit=30",
        );
        return jsonResponse({
          result: {
            rooms: [
              { id: "r1", host: { fid: 1 }, state: "live" },
              { id: "r2", host: { fid: 2 }, state: "live" },
            ],
          },
        });
      };
      const rooms = await listLiveAudioRooms();
      expect(rooms).toHaveLength(2);
      expect(rooms[0].id).toBe("r1");
    });

    it("returns [] on 500", async () => {
      fetchHandler.current = async () => textResponse("oops", 500);
      const rooms = await listLiveAudioRooms();
      expect(rooms).toEqual([]);
    });

    it("respects custom limit", async () => {
      fetchHandler.current = async (url) => {
        expect(url).toBe(
          "https://client.farcaster.xyz/v1/audio-rooms?limit=5",
        );
        return jsonResponse({ result: { rooms: [] } });
      };
      await listLiveAudioRooms(5);
    });
  });

  // -------------------------------------------------------------------
  // fetchAudioRoom
  // -------------------------------------------------------------------
  describe("fetchAudioRoom", () => {
    it("returns null on 404", async () => {
      fetchHandler.current = async () => textResponse("not found", 404);
      const room = await fetchAudioRoom("nope");
      expect(room).toBeNull();
    });

    it("throws on 500", async () => {
      fetchHandler.current = async () => textResponse("boom", 500);
      await expect(fetchAudioRoom("nope")).rejects.toBeInstanceOf(
        FarcasterSpacesError,
      );
    });

    it("returns room on success", async () => {
      fetchHandler.current = async (url) => {
        expect(url).toBe(
          "https://client.farcaster.xyz/v1/audio-room?roomId=abc",
        );
        return jsonResponse({
          result: { room: { id: "abc", host: { fid: 1 }, state: "live" } },
        });
      };
      const room = await fetchAudioRoom("abc");
      expect(room?.id).toBe("abc");
    });
  });

  // -------------------------------------------------------------------
  // NoBearerError
  // -------------------------------------------------------------------
  describe("authed", () => {
    it("throws NoBearerError when bearer is null", async () => {
      mockBearer.current = null;
      // Use a method that goes straight through authed() with no
      // swallowing — listAudioRoomParticipants does not catch.
      fetchHandler.current = async () => {
        throw new Error(
          "fetch should not be called when bearer is missing",
        );
      };
      await expect(fetchAudioRoom("any-room")).rejects.toBeInstanceOf(
        NoBearerError,
      );
    });

    it("refuses and clears a bearer minted for a different fid", async () => {
      mockSessionUser.current = { fid: 999 };
      fetchHandler.current = async () => {
        throw new Error("fetch must not run with a foreign bearer");
      };
      await expect(fetchAudioRoom("any-room")).rejects.toBeInstanceOf(
        NoBearerError,
      );
      expect(mockClearBearer).toHaveBeenCalledTimes(1);
    });

    it("refuses the bearer when no Juke user is signed in", async () => {
      mockSessionUser.current = null;
      fetchHandler.current = async () => {
        throw new Error("fetch must not run without a session");
      };
      await expect(fetchAudioRoom("any-room")).rejects.toBeInstanceOf(
        NoBearerError,
      );
    });

    it("NoBearerError is also a FarcasterSpacesError", async () => {
      mockBearer.current = null;
      try {
        await joinAudioRoom("r");
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(NoBearerError);
        expect(e).toBeInstanceOf(FarcasterSpacesError);
      }
    });
  });

  // -------------------------------------------------------------------
  // error redaction
  // -------------------------------------------------------------------
  describe("error redaction", () => {
    it("bearer secret never appears in thrown error message", async () => {
      const secret = "REDACT-ME-PLEASE-super-secret-bearer-token";
      mockBearer.current = {
        secret,
        expiresAt: Date.now() + 60_000,
        custodyAddress: "0x1234567890abcdef1234567890abcdef12345678",
        fid: 12345,
      };
      // Server returns the bearer back in the response body — a realistic
      // worst case (auth-echo bugs do happen). The thrown error must not
      // include it.
      fetchHandler.current = async () =>
        textResponse(`unauthorized: ${secret}`, 401);
      try {
        await joinAudioRoom("r");
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(FarcasterSpacesError);
        expect((e as Error).message).not.toContain(secret);
        expect((e as Error).message).not.toContain("REDACT-ME");
        expect((e as FarcasterSpacesError).status).toBe(401);
      }
    });

    it("network error does not leak bearer", async () => {
      const secret = "secret-that-must-not-leak";
      mockBearer.current = {
        secret,
        expiresAt: Date.now() + 60_000,
        custodyAddress: "0x1234567890abcdef1234567890abcdef12345678",
        fid: 12345,
      };
      fetchHandler.current = async () => {
        throw new Error(`tcp error: bearer was ${secret}`);
      };
      try {
        await joinAudioRoom("r");
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(FarcasterSpacesError);
        expect((e as Error).message).not.toContain(secret);
      }
    });
  });

  // -------------------------------------------------------------------
  // fidFromIdentity
  // -------------------------------------------------------------------
  describe("fidFromIdentity", () => {
    it("parses fid:12345 → 12345", () => {
      expect(fidFromIdentity("fid:12345")).toBe(12345);
    });
    it("parses bare numeric → number", () => {
      expect(fidFromIdentity("42")).toBe(42);
    });
    it("undefined → null", () => {
      expect(fidFromIdentity(undefined)).toBeNull();
    });
    it("empty string → null", () => {
      expect(fidFromIdentity("")).toBeNull();
    });
    it("non-numeric → null", () => {
      expect(fidFromIdentity("fid:abc")).toBeNull();
      expect(fidFromIdentity("notafid")).toBeNull();
    });
    it("negative → null", () => {
      // "-1" fails the digit-only regex, so this gets filtered as
      // expected.
      expect(fidFromIdentity("-1")).toBeNull();
    });
  });

  // -------------------------------------------------------------------
  // raiseHand
  // -------------------------------------------------------------------
  describe("raiseHand", () => {
    it("POSTs {roomId, raised: true}", async () => {
      fetchHandler.current = async (url, init) => {
        expect(url).toBe(
          "https://client.farcaster.xyz/v1/audio-room/raise-hand",
        );
        expect(JSON.parse(String(init?.body ?? "{}"))).toEqual({
          roomId: "r",
          raised: true,
        });
        return jsonResponse({ result: {} });
      };
      await raiseHand("r", true);
    });

    it("POSTs {roomId, raised: false} on lower", async () => {
      fetchHandler.current = async (_url, init) => {
        expect(JSON.parse(String(init?.body ?? "{}"))).toEqual({
          roomId: "r",
          raised: false,
        });
        return jsonResponse({ result: {} });
      };
      await raiseHand("r", false);
    });
  });

  // -------------------------------------------------------------------
  // acceptSpeaker
  // -------------------------------------------------------------------
  describe("acceptSpeaker", () => {
    it("POSTs {roomId, targetFid}", async () => {
      fetchHandler.current = async (url, init) => {
        expect(url).toBe(
          "https://client.farcaster.xyz/v1/audio-room/accept-speaker",
        );
        expect(JSON.parse(String(init?.body ?? "{}"))).toEqual({
          roomId: "r",
          targetFid: 99,
        });
        return jsonResponse({ result: {} });
      };
      await acceptSpeaker("r", 99);
    });
  });
});
