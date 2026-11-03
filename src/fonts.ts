import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheDirectory } from "./cache.js";
import { httpFetch } from "./http.js";

/** Fonts left out of the package (Xiaolai, the CJK fallback for Excalifont), by sha256. */
type RemoteFonts = { release: string; fonts: Record<string, string> };

/** Mirrors that serve the release's dist/prod/ directory. Any of them works: every file is checked against its sha256. */
function defaultMirrors(release: string) {
  const at = release.lastIndexOf("@");
  return [
    // excalidraw.com's asset CDN.
    "https://excalidraw.nyc3.cdn.digitaloceanspaces.com/oss/",
    // npm's mirror in China, where the other CDNs are often blocked or slow.
    `https://registry.npmmirror.com/${release.slice(0, at)}/${release.slice(at + 1)}/files/dist/prod/`,
    `https://cdn.jsdelivr.net/npm/${release}/dist/prod/`,
  ];
}

function fontCacheDirectory() {
  return join(cacheDirectory(), "fonts");
}

/**
 * Loads the fonts the browser requests: packaged fonts from dist/fonts, the rest from the cache or,
 * on first use, from the mirrors. A mirror is an http(s) URL or a file: URL of a local copy, such
 * as an installed @excalidraw/excalidraw's dist/prod/. Downloads stop at the deadline so the render
 * can still finish with fallback glyphs.
 */
export function createFontLoader({ mirrors, deadline }: { mirrors?: string[]; deadline: number }) {
  const failures = new Map<string, string>();
  let remote: Promise<RemoteFonts | undefined> | undefined;

  async function download(hash: string, path: string, release: string) {
    const urls = (mirrors ?? defaultMirrors(release)).map((base) => new URL(path, base));
    if (urls.length === 0) {
      failures.set(hash, "font downloads are disabled");
      return undefined;
    }
    let reason = "";
    for (const [index, url] of urls.entries()) {
      if (url.protocol === "file:") {
        try {
          const font = await readFile(url);
          if (sha256(font) !== hash) {
            throw new Error("unexpected file contents");
          }
          return { font, local: true };
        } catch (error) {
          reason = `${fileURLToPath(url)}: ${describe(error)}`;
        }
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reason = "timed out";
        break;
      }
      try {
        // Later mirrors get their share of the remaining time if an earlier one hangs.
        // AbortSignal.timeout() only accepts whole milliseconds.
        const timeout = Math.ceil(remaining / (urls.length - index));
        const response = await httpFetch(url, { signal: AbortSignal.timeout(timeout) });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const font = Buffer.from(await response.arrayBuffer());
        if (sha256(font) !== hash) {
          throw new Error("unexpected file contents");
        }
        return { font, local: false };
      } catch (error) {
        reason = `${url.host}: ${describe(error)}`;
      }
    }
    failures.set(hash, reason);
    return undefined;
  }

  return {
    async load(hash: string): Promise<Buffer | undefined> {
      const packaged = await readFile(new URL(`./fonts/${hash}.woff2`, import.meta.url)).catch(() => undefined);
      if (packaged) {
        return packaged;
      }
      remote ??= readFile(new URL("./fonts/remote.json", import.meta.url), "utf8")
        .then((text) => JSON.parse(text) as RemoteFonts)
        .catch(() => undefined);
      const manifest = await remote;
      const path = manifest?.fonts[hash];
      if (!manifest || !path) {
        return undefined;
      }

      const cached = join(fontCacheDirectory(), `${hash}.woff2`);
      const font = await readFile(cached).catch(() => undefined);
      if (font && sha256(font) === hash) {
        return font;
      }
      const downloaded = await download(hash, path, manifest.release);
      // A local copy is already on disk.
      if (downloaded && !downloaded.local) {
        await saveToCache(cached, downloaded.font);
      }
      return downloaded?.font;
    },

    /** One line about fonts that couldn't be loaded, if any. */
    warning() {
      if (failures.size === 0) {
        return undefined;
      }
      if (mirrors?.length === 0) {
        return "Font downloads are disabled (--fonts-url none), so characters that need a downloaded font use a fallback font.";
      }
      const reasons = [...new Set(failures.values())].join("; ");
      const files = failures.size === 1 ? "1 font file" : `${failures.size} font files`;
      return `Could not download ${files} for this scene's text (${reasons}), so some characters use a fallback font. Check your network connection, set HTTPS_PROXY if you connect through a proxy, or set --fonts-url to a reachable mirror or a local copy of @excalidraw/excalidraw's dist/prod folder.`;
    },
  };
}

async function saveToCache(path: string, font: Buffer) {
  // Written under a unique name, then renamed, so concurrent renders never read a partial file.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(temporary, font);
    await rename(temporary, path);
  } catch {
    // An unwritable cache only costs a download next time.
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function describe(error: unknown) {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "timed out";
  }
  // File system errors carry their code; fetch() errors keep it in `cause`.
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string") {
    return code;
  }
  const cause = error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined;
  return cause?.code ?? (error instanceof Error ? error.message : String(error));
}
