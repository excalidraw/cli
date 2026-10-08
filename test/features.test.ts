import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { assertExecError, cliEnv, escapeRegExp, runWithStdout } from "./helpers.ts";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

type ApiCall = {
  method: string | undefined;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | undefined;
};

type ApiContext = {
  origin: string;
  calls: ApiCall[];
};

const SCENE_COUNT = 7;
const scenes = Array.from({ length: SCENE_COUNT }, (_, index) => ({
  metadata: {
    id: `scene_${index}`,
    name: `Scene ${index}`,
    collection: "col_1",
    pinned: index % 2 === 0,
    updated: "2026-09-07T10:00:00.000Z",
  },
  readOnlyLinks: [],
  sharedSlidesLinks: [],
}));

const logs = Array.from({ length: 5 }, (_, index) => ({
  id: `log_${index}`,
  action: "scene",
  operation: "update",
  created_at: `2026-09-0${index + 1}T00:00:00.000Z`,
  user_id: "user_1",
  user_email: "ada@example.com",
  status: 200,
}));

/** A name that clears the screen, sets the clipboard (OSC 52), and uses 8-bit CSI and NUL. */
const HOSTILE_NAME = "\u001b[2J\u001b[HSpoofed \u001b]52;c;aGk=\u0007name\u009b31m\u0000";
// Everything a terminal could act on, except the tabs and newlines of formatted output.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/** More rows than a function call takes as arguments, like a full audit-log scan of a large workspace. */
const HUGE_LIST = 150_000;

/** An error page like a gateway's, far longer than what stderr should show by default. */
const LONG_ERROR_PAGE = `<html><body>${"Bad request from the gateway. ".repeat(100)}</body></html>`;

/** A valid workspace key whose permissions don't include reading the workspace. */
const LIMITED_KEY = "limited-key";

