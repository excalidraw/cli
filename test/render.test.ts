import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import type { TestContext } from "node:test";
import { PNG } from "pngjs";
import { FONT_DATA_URL, readUtilsBundle, sha256 } from "../scripts/embedded-fonts.mjs";
import { assertExecError, cliEnv, escapeRegExp, runWithStdout, startProxy } from "./helpers.ts";
import { renderFixture, textFixture } from "./render-fixture.ts";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

type RunOptions = { env?: NodeJS.ProcessEnv; cwd?: string; cli?: string };

/** Points the API at a closed port, and keeps renders away from the network and the developer's font cache. */
function renderEnv(env: NodeJS.ProcessEnv = {}) {
  return cliEnv({
    EXCALIDRAW_API_URL: "http://127.0.0.1:9",
    // Font download tests opt in with their own mirror and cache.
    EXCALIDRAW_FONTS_URL: "none",
    XDG_CACHE_HOME: join(tmpdir(), "excalidraw-render-test-no-cache"),
    ...env,
  });
}

function execOptions({ env, cwd }: RunOptions) {
  // PNGs on stdout can exceed execFile's 1 MiB default, which would kill the CLI mid-write.
  return { cwd, env: renderEnv(env), maxBuffer: 64 * 1024 * 1024, timeout: 45000 };
}

function runCli(args: string[], input?: unknown, options: RunOptions = {}) {
  const child = execFileAsync(process.execPath, [options.cli ?? cliPath, ...args], execOptions(options));
  child.child.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
  return child;
}

/** Like runCli, but captures stdout as bytes. */
function runPngCli(args: string[], input?: unknown, options: RunOptions = {}) {
  const child = execFileAsync(process.execPath, [options.cli ?? cliPath, ...args], {
    ...execOptions(options),
    encoding: "buffer",
  });
  child.child.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
  return child;
}

function readStdoutPng(stdout: Buffer) {
  assert.equal(stdout.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(
    stdout.subarray(-12).toString("hex"),
    "0000000049454e44ae426082",
    "stdout ends at the PNG's IEND chunk, without a newline or JSON summary",
  );
  return PNG.sync.read(stdout);
}

/** Copies the built package so a test can change its files; returns the copy's CLI path. */
async function copyPackage(directory: string) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  await cp(join(root, "dist"), join(directory, "dist"), { recursive: true });
  await cp(join(root, "package.json"), join(directory, "package.json"));
  await symlink(join(root, "node_modules"), join(directory, "node_modules"), "junction");
  return join(directory, "dist/main.js");
}

/** The fonts the package downloads instead of shipping, by mirror path, taken from @excalidraw/utils. */
async function remoteFonts() {
  const remote: { fonts: Record<string, string> } = JSON.parse(
    await readFile(new URL("../dist/fonts/remote.json", import.meta.url), "utf8"),
  );
  const fonts = new Map<string, Buffer>();
  for (const [, base64] of (await readUtilsBundle()).matchAll(FONT_DATA_URL)) {
    const font = Buffer.from(base64!, "base64");
    const path = remote.fonts[sha256(font)];
    if (path) {
      fonts.set(`/${path}`, font);
    }
  }
  return fonts;
}

type MirrorOptions = {
  /** Answers HTTP 500 for these paths. */
  fail?: (path: string) => boolean;
  /** Milliseconds to wait before answering a path. */
  delay?: (path: string) => number;
  /** Serves other bytes than the font. */
  corrupt?: boolean;
  /** Never answers. */
  hang?: boolean;
};

