import type { RenderScene } from "./render.js";
import type { RenderOptions } from "./schemas.js";

/** Serialized by Playwright and executed in the browser; keep runtime dependencies inside it. */
export async function renderInBrowser({
  scene,
  options,
  moduleUrl,
}: {
  scene: RenderScene;
  options: RenderOptions;
  moduleUrl: string;
}) {
  // FontFaceSet.load() rejects as soon as one matching face fails, while the others may still be
  // loading. Excalidraw catches that rejection and draws right away, with fallback glyphs for text
  // whose font arrives moments later. Wait for every pending face before passing the failure on.
  const fonts = document.fonts;
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

  const { exportToCanvas } = (await import(moduleUrl)) as typeof import("@excalidraw/utils/export");

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

  const padding = scene.frame ? 0 : options.padding;
  const theme = options.theme ?? (scene.appState.exportWithDarkMode ? "dark" : "light");
  const transparent = options.transparent || scene.appState.exportBackground === false;
  const canvas = await exportToCanvas({
    data: {
      elements: scene.elements,
      files: scene.files,
      appState: { ...scene.appState, exportWithDarkMode: theme === "dark" },
    },
    config: {
      exportingFrame: scene.frame,
      canvasBackgroundColor: transparent
        ? false
        : typeof scene.appState.viewBackgroundColor === "string"
          ? scene.appState.viewBackgroundColor
          : "#ffffff",
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

  return {
    png: canvas.toDataURL("image/png").split(",")[1],
    width: canvas.width,
    height: canvas.height,
  };
}
