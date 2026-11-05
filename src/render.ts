import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, firefox } from "playwright-core";
import { z } from "zod/v4";
import { findBrowser } from "./browser.js";
import { createFontLoader } from "./fonts.js";
import { PROXY_VARIABLE } from "./http.js";
import { convertMermaidInBrowser } from "./mermaid-page.js";
import { renderInBrowser, waitForEveryFontFace } from "./render-page.js";

import type { Page, Route } from "playwright-core";
import type { ImageOptions } from "./schemas.js";

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
// The font-subsetting WebAssembly SVG exports use, stored as base64 (see scripts/build-renderer.mjs).
const WASM_PATH = /^\/wasm\/\d+$/;
const RENDERER_URL = `${ORIGIN}/renderer.js`;
const MERMAID_URL = `${ORIGIN}/mermaid.js`;

const SceneSchema = z.object({
  elements: z.array(ElementSchema),
  appState: z.record(z.string(), z.unknown()).default({}),
  files: z.record(z.string(), z.object({ dataURL: z.string() }).loose()).default({}),
  filesFailedToEmbed: z.array(z.string()).optional(),
});

export type RenderElement = z.infer<typeof ElementSchema>;

export type RenderScene = Omit<z.infer<typeof SceneSchema>, "filesFailedToEmbed">;

export type RenderFormat = "png" | "svg";

/** The live elements of a scene, and the embedded files its images use. */
export function prepareScene(input: unknown): RenderScene {
  const scene = SceneSchema.parse(input);
  const elements = scene.elements.filter((element) => !element.isDeleted);
  if (elements.length === 0) {
    throw new Error("Cannot render an empty scene.");
  }
  // Only live images need their files. filesFailedToEmbed can also name files nothing uses anymore,
  // such as those of deleted images, which don't affect the render.
  const images = elements.filter((element) => element.type === "image");
  const usedFileIds = new Set(images.map((element) => element.fileId));
  const failed = scene.filesFailedToEmbed?.filter((fileId) => usedFileIds.has(fileId)) ?? [];
  if (failed.length > 0) {
    throw new Error(
      `Scene images could not be embedded: ${failed.join(", ")}. Fetch the scene again before rendering.`,
    );
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

  return { elements, appState: scene.appState, files };
}

export function findFrame(scene: RenderScene, frameId: string) {
  const frame = scene.elements.find((element) => element.id === frameId && FRAME_TYPES.has(element.type));
  if (!frame) {
    throw new Error(`Frame not found: ${frameId}`);
  }
  if (frame.width === 0 || frame.height === 0) {
    throw new Error(`Frame has no area: ${frameId}`);
  }
  return frame;
}

/**
 * The scene's frames in presentation order, as Excalidraw+ plays them as slides: by
 * customData.slidesOrder, then in scene order. Frames without area hold nothing to draw.
 */
export function orderedFrames(scene: RenderScene) {
  const slidesOrder = (frame: RenderElement) => {
    const customData = frame.customData;
    const order =
      customData && typeof customData === "object" && "slidesOrder" in customData ? customData.slidesOrder : undefined;
    return typeof order === "number" ? order : Number.MAX_SAFE_INTEGER;
  };
  const frames = scene.elements
    .filter((element) => FRAME_TYPES.has(element.type) && element.width > 0 && element.height > 0)
    .sort((a, b) => slidesOrder(a) - slidesOrder(b));
  if (frames.length === 0) {
    throw new Error("The scene has no frames to render.");
  }
  return frames;
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

type BrowserOptions = Pick<ImageOptions, "browserPath" | "timeout" | "fontsUrl">;

/** What `fn` gets from withRenderPage: the page, and a way to give the next step a full timeout. */
type RenderPage = { page: Page; restartDeadline: () => void };

/**
 * Starts a browser, opens a page that can load the renderer (and the Mermaid converter), and runs
 * `fn` in it. Startup, font downloads and `fn` share options.timeout, unless `fn` restarts the
 * deadline between steps. The browser receives only scene data and the public renderer, never API
 * credentials.
 */
async function withRenderPage<T>(options: BrowserOptions, fn: (context: RenderPage) => Promise<T>) {
  const { path: executablePath, kind } = await findBrowser(options.browserPath);
  // The build writes the @excalidraw/utils browser bundle, the Mermaid converter, its WebAssembly
  // and the fonts next to this file.
  const files = (pathname: string) =>
    pathname === "/renderer.js" || pathname === "/mermaid.js"
      ? { url: new URL(`.${pathname}`, import.meta.url), contentType: "text/javascript" }
      : WASM_PATH.test(pathname)
        ? { url: new URL(`.${pathname}.txt`, import.meta.url), contentType: "text/plain" }
        : undefined;
  // Font downloads get half the deadline, which leaves time to draw with fallback glyphs if a mirror hangs.
  const fonts = createFontLoader({
    mirrors: options.fontsUrl,
    deadline: Date.now() + Math.floor(options.timeout / 2),
  });
  // Rejects with the first reason the render can't go on: the deadline, or a file the page needs
  // that can't be read, which would otherwise leave the page waiting until the deadline.
  let fail!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  // Raced below once the browser is up; until then, a rejection has no other handler.
  failed.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const restartDeadline = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => fail(new Error(`Rendering timed out after ${options.timeout} ms. Try a smaller scene or increase --timeout.`)),
      options.timeout,
    );
  };
  restartDeadline();
  const browser = await (kind === "firefox" ? firefox : chromium)
    .launch({
      executablePath,
      // An installed Firefox is driven over WebDriver BiDi; Playwright's own Firefox protocol needs its patched build.
      channel: kind === "firefox" ? "moz-firefox" : undefined,
      headless: true,
      timeout: options.timeout,
      // Without the API key, and without proxy settings: the page gets everything through
      // page.route(), so all a proxy would see is the browser's own background requests.
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[0] !== "EXCALIDRAW_API_KEY" && !PROXY_VARIABLE.test(entry[0]) && entry[1] !== undefined,
        ),
      ),
    })
    .catch((error: unknown) => {
      clearTimeout(timer);
      throw new Error(
        `Could not start ${kind === "firefox" ? "Firefox" : "the browser"} at ${executablePath}: ${describeLaunchError(error)}\nPass --browser-path or set EXCALIDRAW_BROWSER_PATH to use another Chrome, Chromium, Edge, or Firefox.`,
        { cause: error },
      );
    });
  // Requests are answered in memory: the renderer and converter, their files, and fonts.
  const serve = async (route: Route) => {
    const url = new URL(route.request().url());
    const file = files(url.pathname);
    if (url.origin !== ORIGIN) {
      await route.abort();
    } else if (url.pathname === "/") {
      await route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><meta charset="utf-8"><title>Excalidraw render</title>',
      });
    } else if (file) {
      const body = await readFile(file.url).catch((error: NodeJS.ErrnoException) => {
        fail(
          new Error(
            `Could not read ${fileURLToPath(file.url)} (${error.code ?? error.message}). Reinstall the CLI to restore it.`,
          ),
        );
        return undefined;
      });
      await (body ? route.fulfill({ contentType: file.contentType, body }) : route.abort()).catch(
        () => undefined,
      );
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
  };

  let result: T;

  try {
    result = await Promise.race([
      (async () => {
        const page = await browser.newPage({ serviceWorkers: "block" });
        await page.route("**/*", (route) => serve(route).catch(fail));
        await page.goto(`${ORIGIN}/`);
        await page.evaluate(waitForEveryFontFace);
        return fn({ page, restartDeadline });
      })(),
      failed,
    ]);
  } finally {
    clearTimeout(timer);
    await browser.close();
  }

  return { result, warning: fonts.warning() };
}