/** A font CDN mirror that records the paths it was asked for. */
async function startFontMirror(t: TestContext, { fail, delay, corrupt = false, hang = false }: MirrorOptions = {}) {
  const fonts = await remoteFonts();
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    const path = req.url!;
    requests.push(path);
    const font = fonts.get(path);
    if (hang) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delay?.(path) ?? 0));
    if (!font || fail?.(path)) {
      res.writeHead(font ? 500 : 404).end();
      return;
    }
    res.writeHead(200, { "content-type": "font/woff2" }).end(corrupt ? Buffer.from("not a font") : font);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}/`, requests };
}

function pixel(png: PNG, x: number, y: number) {
  const offset = (y * png.width + x) * 4;
  return [...png.data.subarray(offset, offset + 4)];
}

test("local rendering works from a file and stdin, with images, text, frame clipping, and scaling", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-render-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "scene.excalidraw");
  const out = join(directory, "scene.png");
  const scene = renderFixture();
  await writeFile(input, JSON.stringify(scene));

  const { stdout } = await runCli([
    "render",
    input,
    "--out",
    out,
    "--frame-id",
    "frame",
    "--padding",
    "100",
  ]);
  assert.deepEqual(JSON.parse(stdout), {
    path: out,
    mimeType: "image/png",
    width: 200,
    height: 100,
    frameId: "frame",
  });
  const png = PNG.sync.read(await readFile(out));
  assert.deepEqual(pixel(png, 30, 70), [0, 255, 0, 255], "embedded image is rendered");
  assert.deepEqual(pixel(png, 170, 70), [255, 0, 0, 255]);
  assert.deepEqual(pixel(png, 5, 5), [255, 255, 255, 255]);
  let textPixels = 0;
  for (let y = 20; y < 45; y++) {
    for (let x = 20; x < 180; x++) {
      if (pixel(png, x, y)[0] < 100) textPixels++;
    }
  }
  assert.ok(textPixels > 100, "font renders readable text instead of an empty rectangle");

  const piped = await runPngCli(["render", input, "--out", "-", "--frame-id", "frame"]);
  assert.deepEqual(readStdoutPng(piped.stdout).data, png.data, "stdout matches file output");

  await runCli(
    ["render", "-", "--out", out, "--frame-id", "frame", "--scale", "2", "--transparent"],
    scene,
  );
  const scaled = PNG.sync.read(await readFile(out));
  assert.equal(scaled.width, 400);
  assert.equal(scaled.height, 200);
  assert.equal(pixel(scaled, 5, 5)[3], 0);
  assert.deepEqual(pixel(scaled, 60, 140), [0, 255, 0, 255]);

  await runCli(["render", input, "--out", out, "--padding", "0"]);
  const full = PNG.sync.read(await readFile(out));
  assert.ok(
    full.width >= 420 && full.width < 500,
    "includes outside element but excludes deleted element",
  );

  await runCli([
    "render",
    input,
    "--out",
    out,
    "--frame-id",
    "frame",
    "--max-width",
    "100",
    "--max-height",
    "40",
    "--theme",
    "dark",
  ]);
  const capped = PNG.sync.read(await readFile(out));
  assert.equal(capped.width, 80);
  assert.equal(capped.height, 40);
  assert.ok(pixel(capped, 1, 1)[0] < 100, "dark theme changes the background");

  const magic = {
    ...scene,
    elements: scene.elements.map((element) => element.id === "frame" ? { ...element, type: "magicframe" } : element),
  };
  await runCli(["render", "-", "--out", out, "--frame-id", "frame"], magic);
  const magicPng = PNG.sync.read(await readFile(out));
  assert.equal(magicPng.width, 200, "magic frames clip like frames");
  assert.equal(magicPng.height, 100);
  assert.deepEqual(pixel(magicPng, 170, 70), [255, 0, 0, 255]);
});

test("text uses the packaged fonts, and an unavailable font falls back instead of failing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-render-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scene = textFixture(["Handwritten text"]);

  const packaged = await runPngCli(["render", "-", "--out", "-"], scene);
  const cli = await copyPackage(join(directory, "package"));
  await rm(join(directory, "package/dist/fonts"), { recursive: true });
  const fallback = await runPngCli(["render", "-", "--out", "-"], scene, { cli });

  const packagedPng = readStdoutPng(packaged.stdout);
  const fallbackPng = readStdoutPng(fallback.stdout);
  assert.equal(fallbackPng.width, packagedPng.width);
  assert.notDeepEqual(fallbackPng.data, packagedPng.data, "Excalifont is drawn, not a system fallback font");
});

test("CJK text downloads the font files it needs once, then renders them from the cache", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-render-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mirror = await startFontMirror(t);
  const env = { EXCALIDRAW_FONTS_URL: mirror.url, XDG_CACHE_HOME: directory };

  // Xiaolai covers currency symbols too, but "€" is drawn from Excalifont and needs no download.
  await runPngCli(["render", "-", "--out", "-"], textFixture(["Price €50"]), { env });
  assert.equal(mirror.requests.length, 0);

  const scene = textFixture(["你好世界", "한국어 手書き"]);
  const first = await runPngCli(["render", "-", "--out", "-"], scene, { env });
  assert.equal(first.stderr.toString(), "");
  const downloaded = mirror.requests.length;
  assert.ok(downloaded > 1, "the text spans several font files");
  assert.ok(mirror.requests.every((path) => path.startsWith("/fonts/Xiaolai/")));
  const cached = await readdir(join(directory, "excalidraw-cli/fonts"));
  assert.equal(cached.length, downloaded);

  const second = await runPngCli(["render", "-", "--out", "-"], scene, { env });
  assert.equal(mirror.requests.length, downloaded, "the second render reads the cache");
  const firstPng = readStdoutPng(first.stdout);
  assert.deepEqual(readStdoutPng(second.stdout).data, firstPng.data);

  const offline = await runPngCli(["render", "-", "--out", "-"], scene, {
    env: { EXCALIDRAW_FONTS_URL: "none", XDG_CACHE_HOME: join(directory, "empty") },
  });
  assert.match(offline.stderr.toString(), /Font downloads are disabled/);
  assert.notDeepEqual(readStdoutPng(offline.stdout).data, firstPng.data, "the downloaded font is drawn");
});

test("Chinese text in Excalifont is drawn in Xiaolai; other fonts use a system font, as in the editor", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-render-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mirror = await startFontMirror(t);
  const text = ["流程图：开始 → 结束", "你好，世界"];

  const downloaded = await runPngCli(["render", "-", "--out", "-"], textFixture(text), {
    env: { EXCALIDRAW_FONTS_URL: mirror.url, XDG_CACHE_HOME: directory },
  });
  assert.equal(downloaded.stderr.toString(), "");
  assert.ok(mirror.requests.length > 0, "Excalifont text downloads Xiaolai");
  assert.ok(mirror.requests.every((path) => path.startsWith("/fonts/Xiaolai/")));

  const offline = await runPngCli(["render", "-", "--out", "-"], textFixture(text), {
    env: { EXCALIDRAW_FONTS_URL: "none", XDG_CACHE_HOME: join(directory, "empty") },
  });
  assert.notDeepEqual(
    readStdoutPng(downloaded.stdout).data,
    readStdoutPng(offline.stdout).data,
    "the Chinese text is drawn in Xiaolai, not a system font",
  );

  // Only Excalifont falls back to Xiaolai in Excalidraw; Virgil and Comic Shanns use a system font.
  const requests = mirror.requests.length;
  for (const fontFamily of [1, 8]) {
    const other = await runPngCli(["render", "-", "--out", "-"], textFixture(text, fontFamily), {
      env: { EXCALIDRAW_FONTS_URL: mirror.url, XDG_CACHE_HOME: join(directory, `family-${fontFamily}`) },
    });
    assert.equal(other.stderr.toString(), "");
  }
  assert.equal(mirror.requests.length, requests);
});

test("font downloads go through HTTP_PROXY, except to hosts NO_PROXY lists", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-render-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mirror = await startFontMirror(t);
  const proxy = await startProxy();
  t.after(() => proxy.close());
  const scene = textFixture(["你好，世界"]);
  const mirrorHost = new URL(mirror.url).host;

  const proxied = await runPngCli(["render", "-", "--out", "-"], scene, {
    env: { EXCALIDRAW_FONTS_URL: mirror.url, XDG_CACHE_HOME: join(directory, "proxied"), HTTP_PROXY: proxy.url },
  });
  assert.equal(proxied.stderr.toString(), "");
  assert.ok(proxy.requests.length > 0, "the downloads went through the proxy");
  // Only the CLI's downloads: the browser gets no proxy settings, so its own background requests stay off the proxy.
  assert.ok(proxy.requests.every((request) => request.includes(mirrorHost)), proxy.requests.join(", "));
  const downloads = mirror.requests.length;
  assert.ok(downloads > 0);

  const proxyRequests = proxy.requests.length;
  const direct = await runPngCli(["render", "-", "--out", "-"], scene, {
    env: {
      EXCALIDRAW_FONTS_URL: mirror.url,
      XDG_CACHE_HOME: join(directory, "direct"),
      HTTP_PROXY: proxy.url,
      NO_PROXY: "127.0.0.1",
    },
  });
  assert.equal(proxy.requests.length, proxyRequests, "NO_PROXY skips the proxy");
  assert.equal(mirror.requests.length, downloads * 2);
  assert.deepEqual(readStdoutPng(direct.stdout).data, readStdoutPng(proxied.stdout).data);
});

test("--fonts-url takes a local copy of the fonts, as a folder or a file: URL, without caching it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-render-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Laid out like node_modules/@excalidraw/excalidraw/dist/prod.
  for (const [path, font] of await remoteFonts()) {
    await mkdir(join(directory, "prod", dirname(path)), { recursive: true });
    await writeFile(join(directory, "prod", path), font);
  }
  const mirror = await startFontMirror(t);
  const scene = textFixture(["你好，世界"]);
  const reference = await runPngCli(["render", "-", "--out", "-"], scene, {
    env: { EXCALIDRAW_FONTS_URL: mirror.url, XDG_CACHE_HOME: join(directory, "mirror-cache") },
  });

  for (const fontsUrl of ["prod", pathToFileURL(join(directory, "prod")).href]) {
    const cache = join(directory, "local-cache");
    const local = await runPngCli(["render", "-", "--out", "-", "--fonts-url", fontsUrl], scene, {
      cwd: directory,
      env: { XDG_CACHE_HOME: cache },
    });
    assert.equal(local.stderr.toString(), "", fontsUrl);
    assert.deepEqual(readStdoutPng(local.stdout).data, readStdoutPng(reference.stdout).data, fontsUrl);
    assert.equal(existsSync(join(cache, "excalidraw-cli/fonts")), false, "a local copy isn't cached");
  }

  // A folder without the fonts, such as another package's dist/.
  await mkdir(join(directory, "empty"));
  const missing = await runPngCli(["render", "-", "--out", "-", "--fonts-url", "empty"], scene, {
    cwd: directory,
    env: { XDG_CACHE_HOME: join(directory, "missing-cache") },
  });
  assert.match(
    missing.stderr.toString(),
    new RegExp(`Could not download \\d+ font files? for this scene's text \\(${escapeRegExp(join(directory, "empty"))}/fonts/Xiaolai/[^:]+: ENOENT.*local copy of @excalidraw/excalidraw's dist/prod folder`),
  );
});

test("a font that fails to download doesn't make the renderer draw before the others arrive", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-render-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // The first requested file always fails. FontFaceSet.load() rejects on the first failure, even
  // while other files are still on their way.
  let failing: string | undefined;
  let failSlowly = false;
  const mirror = await startFontMirror(t, {
    fail: (path) => (failing ??= path) === path,
    delay: (path) => (path !== failing || failSlowly ? 500 : 0),
  });
  const env = { EXCALIDRAW_FONTS_URL: mirror.url, XDG_CACHE_HOME: directory };
  const scene = textFixture(["你好世界", "한국어 手書き"]);

  // The failure arrives first, while the other files are still downloading.
  const early = await runPngCli(["render", "-", "--out", "-"], scene, { env });
  assert.match(early.stderr.toString(), /Could not download 1 font file .*HTTP 500.*fallback font/);
  // The reference: the other files come from the cache, and the failure arrives last.
  failSlowly = true;
  const late = await runPngCli(["render", "-", "--out", "-"], scene, { env });
  assert.deepEqual(readStdoutPng(early.stdout).data, readStdoutPng(late.stdout).data);
});

test("a mirror serving the wrong bytes is skipped for the next one", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-render-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const corrupt = await startFontMirror(t, { corrupt: true });
  const good = await startFontMirror(t);

  const { stderr } = await runPngCli(["render", "-", "--out", "-"], textFixture(["你好"]), {
    env: { EXCALIDRAW_FONTS_URL: `${corrupt.url},${good.url}`, XDG_CACHE_HOME: directory },
  });
  assert.equal(stderr.toString(), "");
  assert.ok(corrupt.requests.length > 0);
  assert.deepEqual(good.requests, corrupt.requests);
  for (const file of await readdir(join(directory, "excalidraw-cli/fonts"))) {
    const font = await readFile(join(directory, "excalidraw-cli/fonts", file));
    assert.equal(`${sha256(font)}.woff2`, file);
  }
});

test("a hanging mirror gives up in time to render with fallback glyphs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-render-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mirror = await startFontMirror(t, { hang: true });

  // Succeeding shows the downloads stopped in time: otherwise the 6 s render deadline fails the command.
  const started = Date.now();
  const { stderr } = await runPngCli(["render", "-", "--out", "-", "--timeout", "6000"], textFixture(["你好"]), {
    env: { EXCALIDRAW_FONTS_URL: mirror.url, XDG_CACHE_HOME: directory },
  });
  assert.match(stderr.toString(), /timed out/);
  // The deadline doesn't cover closing the browser, which takes Firefox about 3 s.
  assert.ok(Date.now() - started < 10_000, "the command doesn't hang on the mirror");
});

test("render accepts JSON stdin and emits only PNG stdout even with output flags", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-stdout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dashFile = join(directory, "-");
  await writeFile(dashFile, "keep this file");
  const { stdout } = await runPngCli(
    ["render", "-", "--out", "-", "--frame-id", "frame", "--scale", "2", "--transparent", "--raw", "--output", "table"],
    renderFixture(),
    { cwd: directory },
  );
  const png = readStdoutPng(stdout);
  assert.equal(png.width, 400);
  assert.equal(png.height, 200);
  assert.equal(pixel(png, 5, 5)[3], 0);
  assert.deepEqual(pixel(png, 60, 140), [0, 255, 0, 255]);
  assert.equal(await readFile(dashFile, "utf8"), "keep this file");
});

test("--out - reports a failed stdout write once, without a stack trace", { skip: !existsSync("/dev/full") && "needs /dev/full" }, async () => {
  const full = await open("/dev/full", "w");
  try {
    const { code, stderr } = await runWithStdout([cliPath, "render", "-", "--out", "-"], full.fd, {
      input: JSON.stringify(renderFixture()),
      env: renderEnv(),
    });
    assert.equal(code, 1);
    assert.equal(stderr, "Could not write to stdout: ENOSPC: no space left on device, write\n");
  } finally {
    await full.close();
  }
});

test("--out - ends quietly with exit 0 when the reader closes stdout early", async () => {
  const { code, stderr } = await runWithStdout([cliPath, "render", "-", "--out", "-"], "closed", {
    input: JSON.stringify(renderFixture()),
    env: renderEnv(),
  });
  assert.equal(code, 0);
  assert.equal(stderr, "");
});

test("scenes render reads the authenticated public API even with --raw, then renders locally", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-scene-render-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: string[] = [];
  let retryNextRequest = false;
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-key");
    assert.equal(req.method, "GET");
    calls.push(req.url!);
    if (retryNextRequest) {
      retryNextRequest = false;
      res.writeHead(429, { "retry-after": "0" });
      res.end("Try again");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(renderFixture()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const out = join(directory, "scene.png");
  const { stdout } = await runCli(
    [
      "scenes",
      "render",
      "scene_1",
      "--out",
      out,
      "--frame-id",
      "frame",
      "--raw",
      "--api-url",
      `http://127.0.0.1:${address.port}`,
    ],
    undefined,
    { env: { EXCALIDRAW_API_KEY: "test-key" } },
  );
  assert.deepEqual(calls, ["/api/v1/scenes/scene_1/content"]);
  assert.equal(JSON.parse(stdout).sceneId, "scene_1");
  assert.deepEqual(pixel(PNG.sync.read(await readFile(out)), 30, 70), [0, 255, 0, 255]);

  retryNextRequest = true;
  const piped = await runPngCli(
    ["scenes", "render", "scene_1", "--out", "-", "--frame-id", "frame", "--raw", "--output", "table", "--retries", "1", "--api-url", `http://127.0.0.1:${address.port}`],
    undefined,
    { env: { EXCALIDRAW_API_KEY: "test-key" } },
  );
  assert.equal(calls.length, 3);
  assert.match(piped.stderr.toString(), /HTTP 429; retrying/);
  const png = readStdoutPng(piped.stdout);
  assert.equal(png.width, 200);
  assert.equal(png.height, 100);
  assert.deepEqual(png.data, PNG.sync.read(await readFile(out)).data);
});

