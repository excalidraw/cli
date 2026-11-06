// Entry point of dist/mermaid.js, the browser bundle `excalidraw mermaid` loads next to the renderer
// (see scripts/build-mermaid.mjs). mermaid-to-excalidraw needs DOM APIs such as DOMParser, and
// turning its skeletons into elements measures text with the canvas, so both run in the browser.
// @ts-expect-error The package's index declarations re-export modules without file extensions,
// which NodeNext resolution doesn't follow, so TypeScript sees no exports. The runtime has them.
import { convertToExcalidrawElements as convert } from "@excalidraw/element";

import type { convertToExcalidrawElements as Convert } from "@excalidraw/element/transform";

export { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";

export const convertToExcalidrawElements: typeof Convert = convert;
