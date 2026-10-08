import { homedir } from "node:os";
import { join } from "node:path";

/** Where the CLI keeps what it can download again, such as fonts. Deleting it is safe. */
export function cacheDirectory() {
  const base = process.env.XDG_CACHE_HOME
    ? process.env.XDG_CACHE_HOME
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Caches")
      : process.platform === "win32"
        ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
        : join(homedir(), ".cache");
  return join(base, "excalidraw-cli");
}
