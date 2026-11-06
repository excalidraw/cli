import type { RenderElement, RenderFormat, RenderScene } from "./render.js";
import type { ImageOptions } from "./schemas.js";

/**
 * Serialized by Playwright and executed in the page before any export or Mermaid conversion.
 * FontFaceSet.load() rejects as soon as one matching face fails, while the others may still be
 * loading. Excalidraw and Pele catch that rejection and measure or draw right away, with fallback
 * glyphs for text whose font arrives moments later. Wait for every pending face before passing the
 * failure on.
 */
export function waitForEveryFontFace() {
  const fonts = document.fonts;
  // Excalidraw skips loading a family when check() reports it available. Chromium also reports it
  // available when a system font has the same name (e.g. a locally installed Excalifont), and then
  // draws with a fallback font while the bundled face is still loading. Always load instead.
  fonts.check = () => false;
  const loadFonts = fonts.load.bind(fonts);
  fonts.load = async (font, text) => {
    try {
      return await loadFonts(font, text);
    } catch (error) {
      await Promise.allSettled([...fonts].filter((face) => face.status === "loading").map((face) => face.loaded));
      throw error;
    }
  };
}

/**
 * Serialized by Playwright and executed in the browser; keep runtime dependencies inside it.
 * Draws the frame's contents, clipped to it, or with null the whole scene. Returns a PNG as base64
 * or an SVG as markup.
 */
export async function renderInBrowser({
  scene,
  frame,
  format,
  options,
  moduleUrl,
}: {
  scene: RenderScene;
  frame: RenderElement | null;
  format: RenderFormat;
  options: Pick<ImageOptions, "padding" | "scale" | "maxWidth" | "maxHeight" | "theme" | "transparent">;
  moduleUrl: string;
}) {
  const { exportToCanvas, exportToSvg } = (await import(moduleUrl)) as typeof import("@excalidraw/utils/export");

  // SVG exports embed the fonts their text uses, cut down to its glyphs with WebAssembly the renderer
  // reads from this global, as base64 (see scripts/build-renderer.mjs).
  const wasmGlobal = globalThis as { excalidrawSubsetWasm?: string[] };
  if (format === "svg" && !wasmGlobal.excalidrawSubsetWasm) {
    wasmGlobal.excalidrawSubsetWasm = await Promise.all(
      [0, 1].map(async (index) => (await fetch(new URL(`/wasm/${index}`, moduleUrl))).text()),
    );
  }

  // The export utility can draw a placeholder when decoding fails. Report that failure instead.
  // Frames of one scene are drawn in turn, so each image is checked once.
  const checked = ((globalThis as { excalidrawDecodedFiles?: Set<string> }).excalidrawDecodedFiles ??= new Set());
  await Promise.all(
    Object.entries(scene.files)
      .filter(([id]) => !checked.has(id))
      .map(async ([id, file]) => {
        const image = new Image();
        image.src = file.dataURL;
        try {
          await image.decode();
        } catch {
          throw new Error(`Could not decode embedded image: ${id}`);
        }
        checked.add(id);
      }),
  );

  const theme = options.theme ?? (scene.appState.exportWithDarkMode ? "dark" : "light");
  const transparent = options.transparent || scene.appState.exportBackground === false;
  const background =
    typeof scene.appState.viewBackgroundColor === "string" ? scene.appState.viewBackgroundColor : "#ffffff";
  // exportingFrame keeps the frame's outline and name out of the image. Frame elements stay in the
  // scene: an SVG clips the frame's children with a clip path made from them.
  const padding = frame ? 0 : options.padding;

  if (format === "svg") {
    const svg = await exportToSvg({
      data: {
        elements: scene.elements,
        files: scene.files,
        // The SVG export reads the theme and background from appState.
        appState: {
          ...scene.appState,
          exportWithDarkMode: theme === "dark",
          exportBackground: !transparent,
          viewBackgroundColor: background,
          exportScale: options.scale,
          // The embedded scene would be the whole scene, not the frame.
          ...(frame && { exportEmbedScene: false }),
        },
      },
      // Its config type requires theme and canvasBackgroundColor, which the SVG export ignores.
      config: { exportingFrame: frame, padding, theme, canvasBackgroundColor: transparent ? false : background },
    });
    return {
      // outerHTML is HTML: it writes a non-breaking space as &nbsp;, which XML parsers reject.
      data: new XMLSerializer().serializeToString(svg),
      // SVG sizes are fractional; two decimals are plenty for a summary.
      width: Math.round(Number(svg.getAttribute("width")) * 100) / 100,
      height: Math.round(Number(svg.getAttribute("height")) * 100) / 100,
    };
  }

  const canvas = await exportToCanvas({
    data: {
      elements: scene.elements,
      files: scene.files,
      appState: { ...scene.appState, exportWithDarkMode: theme === "dark" },
    },
    config: {
      exportingFrame: frame,
      canvasBackgroundColor: transparent ? false : background,
      theme,
      padding,
      fit: "none",
      position: "topLeft",
      getDimensions: (width: number, height: number) => {
        const paddedWidth = Math.max(1, width + padding * 2);
        const paddedHeight = Math.max(1, height + padding * 2);
        if (!Number.isFinite(paddedWidth) || !Number.isFinite(paddedHeight)) {
          throw new Error("Scene bounds are too large to render.");
        }
        const scale = Math.min(
          options.scale,
          options.maxWidth / paddedWidth,
          options.maxHeight / paddedHeight,
          Math.sqrt(64_000_000 / (paddedWidth * paddedHeight)),
        );
        if (!Number.isFinite(scale) || scale <= 0) {
          throw new Error("Scene bounds are too large to render.");
        }
        // Account for the padding and scale the renderer applies after this callback. The canvas
        // truncates its size, so aim half a pixel higher: rounding errors in the round trip could
        // otherwise turn a 1-pixel side into 0.
        return {
          width: (Math.max(1, Math.floor(paddedWidth * scale)) + 0.5) / scale - padding * 2,
          height: (Math.max(1, Math.floor(paddedHeight * scale)) + 0.5) / scale - padding * 2,
          scale,
        };
      },
    },
  });
  const data = canvas.toDataURL("image/png").split(",")[1]!;
  const result = { data, width: canvas.width, height: canvas.height };
  // Release the canvas's memory before the next frame is drawn.
  canvas.width = 0;
  canvas.height = 0;
  return result;
}
