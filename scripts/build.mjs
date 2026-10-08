// Bundles the CLI into dist/ so installs carry no runtime dependencies besides playwright-core,
// and users get exactly the dependency versions the tests ran against.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outdir: "dist",
  bundle: true,
  // Keeps `import("../render.js")` lazy: without chunks, esbuild hoists the playwright-core import to
  // the top of the single output file and every command pays for loading it.
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  minify: true,
  external: ["playwright-core"],
  // commander is CommonJS and requires Node built-ins, which ESM output can only do through require.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  logLevel: "warning",
});
