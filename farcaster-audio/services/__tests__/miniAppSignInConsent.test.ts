import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const secureStore: Record<string, string> = {};
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async (key: string) => secureStore[key] ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    secureStore[key] = value;
  }),
}));

import {
  hasSignInConsent,
  rememberSignInConsent,
} from "@/services/miniAppSignInConsent";

describe("miniAppSignInConsent", () => {
  beforeEach(() => {
    for (const key of Object.keys(secureStore)) delete secureStore[key];
  });

  it("has no consent by default", async () => {
    await expect(hasSignInConsent(1, "app.example.com")).resolves.toBe(false);
  });

  it("remembers consent per domain, case-insensitively", async () => {
    await rememberSignInConsent(1, "App.Example.com");
    await expect(hasSignInConsent(1, "app.example.com")).resolves.toBe(true);
    await expect(hasSignInConsent(1, "other.example.com")).resolves.toBe(false);
  });

  it("keeps consent separate per fid", async () => {
    await rememberSignInConsent(1, "app.example.com");
    await expect(hasSignInConsent(2, "app.example.com")).resolves.toBe(false);
  });

  it("treats corrupt storage as no consent", async () => {
    secureStore.miniapp_signin_consent_1 = "{not json";
    await expect(hasSignInConsent(1, "app.example.com")).resolves.toBe(false);
    secureStore.miniapp_signin_consent_1 = JSON.stringify({ domain: "x" });
    await expect(hasSignInConsent(1, "x")).resolves.toBe(false);
  });

  it("caps the stored list, dropping the oldest domain", async () => {
    for (let i = 0; i < 201; i += 1) {
      await rememberSignInConsent(1, `d${i}.example.com`);
    }
    const stored = JSON.parse(secureStore.miniapp_signin_consent_1) as string[];
    expect(stored).toHaveLength(200);
    await expect(hasSignInConsent(1, "d0.example.com")).resolves.toBe(false);
    await expect(hasSignInConsent(1, "d200.example.com")).resolves.toBe(true);
  });
});