test("invalid embedded images fail without overwriting the output", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-bad-image-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const out = join(directory, "scene.png");
  await writeFile(out, "original");
  const scene = renderFixture();
  scene.files.green.dataURL = "data:image/png;base64,bm90IGFuIGltYWdl";
  await assert.rejects(runCli(["render", "-", "--out", out], scene), (error: unknown) => {
    assertExecError(error);
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Could not decode embedded image: green/);
    return true;
  });
  assert.equal(await readFile(out, "utf8"), "original");

  await assert.rejects(runCli(["render", "-", "--out", "-"], scene), (error: unknown) => {
    assertExecError(error);
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "", "render failures must not emit PNG data or JSON on stdout");
    assert.match(error.stderr, /Could not decode embedded image: green/);
    return true;
  });
});

test("a file that failed to embed doesn't block the render when no live image uses it", async () => {
  // The API can report files it couldn't embed for images that were deleted since.
  const scene = renderFixture();
  const deleted = { ...scene.elements.find((element) => element.id === "image")!, id: "old-image", fileId: "gone", isDeleted: true };
  const { stdout } = await runPngCli(["render", "-", "--out", "-", "--frame-id", "frame"], {
    ...scene,
    elements: [...scene.elements, deleted],
    filesFailedToEmbed: ["gone"],
  });
  assert.deepEqual(pixel(readStdoutPng(stdout), 30, 70), [0, 255, 0, 255], "the live image is still drawn");
});