/** Minimal stand-in for the public API: offset lists, cursor logs, workspace, content writes, and 429s. */
function createMockApi() {
  const calls: ApiCall[] = [];
  let rateLimitHits = 0;

  const server = createServer(async (req, res) => {
    assert.ok(req.url);
    const url = new URL(req.url, "http://localhost");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body: ApiCall["body"] = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });

    const send = (status: number, payload: unknown, headers: OutgoingHttpHeaders = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };

    if (!["Bearer test-key", "Bearer uk-test-key", `Bearer ${LIMITED_KEY}`].includes(req.headers.authorization ?? "")) {
      return send(401, { statusCode: 401, error: "Unauthorized", message: "Unauthorized" });
    }

    if (url.pathname === "/api/v1/workspaces" && req.headers.authorization === `Bearer ${LIMITED_KEY}`) {
      return send(403, { statusCode: 403, error: "Forbidden", message: "Missing permission" });
    }

    if (url.pathname === "/api/v1/scenes" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 5);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const page = scenes.slice(offset, offset + limit);
      return send(200, { limit, offset, hasNextPage: offset + limit < scenes.length, data: page });
    }

    if (url.pathname === "/api/v1/scenes" && req.method === "POST") {
      assert.ok(body);
      return send(200, { metadata: { id: "scene_new", name: body.name, collection: body.collectionId }, readOnlyLinks: [], sharedSlidesLinks: [] });
    }

    if (url.pathname === "/api/v1/collections/col_1/scenes" && req.method === "POST") {
      assert.ok(body);
      return send(200, { metadata: { id: "scene_new", name: body.name, collection: "col_1" }, readOnlyLinks: [], sharedSlidesLinks: [] });
    }

    if (url.pathname === "/api/v1/scenes/scene_new/content") {
      assert.ok(body);
      return send(200, { type: "excalidraw", version: 2, source: "api", elements: body.elements ?? [], appState: body.appState ?? {}, files: {}, sceneVersion: "1" });
    }

    if (url.pathname === "/api/v1/scenes/scene_1/content" && req.method === "GET") {
      return send(200, { type: "excalidraw", version: 2, source: "api", elements: [], appState: {}, files: {}, sceneVersion: "1" });
    }

    if (url.pathname === "/api/v1/scenes/scene_1/content" && req.method === "PATCH") {
      assert.ok(body);
      return send(200, { type: "excalidraw", version: 2, source: "api", elements: [], appState: body.appState, files: {}, sceneVersion: "2" });
    }

    // Sends the headers and part of the body, then drops the connection or never finishes.
    const partial = (then: "drop" | "stall") => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
      res.write('{"metadata":', () => {
        if (then === "drop") res.destroy();
      });
    };
    const attempt = calls.filter((call) => call.method === req.method && call.path === url.pathname).length;

    if (url.pathname === "/api/v1/scenes/cut_off") {
      // A GET succeeds on its second attempt; a write is cut off every time.
      return req.method === "GET" && attempt > 1 ? send(200, { metadata: { id: "cut_off" } }) : partial("drop");
    }

    if (url.pathname === "/api/v1/scenes/stalled_headers") {
      return;
    }

    if (url.pathname === "/api/v1/scenes/stalled_body") {
      return partial("stall");
    }

    if (url.pathname === "/api/v1/scenes/html_error") {
      res.writeHead(400, { "content-type": "text/html" }).end(LONG_ERROR_PAGE);
      return;
    }

    if (url.pathname === "/api/v1/logs") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const cursor = url.searchParams.get("cursor");
      const start = cursor ? logs.findIndex((log) => `cursor-${log.id}` === cursor) : 0;
      const page = logs.slice(start, start + limit);
      const next = logs[start + limit];
      return send(200, { logs: page, nextCursor: next ? `cursor-${next.id}` : null, hasMore: Boolean(next), availableActions: ["scene"] });
    }

    if (url.pathname === "/api/v1/workspaces") {
      return send(200, { id: "ws_1", name: "Acme", subscriptionStatus: "active", users: ["u1", "u2"], created: "2026-01-01T00:00:00.000Z" });
    }

    if (url.pathname === "/api/v1/collections/wide/scenes") {
      const names = ["Ada", "山田太郎", "あ".repeat(30), "😀".repeat(30)];
      const data = names.map((name, index) => ({ metadata: { id: `s${index + 1}`, name, collection: "c" } }));
      return send(200, { limit: 5, offset: 0, hasNextPage: false, data });
    }

    if (url.pathname === "/api/v1/collections/huge/scenes") {
      const data = Array.from({ length: HUGE_LIST }, (_, index) => ({ metadata: { id: `s${index}`, name: "n" } }));
      return send(200, { limit: HUGE_LIST, offset: 0, hasNextPage: false, data });
    }

    if (url.pathname === "/api/v1/workspaces/users") {
      return send(200, { limit: 5, offset: 0, hasNextPage: false, data: [{ id: "user_1", name: HOSTILE_NAME, email: "ada@example.com", role: "member" }] });
    }

    if (url.pathname === "/api/v1/workspaces/users/user_1") {
      return send(400, { statusCode: 400, error: "Bad Request", message: HOSTILE_NAME });
    }

    if (url.pathname === "/api/v1/workspaces/invites" && req.method === "POST") {
      assert.ok(body);
      return send(200, { id: "inv_1", type: "link", role: body.role, maxUses: body.maxUses, restrictedDomains: body.restrictedDomains ?? null, status: "pending", uses: 0 });
    }

    if (url.pathname === "/api/v1/workspaces/invites" && req.method === "GET") {
      return send(200, {
        limit: 5,
        offset: 0,
        hasNextPage: false,
        data: [
          { id: "inv_1", type: "link", role: "member", status: "pending", uses: 2, maxUses: "unlimited", restrictedDomains: null },
          { id: "inv_2", type: "email", email: "ada@example.com", role: "admin", status: "pending", restrictedDomains: null },
        ],
      });
    }

    if (url.pathname === "/api/v1/workspaces/invites/inv_1" && req.method === "PATCH") {
      return send(200, { id: "inv_1", ...body });
    }

    if (url.pathname === "/api/v1/collections") {
      rateLimitHits += 1;
      if (rateLimitHits <= 2) {
        return send(429, { statusCode: 429, error: "Too Many Requests", message: "Rate limit exceeded" }, { "retry-after": "0" });
      }
      return send(200, { limit: 5, offset: 0, hasNextPage: false, data: [{ id: "col_1", name: "Docs", created: "2026-01-01T00:00:00.000Z" }] });
    }

    send(404, { statusCode: 404, error: "Not Found", message: "Not Found" });
  });

  return {
    calls,
    listen: () => new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve(`http://127.0.0.1:${address.port}`);
    })),
    close: () => {
      // Stalled responses never end on their own.
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function withApi(fn: (api: ApiContext) => Promise<void>) {
  const api = createMockApi();
  const origin = await api.listen();
  try {
    await fn({ origin, calls: api.calls });
  } finally {
    await api.close();
  }
}

function apiEnv(env: NodeJS.ProcessEnv = {}) {
  return cliEnv({ EXCALIDRAW_API_KEY: "test-key", ...env });
}

async function runCli(args: string[], { origin, input, env = {}, cwd }: {
  origin: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}) {
  const child = execFileAsync(process.execPath, [cliPath, "--api-url", origin, ...args], {
    cwd,
    env: apiEnv(env),
    maxBuffer: 1024 * 1024 * 10,
  });

  if (input !== undefined) {
    assert.ok(child.child.stdin);
    child.child.stdin.end(input);
  }

  return child;
}

test("--all walks every offset page and reports the combined count", async () => {
  await withApi(async ({ origin, calls }) => {
    const { stdout } = await runCli(["scenes", "list", "--all", "--limit", "3"], { origin });
    const result: { count: number; data: typeof scenes; hasNextPage?: boolean } = JSON.parse(stdout);

    assert.equal(result.count, SCENE_COUNT);
    assert.deepEqual(result.data.map((scene) => scene.metadata.id), scenes.map((scene) => scene.metadata.id));
    assert.equal(result.hasNextPage, undefined);

    const listCalls = calls.filter((call) => call.path === "/api/v1/scenes");
    assert.deepEqual(listCalls.map((call) => call.query.offset), ["0", "3", "6"]);
    assert.ok(listCalls.every((call) => call.query.all === undefined), "--all must not be sent as a query param");
  });
});

test("--all defaults to the maximum page size", async () => {
  await withApi(async ({ origin, calls }) => {
    await runCli(["scenes", "list", "--all"], { origin });
    assert.equal(calls[0].query.limit, "100");
  });
});

test("logs --all follows nextCursor until hasMore is false", async () => {
  await withApi(async ({ origin, calls }) => {
    const { stdout } = await runCli(["logs", "list", "--all", "--limit", "2"], { origin });
    const result = JSON.parse(stdout);

    assert.equal(result.count, logs.length);
    assert.deepEqual(result.availableActions, ["scene"]);
    assert.deepEqual(calls.map((call) => call.query.cursor), [undefined, "cursor-log_2", "cursor-log_4"]);
  });
});

test("logs --all rejects --page", async () => {
  await withApi(async ({ origin }) => {
    await assert.rejects(
      () => runCli(["logs", "list", "--all", "--page", "2"], { origin }),
      (error: unknown) => {
        assertExecError(error);
        assert.match(error.stderr, /cannot be combined with --page/);
        return true;
      },
    );
  });
});

test("--output table renders list columns", async () => {
  await withApi(async ({ origin }) => {
    const { stdout } = await runCli(["scenes", "list", "--limit", "2", "--output", "table"], { origin });
    const lines = stdout.trimEnd().split("\n");

    assert.equal(lines.length, 3);
    assert.match(lines[0], /^ID\s+NAME\s+COLLECTION\s+PINNED\s+UPDATED$/);
    assert.match(lines[1], /^scene_0\s+Scene 0\s+col_1\s+yes\s+2026-09-07T10:00:00\.000Z$/);
    assert.match(lines[2], /^scene_1\s+Scene 1\s+col_1\s+no\s+/);
  });
});

test("--output table works with the short flag and --all, and falls back to JSON elsewhere", async () => {
  await withApi(async ({ origin }) => {
    const { stdout } = await runCli(["scenes", "list", "--all", "-o", "table"], { origin });
    assert.equal(stdout.trimEnd().split("\n").length, SCENE_COUNT + 1);

    const fallback = await runCli(["scenes", "create", "--name", "X", "--collection-id", "col_1", "-o", "table"], { origin });
    assert.equal(JSON.parse(fallback.stdout).metadata.id, "scene_new");
  });
});

test("--output rejects unknown formats", async () => {
  await withApi(async ({ origin }) => {
    await assert.rejects(
      () => runCli(["scenes", "list", "--output", "yaml"], { origin }),
      (error: unknown) => {
        assertExecError(error);
        assert.match(error.stderr, /Invalid output format/);
        return true;
      },
    );
  });
});

test("--file - reads scene content from stdin", async () => {
  await withApi(async ({ origin, calls }) => {
    const patch = { appState: { viewBackgroundColor: "#123456" } };
    const { stdout } = await runCli(["scenes", "content", "patch", "scene_1", "--file", "-"], {
      origin,
      input: JSON.stringify(patch),
    });

    assert.equal(JSON.parse(stdout).appState.viewBackgroundColor, "#123456");
    assert.deepEqual(calls[0].body, patch);
  });
});

test("JSON input may start with a UTF-8 byte order mark", async () => {
  await withApi(async ({ origin, calls }) => {
    const patch = { appState: { viewBackgroundColor: "#123456" } };
    await runCli(["scenes", "content", "patch", "scene_1", "--file", "-"], { origin, input: `﻿${JSON.stringify(patch)}` });
    assert.deepEqual(calls[0].body, patch);
  });
});

test("--file - rejects invalid JSON with a stdin-specific message", async () => {
  await withApi(async ({ origin }) => {
    await assert.rejects(
      () => runCli(["scenes", "content", "patch", "scene_1", "--file", "-"], { origin, input: "{nope" }),
      (error: unknown) => {
        assertExecError(error);
        assert.match(error.stderr, /Failed to parse JSON from stdin/);
        return true;
      },
    );
  });
});

test("scenes content get --out - prints to stdout instead of a file named -", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-content-out-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await withApi(async ({ origin }) => {
    const { stdout } = await runCli(["scenes", "content", "get", "scene_1", "--out", "-"], { origin, cwd: directory });
    assert.equal(JSON.parse(stdout).sceneVersion, "1");
    assert.deepEqual(await readdir(directory), []);
  });
});

