type UnknownRecord = Record<string, unknown>;

const APP_ROUTE_PREFIXES = [
  "/cast/",
  "/profile/",
  "/space/",
  "/voice-note/",
] as const;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: UnknownRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseObject(value: unknown): UnknownRecord | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeRoute(route: string | null): string | null {
  if (!route) return null;
  // Notification payload data is external input. Prevent a nominally allowed
  // prefix such as `/cast/../../settings` from being normalized by the router
  // into an unrelated in-app destination.
  if (
    /[\u0000-\u001f\u007f\\]/u.test(route) ||
    route.split(/[?#]/u, 1)[0].split("/").includes("..")
  ) {
    return null;
  }

  if (APP_ROUTE_PREFIXES.some((prefix) => route.startsWith(prefix))) {
    return route;
  }

  try {
    const parsed = new URL(route);
    if (
      (parsed.protocol === "juke:" || parsed.hostname === "juke.audio") &&
      APP_ROUTE_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix))
    ) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch {}

  return null;
}

function castRouteFromData(data: UnknownRecord): string | null {
  const castHash = getString(data, "cast_hash") ?? getString(data, "castHash");
  const threadHash =
    getString(data, "thread_hash") ??
    getString(data, "threadHash") ??
    getString(data, "parent_hash") ??
    getString(data, "parentHash") ??
    castHash;
  const focusHash =
    getString(data, "focus_hash") ?? getString(data, "focusHash");

  // The thread screen renders a reply's ancestors inline, so a deep reply
  // opens as its own page with no separate conversation context.
  const targetHash = focusHash ?? castHash ?? threadHash;
  if (!targetHash) return null;
  return `/cast/${encodeURIComponent(targetHash)}`;
}

function profileRouteFromData(data: UnknownRecord): string | null {
  const fid =
    getString(data, "profile_fid") ??
    getString(data, "profileFid") ??
    getString(data, "fid");
  return fid ? `/profile/${fid}` : null;
}

export function getNotificationRoute(data: unknown): string | null {
  const payload = parseObject(data);
  if (!payload) return null;

  const directRoute = normalizeRoute(getString(payload, "url"));
  if (directRoute) return directRoute;

  const body = parseObject(payload.body);
  const bodyRoute = normalizeRoute(body ? getString(body, "url") : null);
  if (bodyRoute) return bodyRoute;

  const nestedData = parseObject(payload.data);
  const nestedRoute = normalizeRoute(
    nestedData ? getString(nestedData, "url") : null,
  );
  if (nestedRoute) return nestedRoute;

  return castRouteFromData(payload) ?? profileRouteFromData(payload);
}