test("very small size limits still produce a PNG", async () => {
  // A 1×8 shape with the default padding: at these limits, rounding used to leave a 0-pixel side.
  const fixture = renderFixture();
  const scene = { ...fixture, elements: [{ ...fixture.elements[1]!, frameId: null, x: 0, y: 0, width: 1, height: 8 }], files: {} };
  for (const limit of [1, 2, 3]) {
    const { stdout } = await runPngCli(["render", "-", "--out", "-", "--max-width", `${limit}`, "--max-height", `${limit}`], scene);
    const png = readStdoutPng(stdout);
    assert.ok(png.width >= 1 && png.width <= limit && png.height >= 1 && png.height <= limit, `${png.width}×${png.height} at ${limit}`);
  }
});

test("the deadline stops browser startup and rendering without overwriting the output", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const out = join(directory, "scene.png");
  await writeFile(out, "original");
  // Cross-hatching draws one line every few pixels, so this 477-byte scene takes far longer than
  // 5 s to draw (about 30 s on a laptop), while the browser starts well within it.
  const fixture = renderFixture();
  const slow = {
    ...fixture,
    elements: [{ ...fixture.elements[1]!, frameId: null, x: 0, y: 0, width: 2_000_000, height: 2_000_000, fillStyle: "cross-hatch" }],
    files: {},
  };
  const cases: [string[], unknown, RegExp][] = [
    [["--timeout", "1"], fixture, /Timeout 1ms exceeded/],
    [["--timeout", "5000"], slow, /Rendering timed out after 5000 ms/],
  ];
  for (const [args, scene, message] of cases) {
    await assert.rejects(runCli(["render", "-", "--out", out, ...args], scene), (error: unknown) => {
      assertExecError(error);
      assert.equal(error.code, 1);
      assert.match(error.stderr, message);
      return true;
    });
    assert.equal(await readFile(out, "utf8"), "original");
  }
});