test("scenes create --file uses PUT for full exports and PATCH for partial content", async () => {
  await withApi(async ({ origin, calls }) => {
    const full = { type: "excalidraw", version: 2, source: "test", elements: [], appState: { viewBackgroundColor: "#fff" }, files: {} };
    const { stdout } = await runCli(["scenes", "create", "--name", "Full", "--collection-id", "col_1", "--file", "-"], {
      origin,
      input: JSON.stringify(full),
    });

    assert.equal(JSON.parse(stdout).metadata.id, "scene_new");
    assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ["POST /api/v1/scenes", "PUT /api/v1/scenes/scene_new/content"]);
    assert.deepEqual(calls[1].body, full);

    calls.length = 0;
    await runCli(["collections", "scenes", "create", "col_1", "--name", "Partial", "--file", "-"], {
      origin,
      input: JSON.stringify({ elements: [] }),
    });
    assert.equal(calls[1].method, "PATCH");
    assert.ok(calls[0].body);
    assert.equal(calls[0].body.collectionId, undefined, "collection-scoped create must not send collectionId in the body");
  });
});

test("scenes create --file validates the file before creating the scene", async () => {
  await withApi(async ({ origin, calls }) => {
    const full = { type: "excalidraw", version: 2, source: "test", elements: [], appState: {}, files: {} };
    const cases: [unknown, RegExp[]][] = [
      [[], [/stdin is not valid partial scene content, so no scene was created:/, /expected object, received array/]],
      [{ type: "excalidraw" }, [/stdin is not a complete Excalidraw export, so no scene was created:\n {2}- elements: [^\n]+\n$/]],
      [{ ...full, version: "2" }, [/- version: .*expected number/]],
      [{ ...full, files: { img: { id: "img", mimeType: "image/png", dataURL: "data:," } } }, [/- files\.img\.created: /]],
      [{ elements: "not-an-array" }, [/- elements: .*expected array/]],
      [{ elements: [{ id: "a" }, "b"] }, [/- elements\.1: /]],
      [{ element: [] }, [/Provide at least one of elements, appState, or files\./]],
      [{ elements: Array(12).fill("x") }, [/- elements\.9: /, /- …and 2 more$/m]],
    ];

    for (const [content, messages] of cases) {
      await assert.rejects(
        () => runCli(["scenes", "create", "--name", "Bad", "--collection-id", "col_1", "--file", "-"], { origin, input: JSON.stringify(content) }),
        (error: unknown) => {
          assertExecError(error);
          assert.equal(error.code, 1);
          for (const message of messages) assert.match(error.stderr, message);
          return true;
        },
      );
    }
    assert.equal(calls.length, 0, "no scene should be created when the content can't be written");

    // Fields the CLI doesn't know about are sent as they are.
    const extended = { ...full, elements: [{ id: "a", futureProperty: 1 }], appState: { gridSize: 20 }, libraryItems: [] };
    await runCli(["scenes", "create", "--name", "Good", "--collection-id", "col_1", "--file", "-"], { origin, input: JSON.stringify(extended) });
    assert.deepEqual(calls.map((call) => call.method), ["POST", "PUT"]);
    assert.deepEqual(calls[1].body, extended);
  });
});

