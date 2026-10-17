import { afterEach, describe, expect, it } from "@jest/globals";
import {
  enterSensitiveScreen,
  isSensitiveScreenActive,
  REDACTED,
  redactCredentialText,
  redactMnemonicLikeText,
  scrubBreadcrumb,
  scrubEvent,
} from "@/utils/sentryScrub";

const PHRASE_12 = "test test test test test test test test test test test junk";
const PHRASE_24 =
  "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual";

describe("redactMnemonicLikeText", () => {
  it("redacts 12- and 24-word phrases in any surrounding text", () => {
    expect(redactMnemonicLikeText(`value="${PHRASE_12}"`)).toBe(
      `value="${REDACTED}"`,
    );
    expect(redactMnemonicLikeText(PHRASE_24)).toBe(REDACTED);
    expect(redactMnemonicLikeText(PHRASE_12.toUpperCase())).not.toMatch(/JUNK/);
  });

  it("redacts numbered and comma-separated phrases", () => {
    const numbered = PHRASE_12.split(" ")
      .map((w, i) => `${i + 1}. ${w}`)
      .join("\n");
    expect(redactMnemonicLikeText(numbered)).not.toContain("junk");
    expect(redactMnemonicLikeText(PHRASE_12.replace(/ /g, ", "))).not.toContain(
      "junk",
    );
  });

  it("leaves ordinary error text alone", () => {
    const text =
      "TypeError: Cannot read property 'id' of undefined at RoomScreen";
    expect(redactMnemonicLikeText(text)).toBe(text);
  });
});

describe("Sentry hooks", () => {
  let releases: (() => void)[] = [];
  afterEach(() => {
    releases.forEach((release) => release());
    releases = [];
  });

  it("drops every breadcrumb while a sensitive screen is mounted", () => {
    const crumb = { category: "ui.input", message: "typed" };
    expect(scrubBreadcrumb(crumb)).toEqual(crumb);
    releases.push(enterSensitiveScreen());
    expect(isSensitiveScreenActive()).toBe(true);
    expect(scrubBreadcrumb(crumb)).toBeNull();
  });

  it("release is idempotent and counts nested screens", () => {
    const a = enterSensitiveScreen();
    const b = enterSensitiveScreen();
    a();
    a();
    expect(isSensitiveScreenActive()).toBe(true);
    b();
    expect(isSensitiveScreenActive()).toBe(false);
  });

  it("scrubs phrases anywhere in an event, however nested", () => {
    let deep: Record<string, unknown> = { leaf: { value: PHRASE_12 } };
    for (let i = 0; i < 30; i += 1) deep = { nested: deep };
    const event = {
      message: `failed with ${PHRASE_12}`,
      exception: { values: [{ value: PHRASE_24 }] },
      breadcrumbs: [{ message: PHRASE_12 }],
      extra: { deep },
    };
    const scrubbed = JSON.stringify(scrubEvent(event));
    expect(scrubbed).not.toContain("junk");
    expect(scrubbed).not.toContain("actress");
    expect(scrubbed).toContain("failed with");
  });

  it("strips breadcrumbs, extra and contexts from events while sensitive", () => {
    releases.push(enterSensitiveScreen());
    const scrubbed = scrubEvent({
      message: "boom",
      breadcrumbs: [{ message: "x" }],
      extra: { a: 1 },
      contexts: { b: 2 },
    }) as Record<string, unknown>;
    expect(scrubbed).toEqual({ message: "boom" });
  });
});

// A syntactically valid (unsigned) JWT shape — not a real credential.
const FAKE_JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMiLCJleHAiOjF9.c2lnbmF0dXJlLXBhcnQ";

describe("credential redaction", () => {
  it("masks bearer tokens, JWTs and credential query params in free text", () => {
    expect(redactCredentialText("Authorization: Bearer abcdef0123456789")).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(redactCredentialText(`token is ${FAKE_JWT} ok`)).toBe(
      `token is ${REDACTED} ok`,
    );
    expect(
      redactCredentialText(
        "GET https://your-api-host.example.com/v1/x?prepare_id=abc123&page=2&access_token=zzz",
      ),
    ).toBe(
      `GET https://your-api-host.example.com/v1/x?prepare_id=${REDACTED}&page=2&access_token=${REDACTED}`,
    );
  });

  it("leaves ordinary prose mentioning auth words alone", () => {
    const text = "Basic setup failed: missing Bearer token";
    expect(redactCredentialText(text)).toBe(text);
  });

  it("redacts values under credential-looking keys at any depth", () => {
    const crumb = {
      category: "xhr",
      data: {
        url: "https://your-api-host.example.com/v1/rooms",
        headers: { Authorization: "opaque", "X-Session-Token": "opaque" },
        refresh_token: "r1",
        livekit_token: "lk",
        jwt: "j",
        signature: "0xsig",
        status_code: 200,
      },
    };
    const scrubbed = scrubBreadcrumb(crumb) as typeof crumb;
    expect(scrubbed.data.headers.Authorization).toBe(REDACTED);
    expect(scrubbed.data.headers["X-Session-Token"]).toBe(REDACTED);
    expect(scrubbed.data.refresh_token).toBe(REDACTED);
    expect(scrubbed.data.livekit_token).toBe(REDACTED);
    expect(scrubbed.data.jwt).toBe(REDACTED);
    expect(scrubbed.data.signature).toBe(REDACTED);
    expect(scrubbed.data.status_code).toBe(200);
    expect(scrubbed.data.url).toBe("https://your-api-host.example.com/v1/rooms");
  });

  it("drops request headers and cookies from events", () => {
    const scrubbed = scrubEvent({
      message: "boom",
      request: {
        url: "https://your-api-host.example.com/v1/me",
        headers: { Accept: "application/json" },
        cookies: { session: "s" },
      },
    }) as { request: Record<string, unknown> };
    expect(scrubbed.request).toEqual({ url: "https://your-api-host.example.com/v1/me" });
  });
});
