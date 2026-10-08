// Turns the prebuilt @excalidraw/utils browser bundle into dist/renderer.js. Users don't install the
// whole package (development build, font assets, dependencies), and the bundle is slimmed down:
//
// - Every inlined font becomes dist/fonts/<sha256>.woff2, served by render.ts on request. The
//   browser parses ~0.5 MB of module instead of ~20 MB and only fetches the fonts a scene uses.
// - Xiaolai (CJK, 12.7 MB of the 13 MB of fonts) doesn't ship. dist/fonts/remote.json lists its
//   files, which the CLI downloads from CDNs on first use, checks against the sha256, and caches.
// - The font-subsetting WebAssembly is dropped. Excalidraw only uses it to embed fonts in SVG exports.
// - Xiaolai, the CJK fallback behind Excalifont, stops claiming characters Excalifont already has.
//   document.fonts.load() loads every face whose unicode-range matches the text, in every family
//   of the font stack, so "€" would otherwise load a Xiaolai file whose glyph is never drawn.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { FONT_DATA_URL, readUtilsBundle, sha256 } from "./embedded-fonts.mjs";

// render.ts serves this origin to the browser.
const ORIGIN = "http://excalidraw-renderer.local";
const REMOTE_FAMILIES = new Set(["Xiaolai"]);

const manifest = JSON.parse(await readFile(new URL("fonts.json", import.meta.url), "utf8"));
const familyOf = (hash) => manifest.fonts[hash]?.split("/")[1];

const fonts = new Map();
let source = (await readUtilsBundle()).replace(FONT_DATA_URL, (_, base64) => {
  const bytes = Buffer.from(base64, "base64");
  const hash = sha256(bytes);
  if (!familyOf(hash)) {
    throw new Error(`Embedded font ${hash} is missing from scripts/fonts.json. Run scripts/update-fonts.mjs.`);
  }
  fonts.set(hash, bytes);
  return `"${ORIGIN}/fonts/${hash}.woff2"`;
});
expect("fonts in scripts/fonts.json", fonts.size, Object.keys(manifest.fonts).length);

// WebAssembly binaries start with "\0asm", which is "AGFzbQ" in base64.
let wasm = 0;
source = source.replace(/"AGFzbQ[A-Za-z0-9+/=]*"/g, () => {
  wasm += 1;
  return '""';
});
expect("font-subsetting WebAssembly modules", wasm, 2);

// Font faces are declared as {uri:<variable>,descriptors:{unicodeRange:"..."}}.
const urlVariables = new Map(
  [...source.matchAll(/([\w$]+)="[^"]*\/fonts\/([0-9a-f]{64})\.woff2"/g)].map(([, name, hash]) => [name, hash]),
);
const FACE = /\{uri:([\w$]+),descriptors:\{unicodeRange:"([^"]+)"\}\}/g;
const faceFamily = (variable) => familyOf(urlVariables.get(variable));
const excalifontFaces = [...source.matchAll(FACE)].filter(([, variable]) => faceFamily(variable) === "Excalifont");
expect("Excalifont faces", excalifontFaces.length, countFamily("Excalifont"));
const excalifont = excalifontFaces.flatMap(([, , range]) => parseRanges(range));
let xiaolaiFaces = 0;
source = source.replace(FACE, (face, variable, range) => {
  if (faceFamily(variable) !== "Xiaolai") {
    return face;
  }
  xiaolaiFaces += 1;
  const remaining = subtractRanges(parseRanges(range), excalifont);
  if (remaining.length === 0) {
    throw new Error(`Excalifont covers a whole Xiaolai face (${range}).`);
  }
  return `{uri:${variable},descriptors:{unicodeRange:"${formatRanges(remaining)}"}}`;
});
expect("Xiaolai faces", xiaolaiFaces, countFamily("Xiaolai"));

const dist = new URL("../dist/", import.meta.url);
await mkdir(new URL("fonts/", dist), { recursive: true });
const remote = {};
for (const [hash, bytes] of fonts) {
  if (REMOTE_FAMILIES.has(familyOf(hash))) {
    remote[hash] = manifest.fonts[hash];
  } else {
    await writeFile(new URL(`fonts/${hash}.woff2`, dist), bytes);
  }
}
await writeFile(new URL("fonts/remote.json", dist), JSON.stringify({ release: manifest.release, fonts: remote }));
await writeFile(new URL("renderer.js", dist), source, "latin1");

function expect(what, actual, expected) {
  if (actual !== expected) {
    throw new Error(`Expected ${expected} ${what} in the @excalidraw/utils bundle, found ${actual}. Its layout changed; update scripts/build-renderer.mjs.`);
  }
}

function countFamily(family) {
  return Object.values(manifest.fonts).filter((path) => path.split("/")[1] === family).length;
}

function parseRanges(value) {
  return value.split(",").map((part) => {
    const match = /^U\+([0-9a-f]+)(?:-([0-9a-f]+))?$/i.exec(part.trim());
    if (!match) {
      throw new Error(`Unsupported unicode-range "${part}".`);
    }
    return [parseInt(match[1], 16), parseInt(match[2] ?? match[1], 16)];
  });
}

function subtractRanges(ranges, holes) {
  return holes.reduce(
    (kept, [holeStart, holeEnd]) =>
      kept.flatMap(([start, end]) =>
        end < holeStart || start > holeEnd
          ? [[start, end]]
          : [
              ...(start < holeStart ? [[start, holeStart - 1]] : []),
              ...(end > holeEnd ? [[holeEnd + 1, end]] : []),
            ],
      ),
    ranges,
  );
}

function formatRanges(ranges) {
  return ranges
    .map(([start, end]) => (start === end ? `U+${start.toString(16)}` : `U+${start.toString(16)}-${end.toString(16)}`))
    .join(",");
}
