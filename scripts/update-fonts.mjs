// Regenerates scripts/fonts.json after bumping @excalidraw/utils:
//
//   node scripts/update-fonts.mjs @excalidraw/excalidraw@0.18.1
//
// The manifest maps the sha256 of every font embedded in the @excalidraw/utils bundle to its path
// in an @excalidraw/excalidraw release that ships the same bytes. The build uses the path's
// directory as the font family, and the CLI downloads remote fonts from CDNs that mirror that
// release under the same path. Pick a release whose fonts match; the script fails otherwise.
import { writeFile } from "node:fs/promises";
import { FONT_DATA_URL, readUtilsBundle, sha256 } from "./embedded-fonts.mjs";

const release = process.argv[2];
if (!release?.startsWith("@excalidraw/excalidraw@")) {
  throw new Error("Usage: node scripts/update-fonts.mjs @excalidraw/excalidraw@<version>");
}

const response = await fetch(`https://data.jsdelivr.com/v1/packages/npm/${release}?structure=flat`);
if (!response.ok) {
  throw new Error(`Could not list ${release}: HTTP ${response.status}`);
}
const paths = new Map();
for (const file of (await response.json()).files) {
  if (file.name.startsWith("/dist/prod/fonts/")) {
    paths.set(Buffer.from(file.hash, "base64").toString("hex"), file.name.slice("/dist/prod/".length));
  }
}

const fonts = {};
for (const [, base64] of (await readUtilsBundle()).matchAll(FONT_DATA_URL)) {
  const hash = sha256(Buffer.from(base64, "base64"));
  const path = paths.get(hash);
  if (!path) {
    throw new Error(`An embedded font (sha256 ${hash}) is not part of ${release}.`);
  }
  fonts[hash] = path;
}

const sorted = Object.fromEntries(Object.entries(fonts).sort(([, a], [, b]) => a.localeCompare(b)));
await writeFile(
  new URL("fonts.json", import.meta.url),
  `${JSON.stringify({ release, fonts: sorted }, null, 2)}\n`,
);
console.log(`Wrote ${Object.keys(sorted).length} fonts from ${release}.`);