test("full exports get the fields Excalidraw treats as optional but the API requires", async () => {
  await withApi(async ({ origin, calls }) => {
    const defaults = { type: "excalidraw", version: 2, source: "https://www.npmjs.com/package/@excalidraw/cli", appState: {}, files: {} };
    const elements = [{ id: "a", type: "rectangle" }];

    await runCli(["scenes", "create", "--name", "Generated", "--collection-id", "col_1", "--file", "-"], {
      origin,
      input: JSON.stringify({ type: "excalidraw", elements }),
    });
    assert.deepEqual(calls[1].body, { ...defaults, elements });

    // put also adds the type, and keeps values the file already has.
    await runCli(["scenes", "content", "put", "scene_new", "--file", "-"], { origin, input: JSON.stringify({ elements, source: "my-script" }) });
    assert.equal(calls[2].method, "PUT");
    assert.deepEqual(calls[2].body, { ...defaults, source: "my-script", elements });

    await assert.rejects(
      () => runCli(["scenes", "content", "put", "scene_new", "--file", "-"], { origin, input: "{}" }),
      (error: unknown) => {
        assertExecError(error);
        assert.match(error.stderr, /stdin is not a complete Excalidraw export, so the scene was not changed:\n {2}- elements: /);
        return true;
      },
    );
    assert.equal(calls.length, 3, "an invalid replacement is never sent");
  });
});

test("whoami reports key type and workspace summary", async () => {
  await withApi(async ({ origin }) => {
    const personal = JSON.parse((await runCli(["whoami"], { origin, env: { EXCALIDRAW_API_KEY: "uk-test-key" } })).stdout);
    assert.equal(personal.keyType, "personal");
    assert.equal(personal.apiUrl, origin);
    assert.deepEqual(personal.workspace, { id: "ws_1", name: "Acme", subscriptionStatus: "active" });

    const workspace = JSON.parse((await runCli(["whoami"], { origin })).stdout);
    assert.equal(workspace.keyType, "workspace");

    const { stdout } = await runCli(["whoami", "-o", "table"], { origin });
    assert.match(stdout, /^FIELD\s+VALUE$/m);
    assert.match(stdout, /^workspace\.name\s+Acme$/m);
  });
});

