import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { assertExecError, cliEnv } from "./helpers.ts";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

test("help output exposes the command tree", async () => {
  const cases = [
    {
      args: ["--help"],
      expected: [
        "whoami",
        "render",
        "scenes",
        "collections",
        "workspace",
        "logs",
        "formatted JSON",
        "-o, --output <format>",
        "--retries <n>",
        "--request-timeout <ms>",
        "--raw",
        "--api-key <key>",
        "--api-url <url>",
      ],
    },
    { args: ["scenes", "--help"], expected: ["list", "get <sceneId>", "create", "update", "delete", "content", "render"] },
    { args: ["render", "--help"], expected: ["--out <file>", "--frame-id <id>", "--browser-path <path>", "No account or API key"] },
    { args: ["scenes", "render", "--help"], expected: ["--out <file>", "--scale <number>", "--max-width <pixels>"] },
    { args: ["scenes", "list", "--help"], expected: ["--all", "--collection-id <id>", "--limit <number>"] },
    { args: ["scenes", "create", "--help"], expected: ["--collection-id <id>", "--file <file>", "--pinned"] },
    { args: ["scenes", "update", "--help"], expected: ["--no-pinned"] },
    { args: ["scenes", "content", "--help"], expected: ["get [options] <sceneId>", "put", "patch"] },
    { args: ["collections", "scenes", "--help"], expected: ["list [options] <collectionId>", "create"] },
    { args: ["workspace", "users", "--help"], expected: ["list", "get <userId>", "update", "remove"] },
    {
      args: ["workspace", "invites", "--help"],
      expected: ["list", "create", "create-link", "update", "delete <inviteId>"],
    },
    {
      args: ["workspace", "invites", "create-link", "--help"],
      expected: ["--max-uses <number|unlimited>", "--restricted-domains <domains>"],
    },
    {
      args: ["workspace", "invites", "update", "--help"],
      expected: ["--restricted-domains <domains>", "--max-uses <number|unlimited>"],
    },
    {
      args: ["logs", "list", "--help"],
      expected: ["--all", "--cursor <cursor>", "--page <page>", "--operation <operation>", "--date-from <date>"],
    },
  ];

  for (const item of cases) {
    const { stdout } = await runCli(item.args);

    for (const expected of item.expected) {
      assert.match(stdout, new RegExp(escapeRegExp(expected)));
    }
  }
});

test("--version prints the package version", async () => {
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const { stdout } = await runCli(["--version"]);

  assert.equal(stdout.trim(), version);
});

test("scenes create requires --collection-id", async () => {
  await assert.rejects(
    () => runCli(["scenes", "create", "--name", "Untitled"]),
    (error: unknown) => {
      assertExecError(error);
      assert.equal(error.code, 1);
      assert.match(error.stderr, /required option '--collection-id <id>' not specified/);
      return true;
    },
  );
});

test("unreachable API origin prints a connection hint and exits 1", async () => {
  await assert.rejects(
    () =>
      runCli(["scenes", "list", "--api-url", "http://127.0.0.1:9/api/v1/", "--retries", "0"], {
        env: { EXCALIDRAW_API_KEY: "test-key" },
      }),
    (error: unknown) => {
      assertExecError(error);
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Could not reach http:\/\/127\.0\.0\.1:9:/);
      assert.match(error.stderr, /--api-url/);
      return true;
    },
  );
});

test("help output uses ANSI colors when forced", async () => {
  const { stdout } = await runCli(["--help"], { env: { FORCE_COLOR: "1" } });

  assert.match(stdout, /\u001b\[/);
});

test("validation failures print readable messages", async () => {
  await assert.rejects(
    () => runCli(["scenes", "update", "scene_123"]),
    (error: unknown) => {
      assertExecError(error);
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Provide at least one of --name, --collection-id, or --pinned\./);
      return true;
    },
  );
});

test("missing API key prints a setup hint", async () => {
  await assert.rejects(
    () =>
      runCli(["scenes", "list"], {
        env: { EXCALIDRAW_API_KEY: "" },
      }),
    (error: unknown) => {
      assertExecError(error);
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Configuration error:/);
      assert.match(error.stderr, /Missing API key/);
      assert.match(error.stderr, /--api-key <key>/);
      assert.doesNotMatch(error.stderr, /expected string, received undefined/);
      return true;
    },
  );
});

async function runCli(args: string[], options: { env?: NodeJS.ProcessEnv } = {}) {
  try {
    return await execFileAsync(process.execPath, [cliPath, ...args], {
      env: cliEnv(options.env),
      maxBuffer: 1024 * 1024 * 10,
    });
  } catch (error) {
    assertExecError(error);
    error.message = `${error.message}\nstdout:\n${error.stdout ?? ""}\nstderr:\n${error.stderr ?? ""}`;
    throw error;
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
