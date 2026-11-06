// Bundles src/mermaid-bundle.ts into dist/mermaid.js, the browser module `excalidraw mermaid` loads
// next to dist/renderer.js. Pele lays diagrams out with code per diagram type that it imports on
// first use; without code splitting, esbuild keeps that code in this one file, which the browser
// only fetches for Mermaid conversions.
import { build } from "esbuild";

await build({
  entryPoints: ["src/mermaid-bundle.ts"],
  outfile: "dist/mermaid.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome110", "firefox115"],
  minify: true,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
  conditions: ["production"],
  logLevel: "warning",
});
