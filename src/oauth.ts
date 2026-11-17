import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { z } from "zod/v4";
import { readCredential, saveCredential } from "./credentials.js";
import { describeFetchFailure, httpFetch } from "./http.js";
import { userAgent } from "./package.js";

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthCredential } from "./credentials.js";

/**
 * The CLI's OAuth client id: the URL of its client metadata document (Client ID Metadata
 * Documents), which Excalidraw+ serves. It's the same for every API origin, like a native app's.
 */
export const CLIENT_ID = "https://api.excalidraw.com/oauth/excalidraw-cli.json";

/** What a login may do: the API's REST endpoints as the user, and a refresh token to stay logged in. */
const SCOPE = "api offline_access";

/** Where the API describes its REST endpoints as an OAuth resource (RFC 9728). */
const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/api/v1";

/** The loopback redirect the client metadata registers; the port is picked per login (RFC 8252). */
const CALLBACK_PATH = "/callback";

/**
 * Where the browser goes once the callback got the login's result: the API redirects it to
 * Excalidraw+'s page for it, `?result=success|cancelled|failed`, so the tab ends in its design.
 */
const DONE_PATH = "/oauth/done";

/** How long to wait for the person to finish in the browser. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** Refresh an access token this long before it expires, so a request doesn't carry one that just did. */
const EXPIRY_MARGIN_MS = 60_000;

/** An access token's lifetime when the token response doesn't say. Excalidraw+ issues them for an hour. */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

const ResourceMetadataSchema = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()).min(1),
});

const AuthorizationServerMetadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  revocation_endpoint: z.url().optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
  refresh_token: z.string().min(1).optional(),
});

const OAuthErrorResponseSchema = z.object({ error: z.string(), error_description: z.string().optional() });

/** An error response from the authorization server, such as `invalid_grant` for a revoked refresh token. */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    description: string | undefined,
  ) {
    super(description ? `${description} (${code})` : code);
    this.name = "OAuthError";
  }
}

type RequestSettings = {
  /** Deadline in milliseconds for each request to the API or the authorization server. */
  timeout: number;
};

type Endpoints = {
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
};

/**
 * Finds where to log in for the API: its REST endpoints' resource metadata names the authorization
 * server, whose own metadata (RFC 8414) names the endpoints.
 */
async function discover(apiUrl: string, settings: RequestSettings): Promise<Endpoints> {
  const metadataUrl = new URL(RESOURCE_METADATA_PATH, apiUrl);
  const response = await send(metadataUrl, { timeout: settings.timeout });

  if (response.status === 404) {
    throw new Error(
      `${new URL(apiUrl).origin} doesn't support logging in with the browser. Log in with an API key instead: excalidraw login --api-key <key>`,
    );
  }

  const resourceMetadata = ResourceMetadataSchema.parse(await readJson(response, metadataUrl));
  // The metadata must describe this API (RFC 9728, section 3.3), so tokens are never asked for another one.
  if (!URL.canParse(resourceMetadata.resource) || new URL(resourceMetadata.resource).origin !== metadataUrl.origin) {
    throw new Error(`${metadataUrl} describes a different API (${resourceMetadata.resource}), so the CLI can't log in to it.`);
  }

  const issuer = new URL(resourceMetadata.authorization_servers[0]!);
  // RFC 8414: the well-known segment goes between the host and the issuer's path.
  const issuerPath = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  const serverMetadataUrl = new URL(`/.well-known/oauth-authorization-server${issuerPath}`, issuer);
  const serverMetadata = AuthorizationServerMetadataSchema.parse(
    await readJson(await send(serverMetadataUrl, { timeout: settings.timeout }), serverMetadataUrl),
  );

  if (serverMetadata.issuer.replace(/\/$/, "") !== issuer.href.replace(/\/$/, "")) {
    throw new Error(`${serverMetadataUrl} names a different issuer (${serverMetadata.issuer}), so the CLI can't log in with it.`);
  }
  const methods = serverMetadata.code_challenge_methods_supported;
  if (methods && !methods.includes("S256")) {
    throw new Error(`The authorization server at ${issuer.origin} doesn't support PKCE with S256, so the CLI can't log in with it.`);
  }
  for (const endpoint of [serverMetadata.authorization_endpoint, serverMetadata.token_endpoint, serverMetadata.revocation_endpoint]) {
    if (endpoint && !isSecureUrl(new URL(endpoint))) {
      throw new Error(`The authorization server's endpoint ${endpoint} isn't HTTPS, so the CLI won't send it a login.`);
    }
  }

  return {
    resource: resourceMetadata.resource,
    authorizationEndpoint: serverMetadata.authorization_endpoint,
    tokenEndpoint: serverMetadata.token_endpoint,
    revocationEndpoint: serverMetadata.revocation_endpoint,
  };
}

