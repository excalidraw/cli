import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import test from "node:test";
import { assertExecError, cliEnv } from "./helpers.ts";

const execFileAsync = promisify(execFile);
const dist = fileURLToPath(new URL("../dist", import.meta.url));

// Fake installs rely on symlinks and shell scripts standing in for the package managers.
const POSIX_ONLY = { skip: process.platform === "win32" && "needs a POSIX shell" };
const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun", "volta"];

type Registry = { origin: string; registryRequests: () => number; close: () => Promise<void> };

/**
 * Serves the dist-tags the update check asks for, and a workspace for whoami. The workspace answers
 * shortly after the registry did, so a command lasts long enough for its update check to finish.
 */
async function startRegistry(latest: string): Promise<Registry> {
  let registryRequests = 0;
  let registryServed: () => void;
  const served = new Promise<void>((resolve) => (registryServed = resolve));

  const server = createServer(async (req, res) => {
    if (req.url === "/-/package/@excalidraw%2fcli/dist-tags") {
      registryRequests++;
      res.on("finish", () => registryServed());
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ latest, next: "100.0.0-beta.1" }));
      return;
    }
    if (req.url === "/api/v1/workspaces") {
      // Runs without an update check wait out the deadline instead.
      await Promise.race([served.then(() => sleep(200)), sleep(1500)]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "ws_1", name: "Acme", subscriptionStatus: "active" }));
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    registryRequests: () => registryRequests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Copies the built CLI into `packageDirectory` as if a package manager had installed `version` there. */
async function install(packageDirectory: string, version: string) {
  await cp(dist, join(packageDirectory, "dist"), { recursive: true });
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ name: "@excalidraw/cli", version }));
  return join(packageDirectory, "dist", "main.js");
}

/** An npm global prefix: the package in lib/node_modules, the command linked from bin. */
async function installWithNpm(prefix: string, version: string) {
  await install(join(prefix, "lib", "node_modules", "@excalidraw", "cli"), version);
  const bin = join(prefix, "bin", "excalidraw");
  await mkdir(dirname(bin), { recursive: true });
  await symlink("../lib/node_modules/@excalidraw/cli/dist/main.js", bin);
  return bin;
}

/** Package managers on PATH that record how they were called, and fail if FAKE_EXIT_CODE says so. */
async function fakePackageManagers(directory: string) {
  const bin = join(directory, "fake-bin");
  const log = join(directory, "calls.log");
  await mkdir(bin, { recursive: true });
  for (const name of PACKAGE_MANAGERS) {
    const script = join(bin, name);
    await writeFile(script, `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit "\${FAKE_EXIT_CODE:-0}"\n`);
    await chmod(script, 0o755);
  }
  return {
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    calls: async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n") : []),
  };
}

async function withTemporaryDirectory(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-cli-update-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("update --check compares the installed version with the latest tag", POSIX_ONLY, async (t) => {
  const directory = await withTemporaryDirectory(t);
  const cases: [installed: string, latest: string, updateAvailable: boolean][] = [
    ["1.0.0", "1.0.1", true],
    ["1.9.0", "1.10.0", true],
    ["1.0.0", "1.0.0", false],
    ["2.0.0", "1.9.9", false],
    ["1.0.0-beta.2", "1.0.0", true],
    ["1.1.0-beta.1", "1.0.0", false],
  ];

  for (const [index, [installed, latest, updateAvailable]] of cases.entries()) {
    const main = await install(join(directory, String(index)), installed);
    const registry = await startRegistry(latest);
    try {
      const { stdout } = await execFileAsync(process.execPath, [main, "update", "--check"], {
        env: cliEnv({ npm_config_registry: registry.origin }),
      });
      assert.deepEqual(JSON.parse(stdout), { currentVersion: installed, latestVersion: latest, updateAvailable });
    } finally {
      await registry.close();
    }
  }
});

test("update installs the latest version with the package manager that installed the CLI", POSIX_ONLY, async (t) => {
  const directory = await withTemporaryDirectory(t);
  const registry = await startRegistry("2.0.0");
  t.after(() => registry.close());

  const installs: [manager: string, main: string, expected: string][] = [
    ["npm", await installWithNpm(join(directory, "npm"), "1.0.0"), "npm install -g @excalidraw/cli@2.0.0"],
    [
      "pnpm",
      await install(join(directory, "pnpm", "global", "v11", "a1b2", "node_modules", "@excalidraw", "cli"), "1.0.0"),
      "pnpm add -g @excalidraw/cli@2.0.0",
    ],
    [
      "yarn",
      await install(join(directory, "yarn", "global", "node_modules", "@excalidraw", "cli"), "1.0.0"),
      "yarn global add @excalidraw/cli@2.0.0",
    ],
    [
      "bun",
      await install(join(directory, ".bun", "install", "global", "node_modules", "@excalidraw", "cli"), "1.0.0"),
      "bun add -g @excalidraw/cli@2.0.0",
    ],
  ];

  for (const [manager, main, expected] of installs) {
    const fake = await fakePackageManagers(join(directory, `${manager}-calls`));
    const { stdout, stderr } = await execFileAsync(process.execPath, [main, "update"], {
      env: cliEnv({ npm_config_registry: registry.origin, PATH: fake.PATH }),
    });

    assert.deepEqual(await fake.calls(), [expected], manager);
    assert.deepEqual(JSON.parse(stdout), { currentVersion: "1.0.0", latestVersion: "2.0.0", updated: true, command: expected });
    assert.match(stripVTControlCharacters(stderr), new RegExp(`Updating excalidraw 1\\.0\\.0 → 2\\.0\\.0: ${expected}`));
  }

  // A failed install is an error, and an installed latest version is left alone.
  const fake = await fakePackageManagers(join(directory, "failing-calls"));
  const npmBin = installs[0][1];
  await assert.rejects(
    () => execFileAsync(process.execPath, [npmBin, "update"], {
      env: cliEnv({ npm_config_registry: registry.origin, PATH: fake.PATH, FAKE_EXIT_CODE: "3" }),
    }),
    (error: unknown) => {
      assertExecError(error);
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /"npm install -g @excalidraw\/cli@2\.0\.0" exited with code 3\. Its output above says why\./);
      return true;
    },
  );

  const current = await installWithNpm(join(directory, "current"), "2.0.0");
  const { stdout } = await execFileAsync(process.execPath, [current, "update"], {
    env: cliEnv({ npm_config_registry: registry.origin, PATH: fake.PATH }),
  });
  assert.deepEqual(JSON.parse(stdout), { currentVersion: "2.0.0", latestVersion: "2.0.0", updated: false, command: null });
  assert.equal((await fake.calls()).length, 1, "only the failed install ran");
});

