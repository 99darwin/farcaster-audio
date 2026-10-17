import {
  HYPERSNAP_HTTP_URL,
  toHypersnapConnectSource,
} from "@/lib/hypersnap/config";

describe("toHypersnapConnectSource", () => {
  it("defaults to the origin of the configured node", () => {
    expect(toHypersnapConnectSource()).toBe(new URL(HYPERSNAP_HTTP_URL).origin);
  });

  it("reduces a base URL to its origin", () => {
    expect(toHypersnapConnectSource("https://node.example.com:8443/v2/")).toBe(
      "https://node.example.com:8443",
    );
  });

  it("allows plain HTTP only for a loopback dev node", () => {
    expect(toHypersnapConnectSource("http://localhost:3381")).toBe(
      "http://localhost:3381",
    );
    expect(toHypersnapConnectSource("http://127.0.0.1:3381")).toBe(
      "http://127.0.0.1:3381",
    );
    expect(() => toHypersnapConnectSource("http://node.example.com")).toThrow(
      TypeError,
    );
  });

  it.each(["not a url", "ftp://node.example.com", "javascript:alert(1)"])(
    "rejects %p",
    (value) => {
      expect(() => toHypersnapConnectSource(value)).toThrow();
    },
  );
});