test("SVG output follows the --out extension or --format, and embeds the fonts its text uses", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-svg-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "scene.excalidraw");
  const out = join(directory, "scene.svg");
  await writeFile(input, JSON.stringify(renderFixture()));

  const { stdout } = await runCli(["render", input, "--out", out, "--frame-id", "frame", "--scale", "2"]);
  assert.deepEqual(JSON.parse(stdout), { path: out, mimeType: "image/svg+xml", width: 400, height: 200, frameId: "frame" });
  const svg = await readFile(out, "utf8");
  assert.match(svg, /^<svg [^>]*viewBox="0 0 200 100" width="400" height="200"/);
  assert.match(svg, /@font-face \{ font-family: Excalifont; src: url\(data:font\/woff2;base64,/);
  // Subset to the text's glyphs: a whole Excalifont file is several times larger.
  assert.ok(svg.length < 30_000, `${svg.length} bytes`);
  assert.match(svg, /data:image\/png;base64,/, "embedded image is kept");

  const piped = await runCli(["render", input, "--out", "-", "--format", "svg", "--frame-id", "frame", "--scale", "2"]);
  assert.equal(piped.stdout, svg, "stdout matches file output");
});

test("SVGs are valid XML, and a frame's SVG clips its children without embedding the whole scene", async () => {
  const fixture = renderFixture();
  const rect = fixture.elements.find((element) => element.id === "rect")!;
  const text = fixture.elements.find((element) => element.id === "text")!;
  const scene = {
    ...fixture,
    elements: [
      ...fixture.elements.filter((element) => element.id !== "text"),
      // Sticks out of the frame on the right.
      { ...rect, id: "overflow", x: 150, width: 200 },
      // Excalidraw keeps non-breaking spaces, which HTML serializes as &nbsp;, an entity XML lacks.
      { ...text, text: "A B", originalText: "A B" },
    ],
    appState: { ...fixture.appState, exportEmbedScene: true },
  };
  const xmlEntities = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i;

  const whole = (await runCli(["render", "-", "--out", "-", "--format", "svg"], scene)).stdout;
  assert.doesNotMatch(whole, xmlEntities);
  assert.match(whole, /A B/);
  assert.match(whole, /<!-- payload-start -->/, "the scene asked to embed itself");

  const frame = (await runCli(["render", "-", "--out", "-", "--format", "svg", "--frame-id", "frame"], scene)).stdout;
  assert.doesNotMatch(frame, xmlEntities);
  assert.match(frame, /<clipPath id="frame"><rect [^>]*width="200" height="100"/);
  assert.match(frame, /clip-path="url\(#frame\)"/);
  assert.doesNotMatch(frame, /payload-start/, "a frame's SVG doesn't carry the whole scene");
  // exportingFrame still keeps the frame's outline and name out.
  assert.doesNotMatch(frame, />Example</);
});