export type BrowserLoginOptions = RequestSettings & {
  apiUrl: string;
  /** Called with the address to open, and whether a browser was started with it. */
  onAuthorizationUrl: (url: string, opened: boolean) => void;
};

/**
 * Logs in with the browser: OAuth 2.1's authorization code flow with PKCE, receiving the code on a
 * loopback address (RFC 8252). Returns the tokens without saving them.
 */
export async function logInWithBrowser(options: BrowserLoginOptions): Promise<OAuthCredential> {
  const endpoints = await discover(options.apiUrl, options);
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(16));

  const callback = await listenForCallback(state, options.apiUrl);
  try {
    const redirectUri = `http://127.0.0.1:${callback.port}${CALLBACK_PATH}`;
    const authorizationUrl = new URL(endpoints.authorizationEndpoint);
    for (const [name, value] of Object.entries({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: endpoints.resource,
    })) {
      authorizationUrl.searchParams.set(name, value);
    }

    options.onAuthorizationUrl(authorizationUrl.href, await openBrowser(authorizationUrl.href));

    const { code, respond } = await callback.code;
    try {
      const tokens = await requestTokens(
        endpoints.tokenEndpoint,
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: CLIENT_ID,
          code_verifier: verifier,
          resource: endpoints.resource,
        },
        options,
      );
      respond(true);
      return {
        type: "oauth",
        ...tokens,
        clientId: CLIENT_ID,
        resource: endpoints.resource,
        tokenEndpoint: endpoints.tokenEndpoint,
        revocationEndpoint: endpoints.revocationEndpoint,
      };
    } catch (error) {
      respond(false);
      throw error;
    }
  } finally {
    callback.close();
  }
}

type CallbackResult = {
  code: string;
  /** Answers the browser, once the CLI knows whether the login worked. */
  respond: (succeeded: boolean) => void;
};

/**
 * Listens on a free loopback port for the authorization server's redirect. Requests without the
 * login's state are turned away and the wait goes on: any local program can reach the port.
 */
async function listenForCallback(state: string, apiUrl: string) {
  let settle: { resolve: (result: CallbackResult) => void; reject: (error: Error) => void };
  const code = new Promise<CallbackResult>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Rejections are handled where the code is awaited; this keeps an early one from being unhandled.
  code.catch(() => undefined);

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== CALLBACK_PATH || url.searchParams.get("state") !== state) {
      respondWithPage(response, 404, "Not found", "This isn't the login the Excalidraw CLI is waiting for.");
      return;
    }

    const error = url.searchParams.get("error");
    if (error) {
      redirectToResult(response, apiUrl, "cancelled");
      settle.reject(
        error === "access_denied"
          ? new Error("Login cancelled in the browser. Nothing was saved.")
          : new OAuthError(error, url.searchParams.get("error_description") ?? undefined),
      );
      return;
    }

    const authorizationCode = url.searchParams.get("code");
    if (!authorizationCode) {
      redirectToResult(response, apiUrl, "failed");
      settle.reject(new Error("The browser came back without a login code. Nothing was saved."));
      return;
    }

    settle.resolve({
      code: authorizationCode,
      respond: (succeeded) => redirectToResult(response, apiUrl, succeeded ? "success" : "failed"),
    });
  });

  // A browser keeps its connections open after the page; they mustn't keep the CLI running.
  server.on("connection", (socket) => socket.unref());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const timer = setTimeout(
    () => settle.reject(new Error(`Timed out after ${LOGIN_TIMEOUT_MS / 60_000} minutes waiting for the login in the browser. Nothing was saved.`)),
    LOGIN_TIMEOUT_MS,
  );

  return {
    port: (server.address() as AddressInfo).port,
    code,
    close() {
      clearTimeout(timer);
      server.close();
      // Busy connections close once their page is sent (Connection: close).
      server.closeIdleConnections();
    },
  };
}

