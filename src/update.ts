import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import { cacheDirectory } from "./cache.js";
import { packageDirectory, packageJson } from "./package.js";

const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Bounds a check during a long command. A command that ends drops its check anyway. */
const BACKGROUND_CHECK_TIMEOUT_MS = 10_000;

/** A release version. It has no characters a shell treats specially, so it can go into a command line. */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "volta";

export type Installation =
  | { type: "global"; packageManager: PackageManager }
  /** Started by a runner that downloads the package on demand, and keeps a version until asked for @latest. */
  | { type: "temporary"; runner: "npx" | "pnpm dlx" | "bunx" }
  /** A project dependency, a source checkout, or a global install in a place the CLI doesn't recognize. */
  | { type: "other" };

const INSTALL_COMMANDS: Record<PackageManager, string[]> = {
  npm: ["npm", "install", "-g"],
  pnpm: ["pnpm", "add", "-g"],
  yarn: ["yarn", "global", "add"],
  bun: ["bun", "add", "-g"],
  volta: ["volta", "install"],
};

/** The command that installs `version` the way the running CLI was installed. */
export function installCommand(packageManager: PackageManager, version: string) {
  return [...INSTALL_COMMANDS[packageManager], `${packageJson.name}@${version}`];
}

/**
 * Works out how the running CLI was installed from where it runs. process.argv[1] is the path it was
 * started by, e.g. in pnpm's global directory; packageDirectory resolves symlinks, e.g. into pnpm's store.
 */