test("a renderer file missing from the install fails the render right away", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-install-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // An install without the SVG export's WebAssembly.
  const cli = await copyPackage(directory);
  await rm(join(directory, "dist/wasm/0.txt"));

  const started = Date.now();
  await assert.rejects(runCli(["render", "-", "--out", "-", "--format", "svg"], renderFixture(), { cli }), (error: unknown) => {
    assertExecError(error);
    assert.match(error.stderr, /Could not read .*0\.txt \(ENOENT\)\. Reinstall the CLI to restore it\./);
    return true;
  });
  assert.ok(Date.now() - started < 20_000, "fails before the 30 s deadline");
});

test("--all-frames renders each frame in presentation order into the --out directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-frames-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = renderFixture();
  const frame = fixture.elements.find((element) => element.id === "frame")!;
  // A second, unnamed frame to the right that plays first, and one without area that's skipped.
  const scene = {
    ...fixture,
    elements: [
      ...fixture.elements,
      { ...frame, id: "first", name: null, x: 1000, width: 100, height: 50, customData: { slidesOrder: 0 } },
      { ...frame, id: "flat", name: "Flat", x: 2000, height: 0 },
    ],
  };
  const out = join(directory, "slides");
  const { stdout } = await runCli(["render", "-", "--all-frames", "--out", out], scene);
  assert.deepEqual(JSON.parse(stdout), {
    mimeType: "image/png",
    frames: [
      { frameId: "first", name: null, path: join(out, "01-first.png"), width: 100, height: 50 },
      { frameId: "frame", name: "Example", path: join(out, "02-example.png"), width: 200, height: 100 },
    ],
  });
  assert.deepEqual((await readdir(out)).sort(), ["01-first.png", "02-example.png"]);
  assert.deepEqual(pixel(PNG.sync.read(await readFile(join(out, "02-example.png"))), 30, 70), [0, 255, 0, 255]);

  await runCli(["render", "-", "--all-frames", "--format", "svg", "--out", out], scene);
  assert.match(await readFile(join(out, "02-example.svg"), "utf8"), /^<svg /);
});

