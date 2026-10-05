export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new ApiError(
      "The server could not be reached. Check your connection and try again.",
      "NETWORK",
      0,
    );
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      typeof payload === "object" && payload !== null && "error" in payload ? payload.error : null;
    if (typeof error === "object" && error !== null && "message" in error && "code" in error) {
      throw new ApiError(String(error.message), String(error.code), response.status);
    }
    throw new ApiError(
      "The request could not be completed. Please try again.",
      "SERVER_ERROR",
      response.status,
    );
  }
  if (typeof payload !== "object" || payload === null) {
    throw new ApiError(
      "The server returned an unexpected response. Reconnect and try again.",
      "INVALID_RESPONSE",
      response.status,
    );
  }
  return payload as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export function invitationToken(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    return new URLSearchParams(url.hash.slice(1)).get("invite") ?? "";
  } catch {
    return trimmed;
  }
}

export function invitationUrl(token: string): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = new URLSearchParams({ invite: token }).toString();
  return url.toString();
}

export const CURRENT_GAME_KEY = "chess-room.current-game";

export function currentGameId(): string | null {
  try {
    return localStorage.getItem(CURRENT_GAME_KEY);
  } catch {
    return null;
  }
}

export function rememberGame(id: string | null): void {
  try {
    if (id) localStorage.setItem(CURRENT_GAME_KEY, id);
    else localStorage.removeItem(CURRENT_GAME_KEY);
  } catch {
    // Cookie identity still works when browser storage is unavailable.
  }
}
