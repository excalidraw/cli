// Entry point of dist/mermaid.js, the browser bundle `excalidraw mermaid` loads next to the renderer
// (see scripts/build-mermaid.mjs). mermaid-to-excalidraw needs DOM APIs such as DOMParser, and
// turning its skeletons into elements measures text with the canvas, so both run in the browser.
// @ts-expect-error The package's index declarations re-export modules without file extensions,
// which NodeNext resolution doesn't follow, so TypeScript sees no exports. The runtime has them.
import { convertToExcalidrawElements as convert, getBindingGap } from "@excalidraw/element";

import type { convertToExcalidrawElements as Convert } from "@excalidraw/element/transform";

export { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";

export const convertToExcalidrawElements: typeof Convert = (skeletons, options) => {
  const elements: ReturnType<typeof Convert> = convert(skeletons, options);
  const byId = new Map(elements.map((element) => [element.id, element]));
  for (const element of elements) {
    if (element.type !== "arrow" || element.elbowed) {
      continue;
    }
    for (const binding of [element.startBinding, element.endBinding]) {
      if (binding?.mode !== "orbit" || "gap" in binding) {
        continue;
      }
      const target = byId.get(binding.elementId);
      if (target) {
        // SDK 0.18.1 uses gap when moving a bound shape. Keep the newer binding
        // fields too, so current editors still use their orbit behavior.
        Object.assign(binding, { gap: getBindingGap(target) });
      }
    }
  }
  return elements;
};
