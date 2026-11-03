import type { RenderElement, RenderFormat, RenderScene } from "./render.js";
import type { ImageOptions } from "./schemas.js";

/**
 * Serialized by Playwright and executed in the browser; keep runtime dependencies inside it.
 * Draws the scene once per entry of `frames`: the frame's contents, clipped to it, or with null the
 * whole scene. Returns PNGs as base64 and SVGs as markup.
 */
export async function renderInBrowser({
  scene,
  frames,
  format,
  options,
  moduleUrl,
}: {
  scene: RenderScene;
  frames: (RenderElement | null)[];
  format: RenderFormat;
  options: Pick<ImageOptions, "padding" | "scale" | "maxWidth" | "maxHeight" | "theme" | "transparent">;
  moduleUrl: string;
}) {
  // FontFaceSet.load() rejects as soon as one matching face fails, while the others may still be
  // loading. Excalidraw catches that rejection and draws right away, with fallback glyphs for text
  // whose font arrives moments later. Wait for every pending face before passing the failure on.
  const fonts = document.fonts;
  if (!("excalidrawPatched" in fonts)) {
    const loadFonts = fonts.load.bind(fonts);
    fonts.load = async (font, text) => {
      try {
        return await loadFonts(font, text);
      } catch (error) {
        await Promise.allSettled(
          [...fonts].filter((face) => face.status === "loading").map((face) => face.loaded),
        );
        throw error;
      }
    };
    Object.defineProperty(fonts, "excalidrawPatched", { value: true });
  }

  const { exportToCanvas, exportToSvg } = (await import(moduleUrl)) as typeof import("@excalidraw/utils/export");

  // SVG exports embed the fonts their text uses, cut down to its glyphs with WebAssembly the renderer
  // reads from this global (see scripts/build-renderer.mjs).
  const wasmGlobal = globalThis as { excalidrawSubsetWasm?: string[] };
  if (format === "svg" && !wasmGlobal.excalidrawSubsetWasm) {
    wasmGlobal.excalidrawSubsetWasm = await Promise.all(
      [0, 1].map(async (index) => (await fetch(new URL(`/wasm/${index}`, moduleUrl))).text()),
    );
  }

  // The export utility can draw a placeholder when decoding fails. Report that failure instead.
  await Promise.all(
    Object.entries(scene.files).map(async ([id, file]) => {
      const image = new Image();
      image.src = file.dataURL;
      try {
        await image.decode();
      } catch {
        throw new Error(`Could not decode embedded image: ${id}`);
      }
    }),
  );

  const theme = options.theme ?? (scene.appState.exportWithDarkMode ? "dark" : "light");
  const transparent = options.transparent || scene.appState.exportBackground === false;
  const background =
    typeof scene.appState.viewBackgroundColor === "string" ? scene.appState.viewBackgroundColor : "#ffffff";

  const results = [];
  for (const frame of frames) {
    // A frame is drawn as a clip, not as a box with its name above it.
    const elements = frame
      ? scene.elements.filter((element) => element.type !== "frame" && element.type !== "magicframe")
      : scene.elements;
    const padding = frame ? 0 : options.padding;

    if (format === "svg") {
      const svg = await exportToSvg({
        data: {
          elements,
          files: scene.files,
          appState: {
            ...scene.appState,
            exportWithDarkMode: theme === "dark",
            exportBackground: !transparent,
            viewBackgroundColor: background,
            exportScale: options.scale,
          },
        },
        // The SVG export reads the theme and background from appState; the config takes them too.
        config: { exportingFrame: frame, padding, theme, canvasBackgroundColor: transparent ? false : background },
      });
      results.push({
        data: svg.outerHTML,
        // SVG sizes are fractional; two decimals are plenty for a summary.
        width: Math.round(Number(svg.getAttribute("width")) * 100) / 100,
        height: Math.round(Number(svg.getAttribute("height")) * 100) / 100,
      });
      continue;
    }

    const canvas = await exportToCanvas({
      data: {
        elements,
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
    results.push({
      data: canvas.toDataURL("image/png").split(",")[1]!,
      width: canvas.width,
      height: canvas.height,
    });
    // Release the canvas's memory before drawing the next frame.
    canvas.width = 0;
    canvas.height = 0;
  }
  return results;
}
