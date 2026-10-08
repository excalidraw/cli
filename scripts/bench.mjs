// Measures the built CLI the way users run it: package size, installed footprint, and wall-clock
// time of complete commands. Run `pnpm run build` first.
//
//   node scripts/bench.mjs [--runs 10] [--install]
//
// --install also installs the packed tarball into a temporary global prefix to measure what users
// download and store, dependencies included (needs network access to the registry).
//
// Linux and macOS only: it looks for the browser by name on PATH, prints its --version, and expects
// npm's POSIX layout for global installs.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { runs: { type: "string", default: "10" }, install: { type: "boolean", default: false } },
});
const runs = Number(values.runs);
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist/main.js");

const work = await mkdtemp(join(tmpdir(), "excalidraw-bench-"));
try {
  const browser = findBrowser();
  const env = {
    ...process.env,
    EXCALIDRAW_API_KEY: "",
    EXCALIDRAW_BROWSER_PATH: browser,
    // Keeps downloaded fonts out of the developer's cache, so cold and warm runs are controlled.
    XDG_CACHE_HOME: join(work, "cache"),
    NODE_NO_WARNINGS: "1",
  };
  console.log(`node ${process.version}, ${execFileSync(browser, ["--version"], { encoding: "utf8" }).trim()} (${browser})`);
  console.log(`${runs} runs per command after one warm-up run; times are min / median / max\n`);

  const latin = join(work, "latin.excalidraw");
  const cjk = join(work, "cjk.excalidraw");
  await writeFile(latin, scene([rectangle(), text("Hello world, Price €50")]));
  await writeFile(cjk, scene([text("手書き 你好世界 한국어"), text("我们今天下午三点讨论发布计划", 70)]));

  console.log("| Command | Time (s) |\n|---|---|");
  for (const [label, args] of [
    ["`--version`", ["--version"]],
    ["`render` Latin scene", ["render", latin, "--out", join(work, "latin.png")]],
    ["`render` CJK scene (warm font cache)", ["render", cjk, "--out", join(work, "cjk.png")]],
  ]) {
    console.log(`| ${label} | ${formatTimes(time(args, env))} |`);
  }
  // Downloads the CJK font files, so it depends on the network: one sample, not a median.
  const cold = time(["render", cjk, "--out", join(work, "cjk.png")], { ...env, XDG_CACHE_HOME: join(work, "cold") }, 1);
  console.log(`| \`render\` CJK scene, empty font cache (1 run) | ${cold[0].toFixed(2)} |`);

  const pack = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }))[0];
  console.log("\n| Package | Size |\n|---|---|");
  console.log(`| tarball (download) | ${mb(pack.size)} |`);
  console.log(`| unpacked bytes, ${pack.entryCount} files | ${mb(pack.unpackedSize)} |`);
  const cache = await footprint(join(work, "cache"));
  console.log(`| font cache after the CJK scene, ${cache.files} files | ${mb(cache.bytes)} (${mb(cache.disk)} on disk) |`);

  if (values.install) {
    const tarball = execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", work], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").pop();
    const prefix = join(work, "prefix");
    execFileSync("npm", ["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", join(work, tarball)], { stdio: "ignore" });
    const installed = await footprint(join(prefix, "lib/node_modules"));
    console.log(`| installed with dependencies, ${installed.packages} packages, ${installed.files} files | ${mb(installed.bytes)} (${mb(installed.disk)} on disk) |`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

function time(args, env, count = runs) {
  const run = () => {
    const start = process.hrtime.bigint();
    const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`excalidraw ${args.join(" ")} failed:\n${result.stderr}`);
    }
    return Number(process.hrtime.bigint() - start) / 1e9;
  };
  if (count > 1) {
    run();
  }
  return Array.from({ length: count }, run).sort((a, b) => a - b);
}

function formatTimes(times) {
  const median = times.length % 2 ? times[(times.length - 1) / 2] : (times[times.length / 2 - 1] + times[times.length / 2]) / 2;
  return [times[0], median, times.at(-1)].map((t) => t.toFixed(2)).join(" / ");
}

/** Apparent bytes, allocated disk space, file and package counts of a directory tree. */
async function footprint(directory) {
  const total = { bytes: 0, disk: 0, files: 0, packages: 0 };
  if (!existsSync(directory)) {
    return total;
  }
  for (const entry of await readdir(directory, { recursive: true })) {
    const stats = await lstat(join(directory, entry));
    if (stats.isFile()) {
      total.bytes += stats.size;
      total.disk += stats.blocks * 512;
      total.files += 1;
      // A package's own manifest sits right below node_modules (or its scope), not deeper inside it.
      if (/^(.*\/node_modules\/)?(@[^/]+\/)?[^/]+\/package\.json$/.test(entry)) {
        total.packages += 1;
      }
    }
  }
  return total;
}

function mb(bytes) {
  return `${(bytes / 1e6).toFixed(2)} MB`;
}

function findBrowser() {
  if (process.env.EXCALIDRAW_BROWSER_PATH) {
    return process.env.EXCALIDRAW_BROWSER_PATH;
  }
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) {
      if (existsSync(join(directory, name))) {
        return join(directory, name);
      }
    }
  }
  throw new Error("No browser found; set EXCALIDRAW_BROWSER_PATH.");
}

function scene(elements) {
  return JSON.stringify({ type: "excalidraw", version: 2, elements, appState: { viewBackgroundColor: "#ffffff" }, files: {} });
}

function base(id, type, x, y, width, height) {
  return {
    id, type, x, y, width, height, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent",
    fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [],
    frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false,
    boundElements: null, updated: 1, link: null, locked: false,
  };
}

function rectangle() {
  return base("rect", "rectangle", 0, 0, 300, 120);
}

function text(value, y = 0) {
  return {
    ...base(`text-${y}`, "text", 20, y + 30, 400, 45), text: value, originalText: value, fontSize: 36,
    fontFamily: 5, textAlign: "left", verticalAlign: "top", containerId: null, autoResize: true, lineHeight: 1.25,
  };
}
