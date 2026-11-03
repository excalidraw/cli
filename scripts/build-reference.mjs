// Writes dist/reference.json, the command reference the docs at plus.excalidraw.com/docs/cli are
// generated from (see src/reference.ts). It ships in the package, so each release carries its own.
import { build } from "esbuild";
import { rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Help text names the reader's own credentials file; the reference shows the default location instead.
process.env.XDG_CONFIG_HOME = "~/.config";

// Bundled next to main.js, because src/package.ts reads package.json from the bundle's parent folder.
const bundle = new URL("../dist/reference-build.mjs", import.meta.url);

await build({
  entryPoints: ["src/reference.ts"],
  outfile: fileURLToPath(bundle),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["playwright-core"],
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  logLevel: "warning",
});

try {
  const { createReference } = await import(bundle.href);
  await writeFile(new URL("../dist/reference.json", import.meta.url), `${JSON.stringify(createReference(), null, 2)}\n`);
} finally {
  await rm(bundle);
}
