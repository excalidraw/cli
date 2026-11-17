import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { assertExecError, cliEnv, escapeRegExp } from "./helpers.ts";

import type { AddressInfo } from "node:net";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

const CLIENT_ID = "https://api.excalidraw.com/oauth/excalidraw-cli.json";
const WORKSPACE = { id: "ws_1", name: "Acme", subscriptionStatus: "active" };

/** What the mock authorization server was asked to do, and how it answers. */
type AuthServer = {
  origin: string;
  authorizeRequests: URLSearchParams[];
  tokenRequests: URLSearchParams[];
  revokeRequests: URLSearchParams[];
  apiTokens: string[];
  /** The results the browser was sent to Excalidraw+'s page for, once the login ended. */
  doneResults: string[];
  /** Access tokens the API accepts; the test can take one away to act out a revocation. */
  validAccessTokens: Set<string>;
  validRefreshTokens: Set<string>;
  /** Seconds an access token lasts, as the token response says. */
  expiresIn: number;
  /** When set, the person turns the CLI down in the browser. */
  deny: boolean;
  /** When false, the API has no OAuth resource metadata, like an older server. */
  supportsOAuth: boolean;
  /** How the revocation endpoint answers: as Better Auth does for a token it no longer has, or failing. */
  revokeAnswer: "ok" | "token-not-found" | "server-error";
};

/**
 * An Excalidraw+ API with its authorization server on the same origin, as a local development
 * server has it: resource metadata, authorization server metadata, the authorize, token and revoke
 * endpoints, and GET /api/v1/workspaces for the access tokens it issued.
 */
