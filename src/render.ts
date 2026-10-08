import { readFile } from "node:fs/promises";
import { chromium, firefox } from "playwright-core";
import { z } from "zod/v4";
import { findBrowser } from "./browser.js";
import { createFontLoader } from "./fonts.js";
import { renderInBrowser } from "./render-page.js";

import type { RenderOptions } from "./schemas.js";

const ElementSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
    isDeleted: z.boolean().optional(),
  })
  .loose();

const FRAME_TYPES = new Set(["frame", "magicframe"]);

// Requests are fulfilled in memory. No HTTP server or external renderer is involved.
// scripts/build-renderer.mjs points the renderer's fonts at this origin.
const ORIGIN = "http://excalidraw-renderer.local";
const FONT_PATH = /^\/fonts\/[0-9a-f]{64}\.woff2$/;

const SceneSchema = z.object({
  elements: z.array(ElementSchema),
  appState: z.record(z.string(), z.unknown()).default({}),
  files: z.record(z.string(), z.object({ dataURL: z.string() }).loose()).default({}),
  filesFailedToEmbed: z.array(z.string()).optional(),
});

export type RenderScene = z.infer<typeof SceneSchema> & {
  frame?: z.infer<typeof ElementSchema>;
};

function prepareScene(input: unknown, frameId?: string): RenderScene {
  const scene = SceneSchema.parse(input);
  scene.elements = scene.elements.filter((element) => !element.isDeleted);
  if (scene.elements.length === 0) {
    throw new Error("Cannot render an empty scene.");
  }
  // Only live images need their files. filesFailedToEmbed can also name files nothing uses anymore,
  // such as those of deleted images, which don't affect the render.
  const images = scene.elements.filter((element) => element.type === "image");
  const usedFileIds = new Set(images.map((element) => element.fileId));
  const failed = scene.filesFailedToEmbed?.filter((fileId) => usedFileIds.has(fileId)) ?? [];
  if (failed.length > 0) {
    throw new Error(
      `Scene images could not be embedded: ${failed.join(", ")}. Fetch the scene again before rendering.`,
    );
  }

  const frame =
    frameId === undefined
      ? undefined
      : scene.elements.find((element) => element.id === frameId && FRAME_TYPES.has(element.type));
  if (frameId !== undefined && !frame) {
    throw new Error(`Frame not found: ${frameId}`);
  }
  if (frame && (frame.width === 0 || frame.height === 0)) {
    throw new Error(`Frame has no area: ${frameId}`);
  }

  // Only send files used by live image elements to the browser.
  const files: RenderScene["files"] = {};
  for (const element of images) {
    const fileId = element.fileId;
    const file = typeof fileId === "string" ? scene.files[fileId] : undefined;
    if (!file) {
      throw new Error(
        `Image ${element.id} is missing embedded file data. Use a complete .excalidraw export or fetch the scene content again.`,
      );
    }
    if (!/^data:image\/[a-z0-9.+-]+[;,]/i.test(file.dataURL)) {
      throw new Error(
        `Image ${element.id} must contain an embedded image data URL. External image URLs are not supported.`,
      );
    }
    files[fileId as string] = file;
  }

  return {
    ...scene,
    files,
    frame,
    elements: frame ? scene.elements.filter((element) => !FRAME_TYPES.has(element.type)) : scene.elements,
  };
}

const MAX_BROWSER_OUTPUT_LINES = 10;

/**
 * Playwright's launch errors repeat the browser's whole command line in a call log. Keeps the
 * reason and the last lines the browser printed to stderr, which usually say what went wrong.
 */
function describeLaunchError(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const [reason = "", ...lines] = error.message.split("\n");
  const output = new Set(lines.flatMap((line) => /^\s*(?:- )?\[pid=\d+\]\[err\] (.+)$/.exec(line)?.[1] ?? []));
  return [
    reason.replace(/^browserType\.launch: /, ""),
    ...[...output].slice(-MAX_BROWSER_OUTPUT_LINES).map((line) => `  ${line}`),
  ].join("\n");
}

/** The browser receives only scene data and the public renderer, never API credentials. */
export async function renderPng(input: unknown, options: RenderOptions) {
  const scene = prepareScene(input, options.frameId);
  const { path: executablePath, kind } = await findBrowser(options.browserPath);
  // The build writes the @excalidraw/utils browser bundle and its fonts next to this file.
  const rendererSource = await readFile(new URL("./renderer.js", import.meta.url));
  const deadline = Date.now() + options.timeout;
  // Font downloads get half the deadline, which leaves time to draw with fallback glyphs if a mirror hangs.
  const fonts = createFontLoader({
    mirrors: options.fontsUrl,
    deadline: Date.now() + Math.floor(options.timeout / 2),
  });
  const browser = await (kind === "firefox" ? firefox : chromium)
    .launch({
      executablePath,
      // An installed Firefox is driven over WebDriver BiDi; Playwright's own Firefox protocol needs its patched build.
      channel: kind === "firefox" ? "moz-firefox" : undefined,
      headless: true,
      timeout: options.timeout,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[0] !== "EXCALIDRAW_API_KEY" && entry[1] !== undefined,
        ),
      ),
    })
    .catch((error: unknown) => {
      throw new Error(
        `Could not start ${kind === "firefox" ? "Firefox" : "the browser"} at ${executablePath}: ${describeLaunchError(error)}\nPass --browser-path or set EXCALIDRAW_BROWSER_PATH to use another Chrome, Chromium, Edge, or Firefox.`,
        { cause: error },
      );
    });
  let timer: NodeJS.Timeout | undefined;
  let result: Awaited<ReturnType<typeof renderInBrowser>>;

  try {
    result = await Promise.race([
      (async () => {
        const page = await browser.newPage({ serviceWorkers: "block" });
        await page.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== ORIGIN) {
            await route.abort();
          } else if (url.pathname === "/") {
            await route.fulfill({
              contentType: "text/html",
              body: '<!doctype html><meta charset="utf-8"><title>Excalidraw render</title>',
            });
          } else if (url.pathname === "/renderer.js") {
            await route.fulfill({ contentType: "text/javascript", body: rendererSource });
          } else if (FONT_PATH.test(url.pathname)) {
            // The browser only requests the fonts the scene's text needs. A missing font makes it
            // fall back to the next family. Errors after a timeout closed the page are moot.
            const font = await fonts.load(url.pathname.slice("/fonts/".length, -".woff2".length));
            await (font ? route.fulfill({ contentType: "font/woff2", body: font }) : route.abort()).catch(
              () => undefined,
            );
          } else {
            await route.abort();
          }
        });
        await page.goto(`${ORIGIN}/`);
        return page.evaluate(renderInBrowser, {
          scene,
          options,
          moduleUrl: `${ORIGIN}/renderer.js`,
        });
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Rendering timed out after ${options.timeout} ms. Try a smaller scene or increase --timeout.`,
              ),
            ),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await browser.close();
  }

  const png = Buffer.from(result.png, "base64");
  if (!png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    throw new Error(
      "The browser could not encode the scene as PNG. Try smaller output dimensions.",
    );
  }
  return { png, width: result.width, height: result.height, warning: fonts.warning() };
}