test("login saves the key per API origin, and commands use it unless a flag or variable overrides it", async (t) => {
  const config = await mkdtemp(join(tmpdir(), "excalidraw-cli-config-"));
  t.after(() => rm(config, { recursive: true, force: true }));
  const file = join(config, "excalidraw-cli", "credentials.json");
  // A blank variable counts as unset, so the saved key applies.
  const env = { XDG_CONFIG_HOME: config, EXCALIDRAW_API_KEY: "" };

  await withApi(async ({ origin }) => {
    await withApi(async ({ origin: other }) => {
      const login = await runCli(["login", "--api-key", "uk-test-key"], { origin, env });
      assert.equal(login.stdout, "");
      assert.equal(login.stderr, "Logged in to Acme\n");
      await runCli(["login", "--api-key", "test-key"], { origin: other, env });

      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
        version: 1,
        origins: {
          [origin]: { type: "api-key", apiKey: "uk-test-key" },
          [other]: { type: "api-key", apiKey: "test-key" },
        },
      });
      if (process.platform !== "win32") {
        assert.equal((await stat(file)).mode & 0o777, 0o600);
        assert.equal((await stat(dirname(file))).mode & 0o777, 0o700);
      }

      const whoami = async (origin: string, args: string[] = [], extraEnv = {}) =>
        JSON.parse((await runCli(["whoami", ...args], { origin, env: { ...env, ...extraEnv } })).stdout);
      assert.deepEqual(await whoami(origin), { ...(await whoami(origin, ["--api-key", "uk-test-key"])), credentialSource: "login" });
      assert.equal((await whoami(other)).keyType, "workspace");
      // The mock rejects other keys, so a workspace key type proves which key was sent.
      assert.deepEqual(await whoami(origin, [], { EXCALIDRAW_API_KEY: "test-key" }), {
        apiUrl: origin,
        keyType: "workspace",
        credentialSource: "env",
        workspace: { id: "ws_1", name: "Acme", subscriptionStatus: "active" },
      });
      assert.equal((await whoami(origin, ["--api-key", "test-key"])).credentialSource, "flag");

      assert.deepEqual(await runCli(["logout"], { origin: other, env }), { stdout: "", stderr: `Logged out of ${other}\n` });
      assert.deepEqual(await runCli(["logout"], { origin: other, env }), { stdout: "", stderr: `No key was saved for ${other}\n` });
      await assert.rejects(
        () => runCli(["scenes", "list"], { origin: other, env }),
        (error: unknown) => {
          assertExecError(error);
          assert.match(error.stderr, new RegExp(`Missing API key for ${escapeRegExp(other)}\\. Run "excalidraw login"`));
          return true;
        },
      );
      assert.equal((await whoami(origin)).credentialSource, "login", "logging out of one origin keeps the others");

      await runCli(["logout"], { origin, env });
      assert.equal(existsSync(file), false, "the file is removed with its last key");
    });
  });
});

test("login doesn't save a key the API rejects, and doesn't save EXCALIDRAW_API_KEY by itself", async (t) => {
  const config = await mkdtemp(join(tmpdir(), "excalidraw-cli-config-"));
  t.after(() => rm(config, { recursive: true, force: true }));
  const file = join(config, "excalidraw-cli", "credentials.json");

  await withApi(async ({ origin }) => {
    await assert.rejects(
      () => runCli(["login", "--api-key", "wrong-key"], { origin, env: { XDG_CONFIG_HOME: config } }),
      (error: unknown) => {
        assertExecError(error);
        assert.equal(error.code, 1);
        assert.match(error.stderr, /The API rejected the key \(HTTP 401: Unauthorized\), so it was not saved\./);
        return true;
      },
    );

    // Without a terminal, login can't ask, and the variable isn't an answer.
    await assert.rejects(
      () => runCli(["login"], { origin, env: { XDG_CONFIG_HOME: config } }),
      (error: unknown) => {
        assertExecError(error);
        assert.match(error.stderr, /asks for the key in a terminal\. In scripts, pass it with "excalidraw login --api-key <key>"/);
        return true;
      },
    );
    assert.equal(existsSync(file), false);

    // The saved key works, but the variable still wins, so login and logout say so.
    const login = await runCli(["login", "--api-key", "uk-test-key"], { origin, env: { XDG_CONFIG_HOME: config } });
    assert.match(login.stderr, /EXCALIDRAW_API_KEY is set, so commands use it instead of the saved key/);
    const logout = await runCli(["logout"], { origin, env: { XDG_CONFIG_HOME: config } });
    assert.match(logout.stderr, /EXCALIDRAW_API_KEY is still set/);
  });
});