test("update explains what to do for npx and project installs instead of installing", POSIX_ONLY, async (t) => {
  const directory = await withTemporaryDirectory(t);
  const registry = await startRegistry("2.0.0");
  t.after(() => registry.close());
  const fake = await fakePackageManagers(directory);

  const cases: [main: string, message: RegExp][] = [
    [
      await install(join(directory, "npm-cache", "_npx", "f00d", "node_modules", "@excalidraw", "cli"), "1.0.0"),
      /started by npx, which can reuse a version it downloaded before\. Run "npx @excalidraw\/cli@latest" to use 2\.0\.0\./,
    ],
    [
      await install(join(directory, "project", "node_modules", "@excalidraw", "cli"), "1.0.0"),
      /Could not tell how excalidraw was installed: it runs from .*project\/node_modules\/@excalidraw\/cli\. If it's a project dependency/,
    ],
  ];

  for (const [main, message] of cases) {
    await assert.rejects(
      () => execFileAsync(process.execPath, [main, "update"], { env: cliEnv({ npm_config_registry: registry.origin, PATH: fake.PATH }) }),
      (error: unknown) => {
        assertExecError(error);
        assert.match(error.stderr, message);
        return true;
      },
    );
  }
  assert.deepEqual(await fake.calls(), []);
});

test(
  "commands in a terminal mention a newer version once a day; scripts never check",
  // util-linux's script runs the CLI in a pseudo-terminal, as if a person had typed the command.
  { skip: process.platform !== "linux" && "needs util-linux script" },
  async (t) => {
    const directory = await withTemporaryDirectory(t);
    const registry = await startRegistry("2.0.0");
    t.after(() => registry.close());
    const bin = await installWithNpm(join(directory, "npm"), "1.0.0");
    const cache = join(directory, "cache");
    const env = cliEnv({
      npm_config_registry: registry.origin,
      XDG_CACHE_HOME: cache,
      EXCALIDRAW_API_KEY: "test-key",
      EXCALIDRAW_API_URL: registry.origin,
      // GitHub Actions sets CI, which turns the check off.
      CI: "",
      NO_UPDATE_NOTIFIER: "",
    });
    const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
    const inTerminal = async (extraEnv: NodeJS.ProcessEnv = {}, columns = 100) => {
      const command = `stty cols ${columns}; ${[process.execPath, bin, "whoami"].map(quote).join(" ")}`;
      const { stdout } = await execFileAsync("script", ["--quiet", "--return", "--command", command, "/dev/null"], {
        env: { ...env, ...extraEnv },
      });
      return stripVTControlCharacters(stdout).replaceAll("\r\n", "\n");
    };

    // Piped, like a script or an agent would run it.
    const piped = await execFileAsync(process.execPath, [bin, "whoami"], { env });
    assert.doesNotMatch(piped.stderr, /new version/);
    assert.equal(registry.registryRequests(), 0);

    assert.doesNotMatch(await inTerminal({ EXCALIDRAW_NO_UPDATE_NOTIFIER: "1" }), /new version/);
    assert.equal(registry.registryRequests(), 0);

    const output = await inTerminal();
    assert.match(output, /"name": "Acme"/);
    assert.ok(
      output.endsWith(
        [
          "",
          `╭${"─".repeat(61)}╮`,
          `│${" ".repeat(61)}│`,
          "│   A new version of excalidraw is available: 1.0.0 → 2.0.0   │",
          "│              Run excalidraw update to update.               │",
          `│${" ".repeat(61)}│`,
          `╰${"─".repeat(61)}╯`,
          "",
        ].join("\n"),
      ),
      output,
    );
    assert.equal(registry.registryRequests(), 1);
    const lastCheck = join(cache, "excalidraw-cli", "update-check.json");
    assert.equal(JSON.parse(await readFile(lastCheck, "utf8")).latestVersion, "2.0.0");

    // A terminal too narrow for the box gets the lines without it.
    await rm(lastCheck);
    assert.ok(
      (await inTerminal({}, 50)).endsWith(
        "}\n\nA new version of excalidraw is available: 1.0.0 → 2.0.0\nRun excalidraw update to update.\n",
      ),
    );
    assert.equal(registry.registryRequests(), 2);

    // Checked less than a day ago.
    assert.doesNotMatch(await inTerminal(), /new version/);
    assert.equal(registry.registryRequests(), 2);
  },
);
