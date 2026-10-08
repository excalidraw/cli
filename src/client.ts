import chalk from "chalk";
import { z } from "zod/v4";
import { DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_RETRIES, resolveConfig } from "./config.js";

import type { Command } from "commander";

const ErrorResponseSchema = z
  .object({
    message: z.string().optional(),
    error: z.string().optional(),
  })
  .loose();

/** Personal (per-user) API keys carry this prefix; every other key is workspace-wide. */
const PERSONAL_API_KEY_PREFIX = "uk-";

/** 429 is always retried. The gateway statuses are retried only for GET, which is safe to repeat. */
const RATE_LIMITED_STATUS = 429;
const GATEWAY_STATUSES = new Set([502, 503, 504]);
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;
const MAX_RETRY_AFTER_MS = 60_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type QueryValue = string | number | boolean | null | undefined;

export type RequestOptions = {
  query?: Record<string, QueryValue>;
  body?: unknown;
  raw?: boolean;
};

type ClientOptions = {
  retries?: number;
  /** Deadline in milliseconds for each attempt, covering the response headers and body. */
  timeout?: number;
  /** Return raw response text instead of parsed JSON unless a request overrides it. */
  raw?: boolean;
  /** Receives a human-readable note before each retry. Defaults to stderr. */
  onRetry?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

export class PublicApiClient {
  private readonly retries: number;
  private readonly timeout: number;
  private readonly raw: boolean;
  private readonly onRetry: (message: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    readonly apiUrl: string,
    private readonly apiKey: string,
    options: ClientOptions = {},
  ) {
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.timeout = options.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.raw = options.raw ?? false;
    this.onRetry =
      options.onRetry ?? ((message) => process.stderr.write(`${chalk.dim(message)}\n`));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get keyType(): "personal" | "workspace" {
    return this.apiKey.startsWith(PERSONAL_API_KEY_PREFIX) ? "personal" : "workspace";
  }

  async request(method: string, path: string, options: RequestOptions = {}) {
    const url = this.createUrl(path, options.query);
    const { response, text } = await this.fetchWithRetry(method, url, options.body);

    if (!response.ok) {
      const parsed = parseJson(text);
      const error = parsed ? ErrorResponseSchema.safeParse(parsed) : null;
      const message = error?.success
        ? (error.data.message ?? error.data.error ?? response.statusText)
        : response.statusText;
      throw new ApiError(response.status, message, text);
    }

    if (options.raw ?? this.raw) {
      return text;
    }

    if (!text) {
      return null;
    }

    const parsed = parseJson(text);

    if (parsed === undefined) {
      throw new Error("API returned non-JSON response. Use --raw to print it.");
    }

    return parsed;
  }

  /** Sends the request and reads the whole response, retrying when that is safe. */
  private async fetchWithRetry(method: string, url: URL, body: unknown) {
    const canRepeat = method === "GET";

    for (let attempt = 0; ; attempt++) {
      const attemptsLeft = this.retries - attempt;
      // One deadline covers the headers and the body, so a stalled or trickling response can't hang the CLI.
      const signal = AbortSignal.timeout(this.timeout);
      let response: Response;

      try {
        response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (canRepeat && attemptsLeft > 0) {
          const reason = isTimeout(error) ? "timed out" : "failed";
          await this.waitBeforeRetry(`Request to ${url.origin} ${reason}`, backoffMs(attempt), attempt);
          continue;
        }

        throw new Error(formatNetworkError(url, error, { method, timeout: this.timeout }), {
          cause: error,
        });
      }

      const rateLimited = response.status === RATE_LIMITED_STATUS;
      const gatewayError = GATEWAY_STATUSES.has(response.status);

      if (attemptsLeft > 0 && (rateLimited || (gatewayError && canRepeat))) {
        // Drain the body so the connection can be reused.
        await response.text().catch(() => undefined);
        const delay = rateLimited
          ? (parseRetryAfter(response.headers.get("retry-after")) ?? backoffMs(attempt))
          : backoffMs(attempt);
        await this.waitBeforeRetry(`HTTP ${response.status}`, delay, attempt);
        continue;
      }

      try {
        return { response, text: await response.text() };
      } catch (error) {
        // The connection dropped, or the deadline passed, after the headers arrived.
        if (canRepeat && attemptsLeft > 0) {
          const reason = isTimeout(error) ? "timed out" : "was interrupted";
          await this.waitBeforeRetry(`Response from ${url.origin} ${reason}`, backoffMs(attempt), attempt);
          continue;
        }

        throw new Error(
          formatNetworkError(url, error, { method, timeout: this.timeout, status: response.status }),
          { cause: error },
        );
      }
    }
  }

  private async waitBeforeRetry(reason: string, delay: number, attempt: number) {
    const seconds = (delay / 1000).toFixed(delay >= 1000 ? 0 : 1);
    this.onRetry(`${reason}; retrying in ${seconds}s (attempt ${attempt + 1} of ${this.retries})`);
    await this.sleep(delay);
  }

  private createUrl(path: string, query: RequestOptions["query"]) {
    const url = new URL(`/api/v1${path}`, this.apiUrl);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) {
        continue;
      }

      url.searchParams.set(key, String(value));
    }

    return url;
  }
}