test("login saves a valid key that can't read the workspace, and says so", async (t) => {
  const config = await mkdtemp(join(tmpdir(), "excalidraw-cli-config-"));
  t.after(() => rm(config, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: config, EXCALIDRAW_API_KEY: "" };

  await withApi(async ({ origin, calls }) => {
    const { stderr } = await runCli(["login", "--api-key", LIMITED_KEY], { origin, env });
    assert.equal(stderr, "Logged in\nSaved the key, but the API refused to show its workspace (HTTP 403: Missing permission).\n");

    await runCli(["scenes", "list"], { origin, env });
    assert.equal(calls.at(-1)?.path, "/api/v1/scenes");
  });
});

test("login replaces a damaged credentials file, and leaves one from a newer CLI alone", async (t) => {
  const config = await mkdtemp(join(tmpdir(), "excalidraw-cli-config-"));
  t.after(() => rm(config, { recursive: true, force: true }));
  const file = join(config, "excalidraw-cli", "credentials.json");
  await mkdir(dirname(file));
  const env = { XDG_CONFIG_HOME: config, EXCALIDRAW_API_KEY: "" };

  await withApi(async ({ origin }) => {
    const rejects = (args: string[], message: RegExp) =>
      assert.rejects(
        () => runCli(args, { origin, env }),
        (error: unknown) => {
          assertExecError(error);
          assert.match(error.stderr, message);
          return true;
        },
      );
    const invalid = new RegExp(`Can't read the saved credentials in ${escapeRegExp(file)}\\. Run "excalidraw login" again\\.`);

    await writeFile(file, "{ truncated");
    await rejects(["scenes", "list"], invalid);
    // An explicit key doesn't need the file.
    await runCli(["scenes", "list"], { origin, env: { ...env, EXCALIDRAW_API_KEY: "test-key" } });

    await writeFile(file, JSON.stringify({ [origin]: { type: "api-key", apiKey: "test-key" } }));
    await rejects(["scenes", "list"], invalid);
    await runCli(["login", "--api-key", "test-key"], { origin, env });
    await runCli(["scenes", "list"], { origin, env });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 1, origins: { [origin]: { type: "api-key", apiKey: "test-key" } } });

    // A newer CLI may have changed the layout, so the file is left alone.
    const newer = JSON.stringify({ version: 2, accounts: [] });
    await writeFile(file, newer);
    await rejects(["scenes", "list"], /was saved by a newer version of the excalidraw CLI\. Upgrade the CLI to use it\./);
    await rejects(["login", "--api-key", "test-key"], /was saved by a newer version/);
    await rejects(["logout"], /was saved by a newer version/);
    assert.equal(await readFile(file, "utf8"), newer);

    // A credential type a newer CLI added: login replaces it, and other fields survive the rewrite.
    await writeFile(file, JSON.stringify({ version: 1, origins: { [origin]: { type: "oauth", token: "x" } }, defaults: { a: 1 } }));
    await rejects(["scenes", "list"], new RegExp(`Can't use the credentials saved for ${escapeRegExp(origin)} in .*If a newer version of the CLI saved them, upgrade it`));
    await runCli(["login", "--api-key", "test-key"], { origin, env });
    await runCli(["scenes", "list"], { origin, env });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      version: 1,
      origins: { [origin]: { type: "api-key", apiKey: "test-key" } },
      defaults: { a: 1 },
    });
  });
});

test("--restricted-domains sends an array on create-link and null for none on update", async () => {
  await withApi(async ({ origin, calls }) => {
    const created = JSON.parse(
      (await runCli(["workspace", "invites", "create-link", "--role", "member", "--restricted-domains", "example.com, example.org"], { origin })).stdout,
    );
    assert.deepEqual(created.restrictedDomains, ["example.com", "example.org"]);
    assert.deepEqual(calls[0].body, { role: "member", maxUses: 1, restrictedDomains: ["example.com", "example.org"] });

    await runCli(["workspace", "invites", "update", "inv_1", "--restricted-domains", "none"], { origin });
    assert.deepEqual(calls[1].body, { restrictedDomains: null });

    await assert.rejects(
      () => runCli(["workspace", "invites", "create-link", "--role", "member", "--restricted-domains", " , "], { origin }),
      (error: unknown) => {
        assertExecError(error);
        assert.match(error.stderr, /Provide at least one domain/);
        return true;
      },
    );
  });
});

test("429 responses are retried with a notice on stderr", async () => {
  await withApi(async ({ origin, calls }) => {
    const { stdout, stderr } = await runCli(["collections", "list"], { origin });

    assert.equal(JSON.parse(stdout).data[0].id, "col_1");
    assert.equal(calls.filter((call) => call.path === "/api/v1/collections").length, 3);
    assert.match(stderr, /HTTP 429; retrying in .*attempt 1 of 3/);
    assert.match(stderr, /attempt 2 of 3/);
  });
});

test("--retries 0 surfaces the 429 immediately", async () => {
  await withApi(async ({ origin, calls }) => {
    await assert.rejects(
      () => runCli(["collections", "list", "--retries", "0"], { origin }),
      (error: unknown) => {
        assertExecError(error);
        assert.match(error.stderr, /HTTP 429: Rate limit exceeded/);
        return true;
      },
    );
    assert.equal(calls.length, 1);
  });
});

test("--retries rejects values outside 0-10", async () => {
  await withApi(async ({ origin }) => {
    await assert.rejects(
      () => runCli(["collections", "list", "--retries", "50"], { origin }),
      (error: unknown) => {
        assertExecError(error);
        assert.match(error.stderr, /Invalid retry count/);
        return true;
      },
    );
  });
});

