import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The bundle's files all sit in dist/, one level below package.json.
const packageJsonUrl = new URL("../package.json", import.meta.url);

export const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { name: string; version: string };

/** Where the CLI is installed. Node runs the script by its real path, so symlinks are resolved. */
export const packageDirectory = dirname(fileURLToPath(packageJsonUrl));

/**
 * Sent with every API request. The API counts requests whose User-Agent starts with
 * `excalidraw-cli/<version>` as CLI usage, apart from other API and MCP clients.
 */
export const userAgent = `excalidraw-cli/${packageJson.version} node/${process.versions.node} ${process.platform}-${process.arch}`;