async function startAuthServer() {
  const codes = new Map<string, { challenge: string; redirectUri: string; resource: string }>();
  let issued = 0;
  const state: AuthServer = {
    origin: "",
    authorizeRequests: [],
    tokenRequests: [],
    revokeRequests: [],
    apiTokens: [],
    doneResults: [],
    validAccessTokens: new Set(),
    validRefreshTokens: new Set(),
    expiresIn: 3600,
    deny: false,
    supportsOAuth: true,
    revokeAnswer: "ok",
  };

  const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readForm = async (req: import("node:http").IncomingMessage) => {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }
    return new URLSearchParams(body);
  };
  const issueTokens = () => {
    issued += 1;
    const tokens = { access_token: `access-${issued}`, refresh_token: `refresh-${issued}` };
    state.validAccessTokens.add(tokens.access_token);
    state.validRefreshTokens.add(tokens.refresh_token);
    return { ...tokens, token_type: "Bearer", expires_in: state.expiresIn, scope: "api offline_access" };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, state.origin);
    const issuer = `${state.origin}/api/auth`;

    if (url.pathname === "/.well-known/oauth-protected-resource/api/v1" && state.supportsOAuth) {
      json(res, 200, { resource: `${state.origin}/api/v1`, authorization_servers: [issuer], scopes_supported: ["api"] });
    } else if (url.pathname === "/.well-known/oauth-authorization-server/api/auth") {
      json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/oauth2/authorize`,
        token_endpoint: `${issuer}/oauth2/token`,
        revocation_endpoint: `${issuer}/oauth2/revoke`,
        code_challenge_methods_supported: ["S256"],
      });
    } else if (url.pathname === "/api/auth/oauth2/authorize") {
      // The person signs in, picks a workspace and allows the CLI: the browser lands on the callback.
      state.authorizeRequests.push(url.searchParams);
      const redirect = new URL(url.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("state", url.searchParams.get("state")!);
      if (state.deny) {
        redirect.searchParams.set("error", "access_denied");
      } else {
        const code = `code-${state.authorizeRequests.length}`;
        codes.set(code, {
          challenge: url.searchParams.get("code_challenge")!,
          redirectUri: redirect.href.split("?")[0]!,
          resource: url.searchParams.get("resource")!,
        });
        redirect.searchParams.set("code", code);
      }
      res.writeHead(302, { Location: redirect.href });
      res.end();
    } else if (url.pathname === "/api/auth/oauth2/token" && req.method === "POST") {
      const form = await readForm(req);
      state.tokenRequests.push(form);
      if (form.get("grant_type") === "authorization_code") {
        const grant = codes.get(form.get("code")!);
        codes.delete(form.get("code")!);
        const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (
          !grant ||
          grant.challenge !== challenge ||
          grant.redirectUri !== form.get("redirect_uri") ||
          grant.resource !== form.get("resource") ||
          form.get("client_id") !== CLIENT_ID
        ) {
          json(res, 400, { error: "invalid_grant", error_description: "invalid authorization code" });
          return;
        }
        json(res, 200, issueTokens());
      } else if (form.get("grant_type") === "refresh_token" && state.validRefreshTokens.delete(form.get("refresh_token")!)) {
        json(res, 200, issueTokens());
      } else {
        json(res, 400, { error: "invalid_grant", error_description: "invalid refresh token" });
      }
    } else if (url.pathname === "/api/auth/oauth2/revoke" && req.method === "POST") {
      const form = await readForm(req);
      state.revokeRequests.push(form);
      if (state.revokeAnswer === "token-not-found") {
        json(res, 400, { error: "invalid_request", error_description: "token not found" });
      } else if (state.revokeAnswer === "server-error") {
        res.writeHead(500).end();
      } else {
        state.validRefreshTokens.delete(form.get("token")!);
        res.writeHead(200).end();
      }
    } else if (url.pathname === "/oauth/done") {
      state.doneResults.push(url.search);
      res.writeHead(200).end();
    } else if (url.pathname === "/api/v1/workspaces") {
      const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      state.apiTokens.push(token);
      if (state.validAccessTokens.has(token)) {
        json(res, 200, WORKSPACE);
      } else {
        json(res, 401, { message: "Invalid access token" });
      }
    } else {
      json(res, 404, { message: "Not found" });
    }
  });

  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return { state, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A browser that follows the authorization request's redirect back to the CLI, as a person allowing it would. */
async function writeFakeBrowser(dir: string) {
  const path = join(dir, "fake-browser.mjs");
  await writeFile(
    path,
    `#!/usr/bin/env node
const response = await fetch(process.argv[2], { redirect: "manual" });
await fetch(response.headers.get("location"));
`,
  );
  await chmod(path, 0o755);
  return path;
}

async function setUp(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "excalidraw-cli-oauth-"));
  const server = await startAuthServer();
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const browser = await writeFakeBrowser(dir);
  const credentialsFile = join(dir, "excalidraw-cli", "credentials.json");
  const env = cliEnv({ XDG_CONFIG_HOME: dir, BROWSER: browser, EXCALIDRAW_API_KEY: "" });
  const run = (args: string[]) =>
    execFileAsync(process.execPath, [cliPath, "--api-url", server.state.origin, ...args], { env, timeout: 30_000 });
  const saved = async () => JSON.parse(await readFile(credentialsFile, "utf8")).origins[server.state.origin];

  return { server: server.state, run, saved, credentialsFile };
}

/** The result pages the browser was sent to; the browser follows the redirect after the CLI answers it. */
async function doneResults(server: AuthServer) {
  for (let tries = 0; tries < 50 && !server.doneResults.length; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return server.doneResults;
}

// The fake browser is a script run through its shebang.
const skip = process.platform === "win32" ? "the fake browser needs a shebang" : false;

test("login --web logs in with the browser, and commands use the login", { skip }, async (t) => {
  const { server, run, saved } = await setUp(t);

  const login = await run(["login", "--web"]);
  assert.equal(login.stdout, "");
  assert.match(login.stderr, /Allow the CLI in the browser that opened\. If it didn't open, go to:\nhttp:\/\/127\.0\.0\.1:\d+\/api\/auth\/oauth2\/authorize\?/);
  assert.match(login.stderr, /Logged in to Acme\n$/);
  // The tab ends on Excalidraw+'s page, which the API redirects to.
  assert.deepEqual(await doneResults(server), ["?result=success"]);

  const [authorize] = server.authorizeRequests;
  assert.ok(authorize);
  assert.equal(authorize.get("client_id"), CLIENT_ID);
  assert.equal(authorize.get("response_type"), "code");
  assert.equal(authorize.get("scope"), "api offline_access");
  assert.equal(authorize.get("resource"), `${server.origin}/api/v1`);
  assert.equal(authorize.get("code_challenge_method"), "S256");
  assert.match(authorize.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.ok(authorize.get("state"));

  const credential = await saved();
  assert.deepEqual({ ...credential, expiresAt: typeof credential.expiresAt }, {
    type: "oauth",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: "number",
    clientId: CLIENT_ID,
    resource: `${server.origin}/api/v1`,
    tokenEndpoint: `${server.origin}/api/auth/oauth2/token`,
    revocationEndpoint: `${server.origin}/api/auth/oauth2/revoke`,
  });

  const whoami = JSON.parse((await run(["whoami"])).stdout);
  assert.deepEqual(whoami, { apiUrl: server.origin, keyType: "oauth", credentialSource: "login", workspace: WORKSPACE });
  assert.equal(server.apiTokens.at(-1), "access-1");
});

test("commands refresh an access token that is about to expire, or that the API turned down", { skip }, async (t) => {
  const { server, run, saved } = await setUp(t);
  // Within the minute the CLI keeps in hand, so the first command refreshes before its request.
  server.expiresIn = 30;
  await run(["login", "--web"]);

  await run(["whoami"]);
  assert.deepEqual(server.tokenRequests.at(-1)?.get("grant_type"), "refresh_token");
  assert.equal(server.tokenRequests.at(-1)?.get("resource"), `${server.origin}/api/v1`);
  assert.equal(server.apiTokens.at(-1), "access-3");
  // The rotated tokens are saved for the next command.
  assert.equal((await saved()).refreshToken, "refresh-3");

  // An access token the API no longer takes: refreshed once, and the request is sent again.
  server.expiresIn = 3600;
  await run(["whoami"]);
  server.validAccessTokens.clear();
  const whoami = JSON.parse((await run(["whoami"])).stdout);
  assert.equal(whoami.workspace.name, "Acme");
  assert.deepEqual(server.apiTokens.slice(-2), ["access-4", "access-5"]);
  assert.equal((await saved()).accessToken, "access-5");
});

test("a revoked login asks to log in again", { skip }, async (t) => {
  const { server, run } = await setUp(t);
  await run(["login", "--web"]);
  server.validAccessTokens.clear();
  server.validRefreshTokens.clear();

  await assert.rejects(
    () => run(["whoami"]),
    (error: unknown) => {
      assertExecError(error);
      assert.equal(error.code, 1);
      assert.match(
        error.stderr,
        new RegExp(`The browser login for ${escapeRegExp(server.origin)} expired or was revoked \\(invalid refresh token \\(invalid_grant\\)\\)\\. Run "excalidraw login" again\\.`),
      );
      return true;
    },
  );
});

test("logout revokes the browser login and removes it", { skip }, async (t) => {
  const { server, run, credentialsFile } = await setUp(t);
  await run(["login", "--web"]);

  const logout = await run(["logout"]);
  assert.equal(logout.stderr, `Logged out of ${server.origin}\n`);
  assert.equal(server.revokeRequests.length, 1);
  assert.equal(server.revokeRequests[0]?.get("token"), "refresh-1");
  assert.equal(server.revokeRequests[0]?.get("token_type_hint"), "refresh_token");
  assert.equal(server.revokeRequests[0]?.get("client_id"), CLIENT_ID);
  assert.equal(existsSync(credentialsFile), false);
});

test("logout says nothing more of a login the server already dropped, and warns when it couldn't be asked", { skip }, async (t) => {
  const { server, run, credentialsFile } = await setUp(t);

  // Disconnected in Excalidraw+: the server no longer knows the token.
  await run(["login", "--web"]);
  server.revokeAnswer = "token-not-found";
  assert.equal((await run(["logout"])).stderr, `Logged out of ${server.origin}\n`);
  assert.equal(existsSync(credentialsFile), false);

  await run(["login", "--web"]);
  server.revokeAnswer = "server-error";
  const logout = await run(["logout"]);
  assert.match(logout.stderr, /^Logged out of .*\nCouldn't revoke the browser login \(.*HTTP 500.*\)\. To cut it off, disconnect "Excalidraw CLI" in Excalidraw\+ under Settings → Connected apps\.\n$/);
  assert.equal(existsSync(credentialsFile), false);
});

test("login saves nothing when the person turns the CLI down in the browser", { skip }, async (t) => {
  const { server, run, credentialsFile } = await setUp(t);
  server.deny = true;

  await assert.rejects(
    () => run(["login", "--web"]),
    (error: unknown) => {
      assertExecError(error);
      assert.match(error.stderr, /Login cancelled in the browser\. Nothing was saved\./);
      return true;
    },
  );
  assert.deepEqual(await doneResults(server), ["?result=cancelled"]);
  assert.equal(server.tokenRequests.length, 0);
  assert.equal(existsSync(credentialsFile), false);
});

test("login --web explains an API that doesn't support logging in with the browser", { skip }, async (t) => {
  const { server, run } = await setUp(t);
  server.supportsOAuth = false;

  await assert.rejects(
    () => run(["login", "--web"]),
    (error: unknown) => {
      assertExecError(error);
      assert.match(
        error.stderr,
        new RegExp(`${escapeRegExp(server.origin)} doesn't support logging in with the browser\\. Log in with an API key instead: excalidraw login --api-key <key>`),
      );
      return true;
    },
  );
  assert.equal(server.authorizeRequests.length, 0);
});

test("login refuses --web together with --api-key", async () => {
  await assert.rejects(
    () => execFileAsync(process.execPath, [cliPath, "login", "--web", "--api-key", "uk-x"], { env: cliEnv() }),
    (error: unknown) => {
      assertExecError(error);
      assert.match(error.stderr, /Pass either --web or --api-key, not both\./);
      return true;
    },
  );
});
