import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { assertExecError, cliEnv } from "./helpers.ts";
import { renderFixture } from "./render-fixture.ts";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

test("render rejects invalid scenes and options without changing the output file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-validation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "scene.excalidraw");
  const out = join(directory, "scene.png");
  await writeFile(out, "keep this file");
  const fixture = renderFixture();
  const cases = [
    { scene: {}, args: [], error: /^elements: /m },
    { scene: { elements: [] }, args: [], error: /empty scene/ },
    { scene: fixture, args: ["--frame-id", "missing"], error: /Frame not found: missing/ },
    { scene: { ...fixture, files: {} }, args: [], error: /missing embedded file data/ },
    {
      // Only files that live images use are reported.
      scene: { ...fixture, filesFailedToEmbed: ["stale", "green"] },
      args: [],
      error: /could not be embedded: green\. Fetch/,
    },
    {
      scene: { ...fixture, files: { green: { dataURL: "https://example.com/image.png" } } },
      args: [],
      error: /External image URLs are not supported/,
    },
    // Option errors name the flag; scene errors (above) keep the scene's own path.
    { scene: fixture, args: ["--max-width", "0"], error: /^--max-width: Too small/m },
    { scene: fixture, args: ["--scale", "NaN"], error: /^--scale: /m },
    {
      scene: fixture,
      args: ["--fonts-url", "https://mirror.example/, ftp://mirror.example/"],
      error: /^--fonts-url: expected http\(s\) URLs separated by commas, or none/m,
    },
    {
      scene: fixture,
      args: ["--browser-path", join(directory, "missing-browser")],
      error: /Browser executable not found/,
    },
  ];
  for (const item of cases) {
    await writeFile(input, JSON.stringify(item.scene));
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "render", input, "--out", out, ...item.args], {
        env: cliEnv({ EXCALIDRAW_BROWSER_PATH: "" }),
      }),
      (error: unknown) => {
        assertExecError(error);
        assert.equal(error.code, 1);
        assert.match(error.stderr, item.error);
        return true;
      },
    );
    assert.equal(await readFile(out, "utf8"), "keep this file");
  }
});

test("browser detection skips a wrapper for a missing snap, and a failed launch suggests --browser-path", { skip: process.platform === "win32" && "uses shell scripts as stand-in browsers" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-browsers-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Searched before microsoft-edge, but like Ubuntu's chromium-browser package it only starts a snap, which isn't installed.
  await writeFile(join(directory, "chromium-browser"), '#!/bin/sh\nexec /snap/bin/excalidraw-test-missing "$@"\n', { mode: 0o755 });
  await writeFile(join(directory, "microsoft-edge"), "#!/bin/sh\necho 'cannot start' >&2\nexit 1\n", { mode: 0o755 });
  const input = join(directory, "scene.excalidraw");
  await writeFile(input, JSON.stringify(renderFixture()));

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "render", input, "--out", join(directory, "scene.png")], {
      env: cliEnv({ PATH: directory, EXCALIDRAW_BROWSER_PATH: "" }),
    }),
    (error: unknown) => {
      assertExecError(error);
      assert.ok(error.stderr.includes(`Could not start the browser at ${join(directory, "microsoft-edge")}`), error.stderr);
      assert.match(error.stderr, /cannot start/, "the browser's own output is kept");
      assert.match(error.stderr, /Pass --browser-path or set EXCALIDRAW_BROWSER_PATH/);
      return true;
    },
  );

  // A binary named like Firefox is driven as Firefox.
  const firefox = join(directory, "firefox");
  await writeFile(firefox, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "render", input, "--out", join(directory, "scene.png"), "--browser-path", firefox], {
      env: cliEnv({ PATH: directory }),
    }),
    (error: unknown) => {
      assertExecError(error);
      assert.ok(error.stderr.includes(`Could not start Firefox at ${firefox}`), error.stderr);
      return true;
    },
  );
});

test("scenes render still requires API authentication", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [cliPath, "scenes", "render", "scene_1", "--out", "unused.png"],
      {
        env: cliEnv(),
      },
    ),
    (error: unknown) => {
      assertExecError(error);
      assert.match(error.stderr, /Missing API key/);
      return true;
    },
  );
});

test("--out - refuses to write PNG bytes to a terminal before reading input or calling the API", async () => {
  // Preload a module that makes stdout look like a terminal.
  const fakeTty = "--import=data:text/javascript,process.stdout.isTTY=true";
  const cases = [
    // With the guard missing, this would read stdin and then fail on the missing browser.
    ["render", "-", "--out", "-", "--browser-path", "missing-browser"],
    // With the guard missing, this would fail on the missing API key.
    ["scenes", "render", "scene_1", "--out", "-"],
  ];
  for (const args of cases) {
    const child = execFileAsync(process.execPath, [fakeTty, cliPath, ...args], {
      env: cliEnv({ EXCALIDRAW_BROWSER_PATH: "" }),
    });
    child.child.stdin?.end(JSON.stringify(renderFixture()));
    await assert.rejects(child, (error: unknown) => {
      assertExecError(error);
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /--out - writes binary PNG to standard output; pipe it into another command or redirect it to a file\./);
      return true;
    });
  }
});
