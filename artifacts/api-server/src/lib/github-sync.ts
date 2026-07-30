const DEFAULT_BACKOFF_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

let githubBackoffUntil = 0;
let lastBackoffNoticeAt = 0;

function getBackoffDuration(response: Response): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 60 * 60 * 1000);
  }

  const resetAt = Number(response.headers.get("x-ratelimit-reset")) * 1000;
  if (Number.isFinite(resetAt) && resetAt > Date.now()) {
    return Math.min(resetAt - Date.now(), 60 * 60 * 1000);
  }

  return DEFAULT_BACKOFF_MS;
}

function noteRateLimit(response: Response): void {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const isRateLimited =
    response.status === 403 ||
    response.status === 429 ||
    remaining === "0";

  if (!isRateLimited) {
    if (response.ok) githubBackoffUntil = 0;
    return;
  }

  githubBackoffUntil = Math.max(
    githubBackoffUntil,
    Date.now() + getBackoffDuration(response),
  );

  if (Date.now() - lastBackoffNoticeAt > 30_000) {
    lastBackoffNoticeAt = Date.now();
    console.warn(
      `[GitHub Sync] API temporarily unavailable (${response.status}); ` +
        `using local/remote fallback until ${new Date(githubBackoffUntil).toISOString()}.`,
    );
  }
}

/**
 * GitHub Contents API wrapper shared by DB and WhatsApp persistence.
 *
 * A rate-limited GitHub API must never prevent the HTTP server from starting.
 * Returning null during backoff lets callers use their existing local/KV
 * fallback without creating another request that would extend the limit.
 */
export async function githubFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response | null> {
  if (Date.now() < githubBackoffUntil) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(input, {
      ...init,
      signal: init.signal ?? controller.signal,
    });
    noteRateLimit(response);
    return response;
  } finally {
    clearTimeout(timeout);
  }
}