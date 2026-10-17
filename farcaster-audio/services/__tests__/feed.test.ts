import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { InternalAxiosRequestConfig } from "axios";
import { Config } from "@/constants/config";
import { fetchCastThread } from "@/services/feed";

type RequestInterceptor = (
  config: InternalAxiosRequestConfig,
) => Promise<InternalAxiosRequestConfig>;

interface AxiosStubState {
  createConfigs: unknown[];
  requestInterceptors: RequestInterceptor[];
  get: jest.Mock<(url: string, config?: unknown) => Promise<unknown>>;
}

// State lives inside the factory: `feed.ts` calls `axios.create` at import
// time, which runs before any top-level `const` in this file is initialised.
jest.mock("axios", () => {
  const state = {
    createConfigs: [] as unknown[],
    requestInterceptors: [] as unknown[],
    get: jest.fn(),
  };
  return {
    __esModule: true,
    __stub: state,
    default: {
      create: (config: unknown) => {
        state.createConfigs.push(config);
        return {
          get: state.get,
          post: jest.fn(),
          delete: jest.fn(),
          interceptors: {
            request: {
              use: (handler: unknown) => {
                state.requestInterceptors.push(handler);
              },
            },
            response: { use: jest.fn() },
          },
        };
      },
    },
  };
});

jest.mock("@/services/storage", () => ({
  getTokens: jest.fn(async () => ({ jwt: "test-jwt", refresh_token: "r" })),
}));

const stub = jest.requireMock<{ __stub: AxiosStubState }>("axios").__stub;

describe("feed service", () => {
  beforeEach(() => {
    stub.get.mockReset();
  });

  it("targets the Juke backend, not a third-party Farcaster provider", () => {
    expect(stub.createConfigs).toEqual([
      expect.objectContaining({ baseURL: Config.API_BASE_URL }),
    ]);
  });

  it("authenticates with the user JWT and sends no provider API key", async () => {
    expect(stub.requestInterceptors).toHaveLength(1);
    const config = await stub.requestInterceptors[0]({
      headers: {},
    } as unknown as InternalAxiosRequestConfig);

    expect(config.headers.Authorization).toBe("Bearer test-jwt");
    const headerNames = Object.keys(config.headers).map((h) => h.toLowerCase());
    expect(headerNames).not.toContain("x-api-key");
    expect(headerNames).not.toContain("api_key");
  });

  it("fetches a thread from the backend without a client-supplied viewer fid", async () => {
    stub.get.mockResolvedValue({ data: { conversation: { cast: null } } });

    await fetchCastThread("0xabc", 42, 3);

    expect(stub.get).toHaveBeenCalledWith("/v1/feed/cast/thread", {
      params: { hash: "0xabc", reply_depth: 3 },
    });
  });
});
