import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";

/** How the browser is driven: over the DevTools protocol, or Firefox over WebDriver BiDi. */
export type BrowserKind = "chromium" | "firefox";

export type InstalledBrowser = { path: string; kind: BrowserKind };

/**
 * Find an installed browser without downloading one or opening a personal profile. Chrome, Edge,
 * and Chromium come first. Firefox renders the same scenes, but a render takes about 5 s instead of
 * under 1 s, mostly starting the browser and shutting it down.
 */
export async function findBrowser(explicitPath?: string): Promise<InstalledBrowser> {
  if (explicitPath) {
    const path = resolve(explicitPath);
    if (await isExecutable(path)) {
      return { path, kind: kindOf(path) };
    }
    throw new Error(`Browser executable not found or not executable: ${path}`);
  }

  // Snap packages come last: their confinement often breaks browser automation.
  let snap: InstalledBrowser | undefined;
  for (const candidate of candidates()) {
    const launcher = await classify(candidate.path);
    if (launcher === "regular") {
      return candidate;
    }
    if (launcher === "snap") {
      snap ??= candidate;
    }
  }
  if (snap) {
    return snap;
  }
  throw new Error(
    "No Chrome, Chromium, Edge, or Firefox browser found. Install one, or pass --browser-path <path> / EXCALIDRAW_BROWSER_PATH. No browser is downloaded automatically.",
  );
}

/** A binary named like Firefox (firefox, firefox-esr, firefox.exe) is driven as Firefox, anything else as Chromium. */
function kindOf(path: string): BrowserKind {
  return /firefox/i.test(basename(path)) ? "firefox" : "chromium";
}

function candidates(): InstalledBrowser[] {
  const onPath = (names: string[]) =>
    (process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .flatMap((directory) => names.map((name) => join(directory, name)));

  const chromium = onPath(
    process.platform === "win32"
      ? ["chrome.exe", "msedge.exe", "chromium.exe"]
      : [
          "google-chrome",
          "google-chrome-stable",
          "chromium",
          "chromium-browser",
          "microsoft-edge",
          "microsoft-edge-stable",
        ],
  );
  const firefox = onPath(process.platform === "win32" ? ["firefox.exe"] : ["firefox", "firefox-esr"]);

  if (process.platform === "darwin") {
    for (const directory of ["/Applications", join(homedir(), "Applications")]) {
      for (const name of ["Google Chrome", "Microsoft Edge", "Chromium"]) {
        chromium.push(join(directory, `${name}.app`, "Contents", "MacOS", name));
      }
      firefox.push(join(directory, "Firefox.app", "Contents", "MacOS", "firefox"));
    }
  } else if (process.platform === "win32") {
    for (const directory of [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ]) {
      if (directory) {
        chromium.push(join(directory, "Google", "Chrome", "Application", "chrome.exe"));
        chromium.push(join(directory, "Microsoft", "Edge", "Application", "msedge.exe"));
        chromium.push(join(directory, "Chromium", "Application", "chrome.exe"));
        firefox.push(join(directory, "Mozilla Firefox", "firefox.exe"));
      }
    }
  } else {
    chromium.push(
      "/opt/google/chrome/chrome",
      "/opt/microsoft/msedge/msedge",
      "/snap/bin/chromium",
    );
    firefox.push(
      "/usr/lib/firefox/firefox",
      "/usr/lib/firefox-esr/firefox-esr",
      "/opt/firefox/firefox",
      "/snap/bin/firefox",
    );
  }

  return [
    ...chromium.map((path) => ({ path, kind: "chromium" as const })),
    ...firefox.map((path) => ({ path, kind: "firefox" as const })),
  ];
}

/**
 * Whether a candidate exists, and whether it starts a snap package. Ubuntu's chromium-browser and
 * firefox packages are only shell scripts that run the snap, and fail when the snap isn't installed.
 * Other launchers, such as Google Chrome's, are shell scripts too, so only snap paths count.
 */
async function classify(path: string): Promise<"missing" | "regular" | "snap"> {
  if (!(await isExecutable(path))) {
    return "missing";
  }
  const target = await realpath(path).catch(() => path);
  if (target.startsWith("/snap/") || target === "/usr/bin/snap") {
    return "snap";
  }
  const head = await readHead(target);
  const snaps = head.startsWith("#!") ? (head.match(/\/snap\/bin\/[\w.-]+/g) ?? []) : [];
  if (snaps.length === 0) {
    return "regular";
  }
  for (const snapPath of snaps) {
    if (await isExecutable(snapPath)) {
      return "snap";
    }
  }
  return "missing";
}

/** The first few kilobytes, enough to tell a launcher script from a binary. */
async function readHead(path: string) {
  const file = await open(path).catch(() => undefined);
  if (!file) {
    return "";
  }
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(4096), 0, 4096, 0);
    return buffer.toString("latin1", 0, bytesRead);
  } finally {
    await file.close();
  }
}

async function isExecutable(path: string) {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
