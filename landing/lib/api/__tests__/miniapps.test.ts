import { apiFetch } from "@/lib/api/client";
import {
  discoverMiniApps,
  type MiniAppDiscoveryResponse,
} from "@/lib/api/miniapps";

jest.mock("@/lib/api/client", () => ({ apiFetch: jest.fn() }));

const mockApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

const response: MiniAppDiscoveryResponse = {
  frames: [
    {
      name: "Airstack",
      description: "Explore the network",
      image_url: "https://example.com/icon.png",
      frames_url: "https://example.com/app",
      author: { fid: 1, username: "builder" },
      metrics: null,
      rank: null,
    },
  ],
  next: { cursor: "page-2" },
  meta: {
    source: "neynar",
    metrics_available: false,
    unsupported: false,
  },
};

describe("discoverMiniApps", () => {
  beforeEach(() => mockApiFetch.mockReset());

  it("requests the curated discovery contract with the default limit", async () => {
    mockApiFetch.mockResolvedValue(response);

    await expect(discoverMiniApps()).resolves.toBe(response);
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/v1/search/miniapps/discover?limit=24",
      { signal: undefined },
    );
  });

  it("passes pagination and abort state without changing the response", async () => {
    const controller = new AbortController();
    mockApiFetch.mockResolvedValue(response);

    await expect(
      discoverMiniApps({ limit: 12, cursor: "a/b + c", signal: controller.signal }),
    ).resolves.toBe(response);
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/v1/search/miniapps/discover?limit=12&cursor=a%2Fb+%2B+c",
      { signal: controller.signal },
    );
  });
});