test("a GET whose response is cut off after the headers is retried", async () => {
  await withApi(async ({ origin, calls }) => {
    const { stdout, stderr } = await runCli(["scenes", "get", "cut_off", "--retries", "1"], { origin });

    assert.equal(JSON.parse(stdout).metadata.id, "cut_off");
    assert.equal(calls.length, 2);
    assert.match(stderr, /Response from \S+ was interrupted; retrying in .*attempt 1 of 1/);
  });
});

test("--request-timeout bounds the headers and the body of every attempt", async () => {
  await withApi(async ({ origin, calls }) => {
    const cases: [string, RegExp, RegExp][] = [
      ["stalled_headers", /Request to \S+ timed out; retrying/, /The request to \S+ timed out after 200 ms\. Use --request-timeout/],
      ["stalled_body", /Response from \S+ timed out; retrying/, /The response from \S+ \(HTTP 200\) timed out after 200 ms\. Use --request-timeout/],
    ];

    for (const [id, notice, message] of cases) {
      await assert.rejects(
        () => runCli(["scenes", "get", id, "--retries", "1", "--request-timeout", "200"], { origin }),
        (error: unknown) => {
          assertExecError(error);
          assert.equal(error.code, 1);
          assert.match(error.stderr, notice);
          assert.match(error.stderr, message);
          return true;
        },
      );
    }
    assert.deepEqual(calls.map((call) => call.path), [
      "/api/v1/scenes/stalled_headers",
      "/api/v1/scenes/stalled_headers",
      "/api/v1/scenes/stalled_body",
      "/api/v1/scenes/stalled_body",
    ]);

    await assert.rejects(
      () => runCli(["scenes", "get", "scene_1", "--request-timeout", "0"], { origin }),
      (error: unknown) => {
        assertExecError(error);
        assert.match(error.stderr, /Invalid request timeout/);
        return true;
      },
    );
    assert.equal(calls.length, 4);
  });
});

test("a write whose response is cut off is not repeated", async () => {
  await withApi(async ({ origin, calls }) => {
    await assert.rejects(
      () => runCli(["scenes", "update", "cut_off", "--name", "Renamed"], { origin }),
      (error: unknown) => {
        assertExecError(error);
        assert.equal(error.code, 1);
        assert.match(
          error.stderr,
          /The response from \S+ \(HTTP 200\) was interrupted: .+\. The PATCH request may have been applied; check before repeating it\./,
        );
        assert.doesNotMatch(error.stderr, /retrying/);
        return true;
      },
    );
    assert.equal(calls.length, 1);
  });
});

test("long error bodies are cut short unless --raw is set", async () => {
  await withApi(async ({ origin }) => {
    const stderr = async (args: string[]) => {
      try {
        await runCli(args, { origin });
      } catch (error) {
        assertExecError(error);
        return error.stderr;
      }
      assert.fail("the command should fail");
    };

    const short = await stderr(["scenes", "get", "html_error"]);
    assert.match(short, /^HTTP 400: Bad Request$/m);
    assert.match(short, /… \(\d+ more characters; use --raw to print the whole response\)/);
    assert.ok(short.length < 700, `stderr has ${short.length} characters`);

    assert.ok((await stderr(["scenes", "get", "html_error", "--raw"])).includes(LONG_ERROR_PAGE));
  });
});

test("a pasted /api/v1 suffix on --api-url is not doubled", async () => {
  await withApi(async ({ origin, calls }) => {
    const { stdout } = await runCli(["scenes", "list", "--limit", "1"], { origin: `${origin}/api/v1/` });

    assert.equal(calls[0].path, "/api/v1/scenes");
    assert.equal(JSON.parse(stdout).data.length, 1);
  });
});

test("stdout write failures print a readable error and exit 1", { skip: !existsSync("/dev/full") && "needs /dev/full" }, async () => {
  await withApi(async ({ origin }) => {
    const full = await open("/dev/full", "w");
    try {
      const { code, stderr } = await runWithStdout([cliPath, "--api-url", origin, "scenes", "list"], full.fd, {
        env: apiEnv(),
      });
      assert.equal(code, 1);
      assert.equal(stderr, "Could not write to stdout: ENOSPC: no space left on device, write\n");
    } finally {
      await full.close();
    }
  });
});

test("a reader that closes stdout early ends the command quietly with exit 0", async () => {
  await withApi(async ({ origin }) => {
    const { code, stderr } = await runWithStdout([cliPath, "--api-url", origin, "scenes", "list", "--all"], "closed", {
      env: apiEnv(),
    });
    assert.equal(code, 0);
    assert.equal(stderr, "");
  });
});

test("--raw prints the response text verbatim and --all still combines pages", async () => {
  await withApi(async ({ origin }) => {
    const { stdout } = await runCli(["scenes", "list", "--limit", "2", "--raw"], { origin });
    assert.equal(stdout, JSON.stringify({ limit: 2, offset: 0, hasNextPage: true, data: scenes.slice(0, 2) }) + "\n");

    const combined = await runCli(["scenes", "list", "--all", "--limit", "3", "--raw"], { origin });
    const result = JSON.parse(combined.stdout);
    assert.equal(result.count, SCENE_COUNT);
    assert.equal(result.hasNextPage, undefined);
  });
});