test("mermaid converts a diagram into editable elements sized to their labels, or renders it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-mermaid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "flow.mmd");
  await writeFile(input, "flowchart LR\n  A[A rather long label] -->|yes| B{Decide}\n  B --> C[Done]\n");

  const out = join(directory, "flow.excalidraw");
  const { stdout } = await runCli(["mermaid", input, "--out", out]);
  const summary = JSON.parse(stdout);
  assert.deepEqual({ ...summary, elements: undefined }, { path: out, mimeType: "application/vnd.excalidraw+json", elements: undefined });
  const scene = JSON.parse(await readFile(out, "utf8"));
  assert.equal(scene.type, "excalidraw");
  assert.equal(summary.elements, scene.elements.length);
  const byId = new Map(scene.elements.map((element: { id: string }) => [element.id, element]));
  const texts = scene.elements.filter((element: { type: string }) => element.type === "text");
  assert.deepEqual(texts.map((text: { text: string }) => text.text).sort(), ["A rather long label", "Decide", "Done", "yes"]);
  const label = texts.find((text: { text: string }) => text.text === "A rather long label");
  const container = byId.get(label.containerId) as { type: string; width: number };
  assert.equal(container.type, "rectangle");
  // Measured in Excalifont: the label fills most of its box instead of a fallback font's narrower width.
  assert.ok(label.width > 150 && label.width < container.width, `label ${label.width}, box ${container.width}`);
  assert.equal(scene.elements.filter((element: { type: string }) => element.type === "arrow").length, 2);

  const png = join(directory, "flow.png");
  const rendered = JSON.parse((await runCli(["mermaid", input, "--out", png, "--scale", "2"])).stdout);
  assert.equal(rendered.mimeType, "image/png");
  const image = PNG.sync.read(await readFile(png));
  assert.deepEqual([image.width, image.height], [rendered.width, rendered.height]);
  assert.ok(image.width > 600);

  const svg = await runCli(["mermaid", input, "--out", "-", "--format", "svg", "--elbow"]);
  assert.match(svg.stdout, /^<svg /);
});