export type RenderedImage = { data: Buffer; width: number; height: number; frame: RenderElement | null };

/** Draws the scene, or one frame of it, in the page. */
async function renderInPage(
  page: Page,
  scene: RenderScene,
  frame: RenderElement | null,
  format: RenderFormat,
  options: ImageOptions,
): Promise<RenderedImage> {
  const result = await page.evaluate(renderInBrowser, {
    scene,
    frame,
    format,
    options: {
      padding: options.padding,
      scale: options.scale,
      maxWidth: options.maxWidth,
      maxHeight: options.maxHeight,
      theme: options.theme,
      transparent: options.transparent,
    },
    moduleUrl: RENDERER_URL,
  });
  const data = format === "png" ? Buffer.from(result.data, "base64") : Buffer.from(result.data, "utf8");
  if (format === "png" && !data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    throw new Error("The browser could not encode the scene as PNG. Try smaller output dimensions.");
  }
  return { data, width: result.width, height: result.height, frame };
}

/**
 * Renders a scene, one frame of it, or each of its frames, in one browser session, and passes each
 * image to `onImage` as it's drawn. With all frames, each frame gets the whole --timeout.
 */
export async function renderScene(
  input: unknown,
  options: ImageOptions & { format: RenderFormat; frameId?: string; allFrames?: boolean },
  onImage: (image: RenderedImage, index: number, count: number) => Promise<void>,
) {
  const scene = prepareScene(input);
  const frames = options.allFrames
    ? orderedFrames(scene)
    : [options.frameId === undefined ? null : findFrame(scene, options.frameId)];
  const { warning } = await withRenderPage(options, async ({ page, restartDeadline }) => {
    for (const [index, frame] of frames.entries()) {
      if (index > 0) {
        restartDeadline();
      }
      await onImage(await renderInPage(page, scene, frame, options.format, options), index, frames.length);
    }
  });
  return { warning };
}

export type MermaidOptions = BrowserOptions & {
  elbow: boolean;
  fontSize?: number;
};

/**
 * Converts a Mermaid definition into Excalidraw elements as the editor's Mermaid import does, and
 * optionally renders the result in the same browser session.
 */
export async function convertMermaid(
  definition: string,
  options: MermaidOptions,
  render?: { format: RenderFormat; options: ImageOptions },
) {
  return withRenderPage(options, async ({ page }) => {
    const converted = await page.evaluate(convertMermaidInBrowser, {
      definition,
      config: {
        elbow: options.elbow,
        ...(options.fontSize !== undefined && { themeVariables: { fontSize: `${options.fontSize}px` } }),
      },
      mermaidUrl: MERMAID_URL,
      rendererUrl: RENDERER_URL,
    });
    if ("error" in converted) {
      throw new Error(`Could not convert the Mermaid diagram: ${converted.error}`);
    }
    const scene = {
      type: "excalidraw",
      version: 2,
      source: "https://github.com/excalidraw/cli",
      elements: converted.elements,
      appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
      files: converted.files,
    };
    const image = render ? await renderInPage(page, prepareScene(scene), null, render.format, render.options) : undefined;
    return { scene, image };
  });
}