export function detectInstallation(): Installation {
  const paths = [process.argv[1], packageDirectory].filter((path) => path !== undefined).map(normalizePath);
  const matches = (pattern: RegExp) => paths.some((path) => pattern.test(path));
  const pnpmHome = process.env.PNPM_HOME ? `${normalizePath(process.env.PNPM_HOME)}/global/` : undefined;

  // The default locations on Linux, macOS and Windows; paths are lowercase on Windows.
  if (matches(/\/_npx\//)) {
    return { type: "temporary", runner: "npx" };
  }
  if (matches(/\/pnpm(-cache)?\/dlx\//)) {
    return { type: "temporary", runner: "pnpm dlx" };
  }
  if (matches(/\/bunx-/)) {
    return { type: "temporary", runner: "bunx" };
  }
  if (matches(/\/volta\/tools\/image\/packages\//)) {
    return { type: "global", packageManager: "volta" };
  }
  if (matches(/\/\.?bun\/install\/global\/node_modules\//)) {
    return { type: "global", packageManager: "bun" };
  }
  if (matches(/\/yarn\/(data\/)?global\/node_modules\//)) {
    return { type: "global", packageManager: "yarn" };
  }
  if (matches(/\/pnpm\/global\//) || (pnpmHome && paths.some((path) => path.startsWith(pnpmHome)))) {
    return { type: "global", packageManager: "pnpm" };
  }
  if (isInNpmGlobalPrefix()) {
    return { type: "global", packageManager: "npm" };
  }
  return { type: "other" };
}

function normalizePath(path: string) {
  const normalized = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * npm installs global packages into <prefix>/lib/node_modules and links the command into <prefix>/bin;
 * on Windows, into <prefix>\node_modules with the command in <prefix> itself. A project's node_modules
 * has neither, and the prefix can be anywhere (nvm, Homebrew, a custom prefix), so the layout is what counts.
 */
function isInNpmGlobalPrefix() {
  // The package directory is <node_modules>/@excalidraw/cli.
  const nodeModules = dirname(dirname(packageDirectory));
  if (basename(nodeModules) !== "node_modules") {
    return false;
  }
  if (process.platform === "win32") {
    return existsSync(join(dirname(nodeModules), "excalidraw.cmd"));
  }
  const lib = dirname(nodeModules);
  return basename(lib) === "lib" && existsSync(join(dirname(lib), "bin", "excalidraw"));
}

/** The version npm's latest tag points to, from the registry npm_config_registry names, or npm's own. */
export async function fetchLatestVersion(signal: AbortSignal) {
  const registry = process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || DEFAULT_REGISTRY;
  // Registries expect the slash in a scoped name escaped.
  const url = new URL(
    `-/package/${packageJson.name.replace("/", "%2f")}/dist-tags`,
    registry.endsWith("/") ? registry : `${registry}/`,
  );
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal });

  if (!response.ok) {
    throw new Error(`${url.origin} answered HTTP ${response.status}`);
  }

  const latest = ((await response.json()) as { latest?: unknown } | null)?.latest;

  if (typeof latest !== "string" || !VERSION_PATTERN.test(latest)) {
    throw new Error(`${url.origin} returned no valid latest version`);
  }

  return latest;
}

/**
 * Whether `candidate` is a later release than `current`: 1.0.0 is later than 1.0.0-beta.1. Two
 * prereleases of the same version count as equal, since the latest tag only points to releases.
 */
export function isNewerVersion(candidate: string, current: string) {
  const a = VERSION_PATTERN.exec(candidate);
  const b = VERSION_PATTERN.exec(current);

  if (!a || !b) {
    return false;
  }

  for (let part = 1; part <= 3; part++) {
    if (Number(a[part]) !== Number(b[part])) {
      return Number(a[part]) > Number(b[part]);
    }
  }

  return a[4] === undefined && b[4] !== undefined;
}

/** The update notice's last line, or nothing when the CLI can't tell how it was installed. */
function updateHint(installation: Installation) {
  switch (installation.type) {
    case "global":
      return `Run ${chalk.cyan("excalidraw update")} to update.`;
    case "temporary":
      return `Run ${chalk.cyan(`${installation.runner} ${packageJson.name}@latest`)} to use it.`;
    case "other":
      return undefined;
  }
}

/**
 * Starts asking the registry for the latest version, at most once a day, while the command runs. Call
 * `finish` when the command is done: it prints a notice if a newer version came back by then, and
 * otherwise drops the check, so a command never waits for the registry. A dropped check runs again next time.
 *
 * Scripts, agents and CI read the output rather than a person, so the check only runs when stdout and
 * stderr are both a terminal.
 */
export function startUpdateCheck() {
  if (
    !process.stdout.isTTY ||
    !process.stderr.isTTY ||
    process.env.CI ||
    process.env.EXCALIDRAW_NO_UPDATE_NOTIFIER ||
    process.env.NO_UPDATE_NOTIFIER
  ) {
    return undefined;
  }

  const hint = updateHint(detectInstallation());
  const sinceLastCheck = Date.now() - readLastCheck();

  if (!hint || (sinceLastCheck >= 0 && sinceLastCheck < CHECK_INTERVAL_MS)) {
    return undefined;
  }

  const controller = new AbortController();
  let latestVersion: string | undefined;

  fetchLatestVersion(AbortSignal.any([controller.signal, AbortSignal.timeout(BACKGROUND_CHECK_TIMEOUT_MS)]))
    .then((version) => {
      latestVersion = version;
      saveLastCheck(version);
    })
    .catch(() => {
      // Offline, or the registry is slow or unreachable: the next command tries again.
    });

  return {
    finish() {
      controller.abort();

      if (latestVersion && isNewerVersion(latestVersion, packageJson.version)) {
        printBanner([
          `A new version of excalidraw is available: ${chalk.dim(packageJson.version)} → ${chalk.green(latestVersion)}`,
          hint,
        ]);
      }
    },
  };
}

/** Spaces between the border and the longest line. */
const BANNER_PADDING = 3;

/** Prints the lines centered in a box, or as they are if the terminal is too narrow for it. */
function printBanner(lines: string[]) {
  // Every character in the lines takes one column, so their length without color codes is their width.
  const widths = lines.map((line) => stripVTControlCharacters(line).length);
  const inner = Math.max(...widths) + 2 * BANNER_PADDING;

  // A box the terminal wraps falls apart, so it needs a terminal that reports enough columns.
  if (!process.stderr.columns || inner + 2 > process.stderr.columns) {
    console.error(`\n${lines.join("\n")}`);
    return;
  }

  const border = chalk.yellow;
  const row = (text: string, width: number) => {
    const left = Math.floor((inner - width) / 2);
    return `${border("│")}${" ".repeat(left)}${text}${" ".repeat(inner - width - left)}${border("│")}`;
  };

  console.error(
    [
      "",
      border(`╭${"─".repeat(inner)}╮`),
      row("", 0),
      ...lines.map((line, index) => row(line, widths[index])),
      row("", 0),
      border(`╰${"─".repeat(inner)}╯`),
    ].join("\n"),
  );
}

function lastCheckPath() {
  return join(cacheDirectory(), "update-check.json");
}

/** When the last check succeeded, in milliseconds since the epoch, or 0 if it never did. */
function readLastCheck() {
  try {
    const { checkedAt } = JSON.parse(readFileSync(lastCheckPath(), "utf8")) as { checkedAt?: unknown };
    return typeof checkedAt === "number" ? checkedAt : 0;
  } catch {
    return 0;
  }
}

function saveLastCheck(latestVersion: string) {
  try {
    mkdirSync(dirname(lastCheckPath()), { recursive: true });
    writeFileSync(lastCheckPath(), `${JSON.stringify({ checkedAt: Date.now(), latestVersion })}\n`);
  } catch {
    // An unwritable cache only means checking again next time.
  }
}