/**
 * Builds an API path from a template, URL-encoding each interpolated ID so that
 * values like "../collections/abc" stay one path segment instead of changing the route.
 */
export function apiPath(strings: TemplateStringsArray, ...ids: string[]) {
  return strings.reduce((path, part, index) => `${path}${encodePathId(ids[index - 1]!)}${part}`);
}

function encodePathId(id: string) {
  // URL parsing resolves "." and ".." segments even when percent-encoded, so reject them outright.
  if (id === "" || id === "." || id === "..") {
    throw new Error(`Invalid ID: "${id}"`);
  }

  return encodeURIComponent(id);
}

export function getClient(command: Command) {
  const config = resolveConfig(command.optsWithGlobals());
  return new PublicApiClient(config.apiUrl, config.apiKey, {
    retries: config.retries,
    timeout: config.requestTimeout,
    raw: config.raw,
  });
}

/** Exponential backoff with jitter: 0.5s, 1s, 2s, 4s... capped at 10s. */
function backoffMs(attempt: number) {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return base + Math.floor(Math.random() * BASE_BACKOFF_MS * 0.5);
}

/** Retry-After is either whole seconds or an HTTP date. Returns undefined when absent or unparseable. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }

  const seconds = Number(header);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const date = Date.parse(header);

  if (Number.isNaN(date)) {
    return undefined;
  }

  return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
}

/**
 * Explains a request that failed without a complete response. `status` is set when the headers
 * arrived but the body didn't. A write may already have been applied, so the message says so
 * instead of inviting a blind retry.
 */
function formatNetworkError(
  url: URL,
  error: unknown,
  { method, timeout, status }: { method: string; timeout: number; status?: number },
) {
  const mayHaveApplied =
    method === "GET" ? "" : ` The ${method} request may have been applied; check before repeating it.`;
  const subject =
    status === undefined ? `The request to ${url.origin}` : `The response from ${url.origin} (HTTP ${status})`;

  if (isTimeout(error)) {
    return `${subject} timed out after ${timeout} ms.${mayHaveApplied} Use --request-timeout to allow more time.`;
  }

  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const detail = cause instanceof Error ? cause.message : String(cause);

  if (status !== undefined) {
    return `${subject} was interrupted: ${detail}.${mayHaveApplied}`;
  }

  return `Could not reach ${url.origin}: ${detail}. Check --api-url / EXCALIDRAW_API_URL and your network connection.`;
}

/** AbortSignal.timeout() rejects fetch and body reads with a TimeoutError DOMException. */
function isTimeout(error: unknown) {
  return error instanceof Error && error.name === "TimeoutError";
}

function parseJson(text: string) {
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
