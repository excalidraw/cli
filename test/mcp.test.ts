import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { assertExecError, cliEnv } from "./helpers.ts";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

type McpCall = {
  headers: IncomingHttpHeaders;
  method: string;
  params: Record<string, unknown>;
};

/** A 1x1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const INSTRUCTIONS = "Draw with the tools.\nVerify every write.";

const tools = [
  {
    name: "list_scenes",
    description: "List scenes in the workspace, e.g. the latest ones. Pass limit to bound the result.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
    outputSchema: { type: "object" },
  },
  {
    name: "create_scene",
    description: "Create an empty scene.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  // No hints: a client must assume it may change existing content.
  { name: "delete_scene", description: "Delete scene by ID", inputSchema: { type: "object" } },
  {
    name: "get_scene_card",
    description: "Only the server's own views call this.",
    inputSchema: { type: "object" },
    _meta: { ui: { visibility: ["app"] } },
  },
];

/** A stand-in for the MCP endpoint: stateless, answering each JSON-RPC request with JSON or an event stream. */
async function withMcp(fn: (context: { origin: string; calls: McpCall[] }) => Promise<void>) {
  const calls: McpCall[] = [];
  let gatewayErrors = 0;

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (req.url !== "/api/v1/mcp" || req.method !== "POST") {
      return send(404, { message: "Not Found" });
    }
    if (req.headers.authorization !== "Bearer test-key") {
      return send(401, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Api Key" } });
    }

    const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push({ headers: req.headers, method, params });
    const result = (value: unknown) => send(200, { jsonrpc: "2.0", id, result: value });
    const json = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });

    if (method === "initialize") {
      return result({
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "excalidraw-api", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }

    if (method === "tools/list") {
      // Two pages, and a gateway error before the first one.
      if (gatewayErrors++ === 0) {
        return send(502, { message: "Bad Gateway" });
      }
      return result(params.cursor === "page-2" ? { tools: tools.slice(2) } : { tools: tools.slice(0, 2), nextCursor: "page-2" });
    }

    if (method === "tools/call") {
      const args = params.arguments;
      switch (params.name) {
        case "list_scenes":
          return result(json({ limit: args.limit ?? 5, data: [{ id: "scene_1" }] }));
        case "read_guide":
          return result({ content: [{ type: "text", text: "# Guide\nUse labels." }] });
        case "take_screenshot":
          return result({
            content: [
              { type: "text", text: JSON.stringify({ sceneId: args.sceneId, width: 1 }) },
              { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
              { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
            ],
            structuredContent: { sceneId: args.sceneId, width: 1 },
          });
        case "create_diagram":
          // A write that succeeded, and whose screenshot failed: the result, then a warning.
          return result({
            content: [
              { type: "text", text: JSON.stringify({ url: "https://example.com/s/scene_new", sceneId: "scene_new" }) },
              { type: "text", text: JSON.stringify({ screenshotError: "No screenshot: the renderer is busy. The write itself succeeded." }) },
            ],
            structuredContent: { sceneId: "scene_new", url: "https://example.com/s/scene_new" },
          });
        case "get_scene":
          return result({ content: [{ type: "text", text: JSON.stringify({ error: "Scene not found" }) }], isError: true });
        case "streamed":
          // What a server that streams sends: a notification, then the answer.
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(
            [
              `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`,
              `event: message\nid: 1\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: json({ streamed: true }) })}\n\n`,
            ].join(""),
          );
          return;
        case "gateway_error":
          return send(502, { message: "Bad Gateway" });
        default:
          return send(200, { jsonrpc: "2.0", id, error: { code: -32602, message: `MCP error -32602: Tool ${params.name} not found` } });
      }
    }

    send(200, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await fn({ origin: `http://127.0.0.1:${address.port}`, calls });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function runCli(args: string[], origin: string, { env = {}, input }: { env?: NodeJS.ProcessEnv; input?: string } = {}) {
  const child = execFileAsync(process.execPath, [cliPath, "--api-url", origin, ...args], {
    env: cliEnv({ EXCALIDRAW_API_KEY: "test-key", ...env }),
    maxBuffer: 1024 * 1024 * 10,
  });
  if (input !== undefined) {
    assert.ok(child.child.stdin);
    child.child.stdin.end(input);
  }
  return child;
}

async function assertFails(run: Promise<unknown>, stderr: RegExp) {
  await assert.rejects(run, (error: unknown) => {
    assertExecError(error);
    assert.equal(error.code, 1);
    assert.match(error.stderr, stderr);
    assert.equal(error.stdout, "");
    return true;
  });
}

test("mcp tools lists every page in short form, without the tools only the server's views call", async () => {
  await withMcp(async ({ origin, calls }) => {
    const { stdout, stderr } = await runCli(["mcp", "tools"], origin);

    assert.deepEqual(JSON.parse(stdout), {
      count: 3,
      tools: [
        { name: "list_scenes", summary: "List scenes in the workspace, e.g. the latest ones.", readOnly: true, destructive: false },
        { name: "create_scene", summary: "Create an empty scene.", readOnly: false, destructive: false },
        { name: "delete_scene", summary: "Delete scene by ID", readOnly: false, destructive: true },
      ],
    });
    // Listing is a read, so the gateway error before the first page is retried.
    assert.match(stderr, /HTTP 502; retrying/);
    assert.deepEqual(
      calls.map((call) => [call.method, call.params.cursor]),
      [["tools/list", undefined], ["tools/list", undefined], ["tools/list", "page-2"]],
    );

    const [call] = calls;
    assert.ok(call);
    assert.equal(call.headers.accept, "application/json, text/event-stream");
    assert.equal(call.headers["mcp-protocol-version"], "2025-06-18");
    assert.match(call.headers["user-agent"] ?? "", /^excalidraw-cli\//);
  });
});

test("mcp tools prints a table, and --raw the definitions as sent", async () => {
  await withMcp(async ({ origin }) => {
    const table = await runCli(["mcp", "tools", "--output", "table"], origin);
    assert.match(table.stdout, /^TOOL\s+ACCESS\s+SUMMARY$/m);
    assert.match(table.stdout, /^list_scenes\s+read\s+List scenes/m);
    assert.match(table.stdout, /^create_scene\s+add\s+Create an empty scene\.$/m);
    assert.match(table.stdout, /^delete_scene\s+write\s+Delete scene by ID$/m);

    const raw = await runCli(["mcp", "tools", "--raw"], origin);
    assert.deepEqual(JSON.parse(raw.stdout), { tools });
  });
});

test("mcp schema prints a tool's description and arguments, and several tools as a list", async () => {
  await withMcp(async ({ origin }) => {
    const one = await runCli(["mcp", "schema", "create_scene"], origin);
    assert.deepEqual(JSON.parse(one.stdout), {
      name: "create_scene",
      description: "Create an empty scene.",
      readOnly: false,
      destructive: false,
      inputSchema: tools[1]!.inputSchema,
    });

    const two = await runCli(["mcp", "schema", "list_scenes", "delete_scene"], origin);
    assert.deepEqual(JSON.parse(two.stdout).map((tool: { name: string }) => tool.name), ["list_scenes", "delete_scene"]);
    assert.equal(JSON.parse(two.stdout)[0].outputSchema, undefined);

    const raw = await runCli(["mcp", "schema", "list_scenes", "--raw"], origin);
    assert.deepEqual(JSON.parse(raw.stdout), tools[0]);

    await assertFails(runCli(["mcp", "schema", "nope"], origin), /No tool named "nope"\. Run "excalidraw mcp tools" for the list\./);
  });
});

test("mcp instructions prints the server's instructions as text", async () => {
  await withMcp(async ({ origin, calls }) => {
    const { stdout } = await runCli(["mcp", "instructions"], origin);
    assert.equal(stdout, `${INSTRUCTIONS}\n`);

    const [call] = calls;
    assert.ok(call);
    assert.equal(call.method, "initialize");
    assert.equal(call.params.protocolVersion, "2025-06-18");
    assert.equal((call.params.clientInfo as { name: string }).name, "excalidraw-cli");
    // The version is agreed on by this request, so no header announces one yet.
    assert.equal(call.headers["mcp-protocol-version"], undefined);

    const raw = await runCli(["mcp", "instructions", "--raw"], origin);
    assert.equal(JSON.parse(raw.stdout).serverInfo.name, "excalidraw-api");
  });
});

test("mcp call sends the arguments from --args, a file or stdin, and prints the result once", async () => {
  await withMcp(async ({ origin, calls }) => {
    const none = await runCli(["mcp", "call", "list_scenes"], origin);
    assert.deepEqual(JSON.parse(none.stdout), { limit: 5, data: [{ id: "scene_1" }] });
    assert.deepEqual(calls.at(-1)?.params, { name: "list_scenes", arguments: {} });

    const flag = await runCli(["mcp", "call", "list_scenes", "--args", '{"limit":2}'], origin);
    assert.equal(JSON.parse(flag.stdout).limit, 2);

    const stdin = await runCli(["mcp", "call", "list_scenes", "--args-file", "-"], origin, { input: '﻿{"limit":3}' });
    assert.equal(JSON.parse(stdin.stdout).limit, 3);
    assert.equal(calls.at(-1)?.method, "tools/call");
  });
});

test("mcp call prints text results as text, and reads an answer sent as an event stream", async () => {
  await withMcp(async ({ origin }) => {
    const guide = await runCli(["mcp", "call", "read_guide"], origin);
    assert.equal(guide.stdout, "# Guide\nUse labels.\n");

    const streamed = await runCli(["mcp", "call", "streamed"], origin);
    assert.deepEqual(JSON.parse(streamed.stdout), { streamed: true });
  });
});

test("mcp call saves images to --out, to a temporary file without it, and to stdout for -", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-cli-mcp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const args = ["mcp", "call", "take_screenshot", "--args", '{"sceneId":"scene_1"}'];

  await withMcp(async ({ origin }) => {
    const out = join(directory, "nested", "shot.png");
    const saved = await runCli([...args, "--out", out], origin);
    assert.deepEqual(JSON.parse(saved.stdout), { sceneId: "scene_1", width: 1 });
    assert.deepEqual(await readFile(out), PNG);
    // A second image gets a numbered name next to the first.
    assert.deepEqual(await readFile(join(directory, "nested", "shot-2.png")), PNG);
    assert.ok(saved.stderr.includes(`Saved the image to ${out}`));

    // TMPDIR is where os.tmpdir() looks on POSIX; Windows reads TEMP.
    const temporary = await runCli(args, origin, { env: { TMPDIR: directory, TEMP: directory, TMP: directory } });
    assert.deepEqual(JSON.parse(temporary.stdout), { sceneId: "scene_1", width: 1 });
    // A directory of the call's own, which other users of the computer can't open.
    const [own, ...others] = (await readdir(directory)).filter((name) => name.startsWith("excalidraw-cli-"));
    assert.ok(own);
    assert.deepEqual(others, []);
    assert.deepEqual((await readdir(join(directory, own))).sort(), ["take_screenshot-2.png", "take_screenshot.png"]);
    assert.ok(temporary.stderr.includes(`Saved the image to ${join(directory, own, "take_screenshot.png")}`));
    if (process.platform !== "win32") {
      assert.equal((await stat(join(directory, own))).mode & 0o777, 0o700);
      assert.equal((await stat(join(directory, own, "take_screenshot.png"))).mode & 0o777, 0o600);
    }
    // Calls at the same moment don't share a directory, so they can't overwrite each other.
    await Promise.all([1, 2].map(() => runCli(args, origin, { env: { TMPDIR: directory, TEMP: directory, TMP: directory } })));
    assert.equal((await readdir(directory)).filter((name) => name.startsWith("excalidraw-cli-")).length, 3);

    const piped = await execFileAsync(process.execPath, [cliPath, "--api-url", origin, ...args, "--out", "-"], {
      env: cliEnv({ EXCALIDRAW_API_KEY: "test-key" }),
      encoding: "buffer",
    });
    assert.deepEqual(piped.stdout, PNG);
    // stdout is the image's, so the result is on stderr.
    assert.ok(piped.stderr.toString().includes('{"sceneId":"scene_1","width":1}'));

    const raw = await runCli([...args, "--raw"], origin, { env: { TMPDIR: join(directory, "unused") } });
    assert.equal(JSON.parse(raw.stdout).content[1].data, PNG.toString("base64"));
    assert.equal(raw.stderr, "");

    await assertFails(runCli(["mcp", "call", "list_scenes", "--out", "-"], origin), /ran, but returned no image to write to stdout/);
    const none = await runCli(["mcp", "call", "list_scenes", "--out", join(directory, "none.png")], origin);
    assert.match(none.stderr, /returned no image, so nothing was saved/);
  });
});

test("mcp call keeps a write's result and its warning when the screenshot fails", async () => {
  await withMcp(async ({ origin }) => {
    const args = ["mcp", "call", "create_diagram", "--args", '{"newScene":{"name":"Flow","collectionId":"private"},"screenshot":true}'];
    const warning = /screenshotError: No screenshot: the renderer is busy\. The write itself succeeded\./;

    const written = await runCli(args, origin);
    assert.deepEqual(JSON.parse(written.stdout), { sceneId: "scene_new", url: "https://example.com/s/scene_new" });
    assert.match(written.stderr, warning);

    // Asked for the image alone: the command fails, and still says which scene was created.
    await assert.rejects(runCli([...args, "--out", "-"], origin), (error: unknown) => {
      assertExecError(error);
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.ok(error.stderr.includes('"sceneId":"scene_new"'));
      assert.match(error.stderr, warning);
      assert.match(error.stderr, /ran, but returned no image to write to stdout/);
      return true;
    });
  });
});

test("mcp call exits 1 with the tool's message when the tool or the request fails", async () => {
  await withMcp(async ({ origin, calls }) => {
    await assertFails(runCli(["mcp", "call", "get_scene", "--args", '{"sceneId":"x"}'], origin), /^Scene not found$/m);
    await assertFails(
      runCli(["mcp", "call", "nope"], origin),
      /MCP error -32602: Tool nope not found\. Run "excalidraw mcp tools" for the list\./,
    );
    await assertFails(runCli(["mcp", "call", "list_scenes"], origin, { env: { EXCALIDRAW_API_KEY: "wrong" } }), /HTTP 401: Invalid Api Key/);

    // A tool call may have written, so a gateway error is not retried.
    const before = calls.length;
    await assertFails(runCli(["mcp", "call", "gateway_error"], origin), /HTTP 502/);
    assert.equal(calls.length, before + 1);

    // --raw still prints the failed result, and still exits 1.
    await assert.rejects(runCli(["mcp", "call", "get_scene", "--raw"], origin), (error: unknown) => {
      assertExecError(error);
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).isError, true);
      return true;
    });
  });
});

test("mcp call rejects arguments that are not one JSON object", async () => {
  await withMcp(async ({ origin, calls }) => {
    await assertFails(runCli(["mcp", "call", "list_scenes", "--args", "[1]"], origin), /must be a JSON object/);
    await assertFails(runCli(["mcp", "call", "list_scenes", "--args", "{bad"], origin), /Failed to parse --args as JSON: .*use --args-file/);
    await assertFails(
      runCli(["mcp", "call", "list_scenes", "--args", "{}", "--args-file", "args.json"], origin),
      /Pass --args or --args-file, not both\./,
    );
    assert.equal(calls.length, 0);
  });
});
