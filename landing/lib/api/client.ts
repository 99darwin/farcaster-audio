/**
 * Credentialed fetch client for the Juke web app.
 *
 * `juke.audio` and `your-api-host.example.com` are DIFFERENT origins, so every call is a
 * credentialed CORS request: we send `credentials: "include"` so the HttpOnly
 * `juke_refresh` cookie (Domain=.juke.audio) rides along. The backend CORS
 * config already allows credentialed juke.audio.
 *
 * Behaviour ported from mobile `services/api.ts`:
 *   - Request: attach `Authorization: Bearer <jwt>` from the in-memory session.
 *   - Response 401: route through the single-flight `refreshSession()`, then
 *     retry the request exactly once with the fresh JWT. On refresh failure the
 *     session is cleared (by `refreshSession`) and the original error surfaces.
 */

import { getJwt } from "@/lib/auth/session";
import { refreshSession } from "@/lib/auth/authRefresh";
import type { ApiError } from "@/lib/api/types";

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  /** JSON-serialisable body; objects are stringified with a JSON content-type. */
  body?: unknown;
  /**
   * Skip the 401→refresh→retry dance. Used by the auth endpoints themselves
   * (login/refresh/logout) so a 401 there doesn't recurse into refresh.
   */
  skipAuthRefresh?: boolean;
}

/** Error thrown by `apiFetch` for non-2xx responses. Implements `ApiError`. */
export class ApiFetchError extends Error implements ApiError {
  readonly status: number;
  readonly detail?: string;
  /**
   * Human-readable `message` the server sent beside `detail`, when it sent a
   * string one (e.g. 422 `upstream_rejected`). Safe to show the user: the
   * backend strips control characters and redacts tokens before sending it.
   */
  readonly serverMessage?: string;

  constructor(status: number, detail?: string, serverMessage?: string) {
    super(detail ? `API ${status}: ${detail}` : `API ${status}`);
    this.name = "ApiFetchError";
    this.status = status;
    this.detail = detail;
    this.serverMessage = serverMessage;
  }
}

export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const { skipAuthRefresh, ...rest } = options;

  let response = await performRequest(path, rest, getJwt());

  if (response.status === 401 && !skipAuthRefresh) {
    const refreshed = await refreshSession();
    if (refreshed) {
      response = await performRequest(path, rest, refreshed.jwt);
    }
  }

  return handleResponse<T>(response);
}

async function performRequest(
  path: string,
  options: Omit<ApiFetchOptions, "skipAuthRefresh">,
  jwt: string | null,
): Promise<Response> {
  const { body, headers, ...init } = options;

  const finalHeaders = new Headers(headers);
  if (jwt) finalHeaders.set("Authorization", `Bearer ${jwt}`);

  let finalBody: BodyInit | undefined;
  if (body !== undefined && body !== null) {
    if (
      typeof body === "string" ||
      body instanceof FormData ||
      body instanceof Blob ||
      body instanceof ArrayBuffer ||
      body instanceof URLSearchParams
    ) {
      finalBody = body as BodyInit;
    } else {
      finalBody = JSON.stringify(body);
      if (!finalHeaders.has("Content-Type")) {
        finalHeaders.set("Content-Type", "application/json");
      }
    }
  }

  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: finalHeaders,
    body: finalBody,
    credentials: "include",
  });
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const { detail, message } = await extractErrorBody(response);
    throw new ApiFetchError(response.status, detail, message);
  }
  // 204 No Content and empty bodies parse to undefined.
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

interface ErrorBody {
  detail?: string;
  message?: string;
}

async function extractErrorBody(response: Response): Promise<ErrorBody> {
  try {
    const text = await response.text();
    if (!text) return {};
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown };
      if (typeof parsed.detail === "string") {
        return {
          detail: parsed.detail,
          message: typeof parsed.message === "string" ? parsed.message : undefined,
        };
      }
    } catch {
      // Not JSON — fall through to the raw text.
    }
    return { detail: text };
  } catch {
    return {};
  }
}