test("create-link sends an explicit single use unless --max-uses is given", async () => {
  await withApi(async ({ origin, calls }) => {
    await runCli(["workspace", "invites", "create-link", "--role", "member"], { origin });
    await runCli(["workspace", "invites", "create-link", "--role", "member", "--max-uses", "unlimited"], { origin });

    assert.deepEqual(calls.map((call) => call.body), [
      { role: "member", maxUses: 1 },
      { role: "member", maxUses: "unlimited" },
    ]);
  });
});

test("invite table shows usage only for invites with a limit", async () => {
  await withApi(async ({ origin }) => {
    const { stdout } = await runCli(["workspace", "invites", "list", "-o", "table"], { origin });

    assert.match(stdout, /^inv_1\s+link\s+-\s+member\s+pending\s+2\/unlimited\s+-$/m);
    assert.match(stdout, /^inv_2\s+email\s+ada@example\.com\s+admin\s+pending\s+-\s+-$/m);
  });
});

test("text from the API can't send control sequences to the terminal", async () => {
  await withApi(async ({ origin }) => {
    const table = await runCli(["workspace", "users", "list", "-o", "table"], { origin });
    assert.doesNotMatch(table.stdout, CONTROL_CHARACTERS);
    assert.match(table.stdout, /^user_1\s+Spoofed name\s+ada@example\.com/m);

    const json = await runCli(["workspace", "users", "list"], { origin });
    assert.doesNotMatch(json.stdout, CONTROL_CHARACTERS);
    assert.equal(JSON.parse(json.stdout).data[0].name, HOSTILE_NAME, "JSON escapes the name but keeps its value");

    // Without colors, any escape sequence on stderr would have come from the API.
    await assert.rejects(
      () => runCli(["workspace", "users", "get", "user_1"], { origin, env: { FORCE_COLOR: "0" } }),
      (error: unknown) => {
        assertExecError(error);
        assert.doesNotMatch(error.stderr, CONTROL_CHARACTERS);
        assert.match(error.stderr, /^HTTP 400: Spoofed name$/m);
        return true;
      },
    );
  });
});

test("table columns line up with CJK and emoji names, and cutting a name keeps characters whole", async () => {
  await withApi(async ({ origin }) => {
    const { stdout } = await runCli(["collections", "scenes", "list", "wide", "-o", "table"], { origin });

    // The long names are cut to 46 columns plus "…", which sets the column to 47.
    assert.match(stdout, /^s1  Ada {46}c /m);
    assert.match(stdout, /^s2  山田太郎 {41}c /m);
    assert.match(stdout, /^s3  (?:あ){23}… {2}c /m);
    assert.match(stdout, /^s4  (?:😀){23}… {2}c /m);
    assert.ok(!stdout.includes("�"), "no emoji is cut in half");
  });
});

test("table output handles very long lists", async () => {
  await withApi(async ({ origin }) => {
    const { stdout } = await runCli(["collections", "scenes", "list", "huge", "-o", "table"], { origin });
    const lines = stdout.trimEnd().split("\n");
    assert.equal(lines.length, HUGE_LIST + 1);
    assert.match(lines.at(-1)!, new RegExp(`^s${HUGE_LIST - 1}\\s+n`));
  });
});

test("IDs stay inside their path segment", async () => {
  await withApi(async ({ origin, calls }) => {
    await assert.rejects(() => runCli(["scenes", "delete", "../collections/col_1"], { origin }));
    assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ["DELETE /api/v1/scenes/..%2Fcollections%2Fcol_1"]);

    for (const id of ["..", ".", ""]) {
      await assert.rejects(
        () => runCli(["scenes", "content", "get", id], { origin }),
        (error: unknown) => {
          assertExecError(error);
          assert.match(error.stderr, /Invalid ID/);
          return true;
        },
      );
    }
    assert.equal(calls.length, 1, "rejected IDs must not reach the API");
  });
});

test("logs pagination flags are validated before any request", async () => {
  await withApi(async ({ origin, calls }) => {
    const cases: [string[], RegExp][] = [
      [["--offset", "10"], /unknown option '--offset'/],
      [["--page", "two"], /page/],
      [["--page", "0"], /page/],
      [["--page", "2", "--cursor", "abc"], /either --cursor or --page/],
    ];

    for (const [args, message] of cases) {
      await assert.rejects(
        () => runCli(["logs", "list", ...args], { origin }),
        (error: unknown) => {
          assertExecError(error);
          assert.match(error.stderr, message);
          return true;
        },
      );
    }
    assert.equal(calls.length, 0);

    await runCli(["logs", "list", "--page", "2"], { origin });
    assert.equal(calls[0].query.page, "2");
  });
});

test("--picture none clears the picture", async () => {
  await withApi(async ({ origin, calls }) => {
    await runCli(["workspace", "update", "--picture", "none"], { origin });
    await runCli(["workspace", "update", "--picture", "https://example.com/logo.png"], { origin });

    assert.deepEqual(calls.map((call) => call.body), [{ picture: null }, { picture: "https://example.com/logo.png" }]);
  });
});