/** Sends the browser to Excalidraw+'s page for the login's result, through the API it logs in to. */
function redirectToResult(response: ServerResponse, apiUrl: string, result: "success" | "cancelled" | "failed") {
  const location = new URL(DONE_PATH, apiUrl);
  location.searchParams.set("result", result);
  response.writeHead(302, { Location: location.href, "Cache-Control": "no-store", Connection: "close" });
  response.end();
}

/** A plain page for a request that isn't this login's callback, which any local program can send. */
function respondWithPage(response: ServerResponse, status: number, title: string, message: string) {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Excalidraw CLI</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;color:#1b1b1f}@media (prefers-color-scheme:dark){body{background:#121212;color:#e3e3e8}}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .5rem}</style></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Connection: "close" });
  response.end(page);
}

/**
 * Starts the default browser with the URL: $BROWSER when set, else the system's opener. Resolves
 * false when there's no browser to start, such as over SSH, so the caller only prints the URL.
 */
export async function openBrowser(url: string): Promise<boolean> {
  const browser = process.env.BROWSER?.trim();
  let command: string;
  let args: string[];

  if (browser) {
    [command, ...args] = browser.split(/\s+/) as [string, ...string[]];
    args.push(url);
  } else if (process.platform === "darwin") {
    [command, args] = ["open", [url]];
  } else if (process.platform === "win32") {
    // Unlike `start`, it takes the URL as one argument, so cmd.exe never reads its & characters.
    [command, args] = ["rundll32", ["url.dll,FileProtocolHandler", url]];
  } else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    [command, args] = ["xdg-open", [url]];
  } else {
    return false;
  }

  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  try {
    await once(child, "spawn");
  } catch {
    return false;
  }
  child.unref();
  return true;
}

/**
 * Gets new tokens with the refresh token. The authorization server rotates it, so the result
 * carries the new one, or the old one when it didn't send any.
 */
export async function refreshOAuthCredential(credential: OAuthCredential, settings: RequestSettings): Promise<OAuthCredential> {
  if (!credential.refreshToken) {
    throw new OAuthError("invalid_grant", "The login has no refresh token");
  }

  const tokens = await requestTokens(
    credential.tokenEndpoint,
    {
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
      client_id: credential.clientId,
      resource: credential.resource,
    },
    settings,
  );

  return { ...credential, ...tokens, refreshToken: tokens.refreshToken ?? credential.refreshToken };
}

/**
 * Revokes the login's refresh token, and with it the access tokens it would mint. Throws when the
 * server can't be told; the caller decides whether that matters.
 */
export async function revokeOAuthCredential(credential: OAuthCredential, settings: RequestSettings) {
  if (!credential.revocationEndpoint) {
    return false;
  }

  const token = credential.refreshToken ?? credential.accessToken;
  const response = await send(new URL(credential.revocationEndpoint), {
    timeout: settings.timeout,
    form: {
      token,
      token_type_hint: credential.refreshToken ? "refresh_token" : "access_token",
      client_id: credential.clientId,
    },
  });

  if (!response.ok) {
    throw await oauthErrorFrom(response);
  }
  return true;
}

