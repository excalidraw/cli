/**
 * Serialized by Playwright and executed in the browser; keep runtime dependencies inside it.
 * Converts a Mermaid definition as the editor's Mermaid import does, and returns the elements and
 * files, or the parse error's message.
 */
export async function convertMermaidInBrowser({
  definition,
  config,
  mermaidUrl,
  rendererUrl,
}: {
  definition: string;
  config: { elbow: boolean; themeVariables?: { fontSize: string } };
  mermaidUrl: string;
  rendererUrl: string;
}) {
  const { parseMermaidToExcalidraw, convertToExcalidrawElements } = (await import(
    mermaidUrl
  )) as typeof import("./mermaid-bundle.js");
  const { exportToCanvas } = (await import(rendererUrl)) as typeof import("@excalidraw/utils/export");

  const parse = (text: string) => parseMermaidToExcalidraw(text, config);
  // Like the editor, retry with single quotes, which Mermaid accepts in more places than double
  // quotes, but report the original error, whose line and column match the input.
  let source = definition;
  let parsed: Awaited<ReturnType<typeof parse>> | undefined;
  try {
    parsed = await parse(source);
  } catch (error) {
    if (definition.includes('"')) {
      source = definition.replace(/"/g, "'");
      parsed = await parse(source).catch(() => undefined);
    }
    if (!parsed) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  // Pele sizes shapes to their labels, and Excalidraw wraps labels to their shapes, both measuring
  // text with the canvas. Until the labels' fonts are loaded, that measures a fallback font, so
  // shapes come out too small. The renderer loads exactly the faces a scene's text needs when it
  // draws, so draw the labels once, at a tiny size, then lay the diagram out again.
  const labels = parsed.elements.flatMap((element) => {
    const label = "label" in element ? element.label?.text : undefined;
    const text = "text" in element ? element.text : undefined;
    return [label, text].filter((value): value is string => typeof value === "string" && value !== "");
  });
  if (labels.length > 0) {
    await exportToCanvas({
      data: {
        elements: convertToExcalidrawElements([{ type: "text", x: 0, y: 0, text: labels.join("\n") }]),
        files: {},
        appState: {},
      },
      config: { getDimensions: () => ({ width: 1, height: 1, scale: 1 }) },
    });
    parsed = await parse(source);
  }

  return {
    elements: convertToExcalidrawElements(parsed.elements, { regenerateIds: true }) as unknown[],
    files: (parsed.files ?? {}) as Record<string, { dataURL: string }>,
  };
}