test("mermaid turns Gantt charts and timelines into editable elements, and other types such as pie charts into an image", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-mermaid-types-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const convert = async (name: string, definition: string) => {
    const input = join(directory, `${name}.mmd`);
    const out = join(directory, `${name}.excalidraw`);
    await writeFile(input, definition);
    await runCli(["mermaid", input, "--out", out]);
    const { elements } = JSON.parse(await readFile(out, "utf8")) as { elements: { type: string; text?: string }[] };
    return { types: new Set(elements.map((element) => element.type)), texts: elements.flatMap((element) => element.text ?? []) };
  };

  const gantt = await convert(
    "gantt",
    "gantt\n  title Launch\n  dateFormat YYYY-MM-DD\n  section Build\n  Design :a1, 2026-01-01, 5d\n  Ship :after a1, 3d\n",
  );
  assert.ok(!gantt.types.has("image"));
  assert.ok(gantt.types.has("rectangle"));
  for (const text of ["Launch", "Build", "Design", "Ship"]) {
    assert.ok(gantt.texts.includes(text), `the Gantt chart has the text "${text}"`);
  }

  const timeline = await convert("timeline", "timeline\n  title Releases\n  2025 : CLI 0.1\n  2026 : CLI 0.3\n");
  assert.ok(!timeline.types.has("image"));
  assert.deepEqual(timeline.texts.sort(), ["2025", "2026", "CLI 0.1", "CLI 0.3", "Releases"]);

  const pie = await convert("pie", 'pie title Pets\n  "Dogs" : 3\n  "Cats" : 2\n');
  assert.deepEqual([...pie.types], ["image"]);
});

test("mermaid reports syntax errors with their position", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-mermaid-error-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "flow.mmd");
  const out = join(directory, "flow.excalidraw");
  await writeFile(input, "flowchart LR\n  A --> B\n  B -->> C\n");
  await assert.rejects(runCli(["mermaid", input, "--out", out]), (error: unknown) => {
    assertExecError(error);
    assert.equal(error.code, 1);
    assert.match(error.stderr, /^Could not convert the Mermaid diagram: Parse error on line 3:/);
    return true;
  });
  assert.equal(existsSync(out), false);
});

test("mermaid sizes shapes to Chinese labels drawn in Xiaolai", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excalidraw-mermaid-cjk-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mirror = await startFontMirror(t);
  const input = join(directory, "flow.mmd");
  const out = join(directory, "flow.excalidraw");
  await writeFile(input, "flowchart LR\n  A[开始处理用户请求] --> B{验证通过？}\n  B -->|是| C[返回结果]\n");

  const { stderr } = await runCli(["mermaid", input, "--out", out], undefined, {
    env: { EXCALIDRAW_FONTS_URL: mirror.url, XDG_CACHE_HOME: directory },
  });
  assert.equal(stderr, "");
  assert.ok(mirror.requests.length > 0, "the labels' Xiaolai files are downloaded before measuring");
  const scene = JSON.parse(await readFile(out, "utf8"));
  const byId = new Map(scene.elements.map((element: { id: string }) => [element.id, element]));
  const texts = scene.elements.filter((element: { type: string }) => element.type === "text");
  assert.deepEqual(texts.map((text: { text: string }) => text.text).sort(), ["开始处理用户请求", "是", "返回结果", "验证通过？"].sort());
  for (const text of texts.filter((text: { containerId: string | null }) => text.containerId)) {
    const container = byId.get(text.containerId) as { width: number };
    assert.ok(!text.text.includes("\n"), `"${text.text}" fits its shape without wrapping`);
    assert.ok(text.width < container.width, `"${text.text}" ${text.width} < ${container.width}`);
  }
});