async function requestTokens(tokenEndpoint: string, form: Record<string, string>, settings: RequestSettings) {
  const url = new URL(tokenEndpoint);
  const response = await send(url, { timeout: settings.timeout, form });

  if (!response.ok) {
    throw await oauthErrorFrom(response);
  }

  const tokens = TokenResponseSchema.parse(await readJson(response, url));
  if (tokens.token_type && tokens.token_type.toLowerCase() !== "bearer") {
    throw new Error(`The authorization server issued a ${tokens.token_type} token, which the CLI can't use.`);
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000,
  };
}

async function send(url: URL, { timeout, form }: { timeout: number; form?: Record<string, string> }) {
  try {
    return await httpFetch(url, {
      method: form ? "POST" : "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": userAgent,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    const detail = error instanceof Error && error.name === "TimeoutError" ? `timed out after ${timeout} ms` : describeFetchFailure(error);
    throw new Error(`Could not reach ${url.origin}: ${detail}.`, { cause: error });
  }
}

async function readJson(response: Response, url: URL): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`${url} answered HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${url} didn't answer with JSON.`);
  }
}

async function oauthErrorFrom(response: Response) {
  const text = await response.text().catch(() => "");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const parsed = OAuthErrorResponseSchema.safeParse(body);
  return parsed.success
    ? new OAuthError(parsed.data.error, parsed.data.error_description)
    : new OAuthError(`http_${response.status}`, `The authorization server answered HTTP ${response.status}`);
}

/** HTTPS, or HTTP to this computer, which a local development server uses. *.localhost names are this computer too (RFC 6761). */
function isSecureUrl(url: URL) {
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost");
  return url.protocol === "https:" || (url.protocol === "http:" && loopback);
}

function base64Url(bytes: Buffer) {
  return bytes.toString("base64url");
}

/**
 * A saved browser login, as commands use it: hands out an access token, refreshing it when it's
 * about to expire or the API turned it down, and saves the refreshed tokens for later commands.
 */
export class OAuthSession {
  private refreshing: Promise<void> | undefined;

  constructor(
    private readonly apiUrl: string,
    private credential: OAuthCredential,
    private readonly settings: RequestSettings,
  ) {}

  /** The tokens as they are now, after any refresh. */
  get current() {
    return this.credential;
  }

  async accessToken() {
    if (this.credential.expiresAt - EXPIRY_MARGIN_MS <= Date.now()) {
      await this.refresh();
    }
    return this.credential.accessToken;
  }

  /** Refreshes the tokens; concurrent requests share one refresh. */
  refresh() {
    this.refreshing ??= this.refreshOnce().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refreshOnce() {
    // The login the new tokens replace.
    let replaced = this.credential;
    let next: OAuthCredential;

    try {
      next = await refreshOAuthCredential(replaced, this.settings);
    } catch (error) {
      if (!(error instanceof OAuthError && error.code === "invalid_grant")) {
        throw error;
      }
      // Another command may have refreshed first and saved the rotated token: use that one.
      const saved = savedOAuthCredential(this.apiUrl);
      if (!saved || saved.refreshToken === replaced.refreshToken) {
        throw new Error(
          `The browser login for ${new URL(this.apiUrl).origin} expired or was revoked (${error.message}). Run "excalidraw login" again.`,
          { cause: error },
        );
      }
      this.credential = replaced = saved;
      if (saved.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
        return;
      }
      next = await refreshOAuthCredential(saved, this.settings);
    }

    // Saved only over the login it replaces: a logout or a new login since then wins.
    const saved = savedOAuthCredential(this.apiUrl);
    this.credential = next;
    if (saved?.refreshToken === replaced.refreshToken) {
      await saveCredential(this.apiUrl, next);
    }
  }
}

/** The browser login saved for the API origin, if that's what is saved there. */
function savedOAuthCredential(apiUrl: string) {
  try {
    const saved = readCredential(apiUrl);
    return saved?.type === "oauth" ? saved : undefined;
  } catch {
    return undefined;
  }
}
