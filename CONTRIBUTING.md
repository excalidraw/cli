# Contributing

You need Node.js 22.18+ or 24+ and pnpm. The tests are TypeScript files run directly by Node's built-in test runner, which relies on type stripping from those versions. The published CLI still supports Node.js 22.

```bash
pnpm install
pnpm run build       # typecheck src/, then bundle it into dist/
pnpm run typecheck   # typecheck src/ and test/
```

esbuild bundles `src/` with chalk, commander and zod into `dist/main.js` plus lazily loaded chunks, so playwright-core is the only runtime dependency. Keep those libraries in `devDependencies`. playwright-core is pinned to an exact version because it drives whatever Chrome the user has installed; bump it on purpose and run `pnpm run test:render` before releasing. The build also turns the prebuilt browser bundle from `@excalidraw/utils` into `dist/renderer.js` (see `scripts/build-renderer.mjs`), so users don't install the whole package. Its inlined fonts become files in `dist/fonts/` that the browser requests only when a scene needs them, and the font-subsetting WebAssembly, which only SVG export uses, is dropped. Xiaolai, the 13 MB CJK font, doesn't ship: `dist/fonts/remote.json` lists its files, which the CLI downloads from CDN mirrors on first use, checks against their sha256, and caches. `scripts/fonts.json` identifies each font by sha256 and gives its path in the `@excalidraw/excalidraw` release the mirrors serve.

To update the renderer, bump its pinned version in `devDependencies`, run `node scripts/update-fonts.mjs @excalidraw/excalidraw@<version>` with a release that ships the same fonts, and rebuild. The build fails if the bundle's layout changed.

## Tests

```bash
pnpm run test
```

This builds the package, typechecks the tests, and runs the offline suite against `dist/main.js` with a mock API. It needs no credentials.

### Rendering

```bash
pnpm run test:render
EXCALIDRAW_BROWSER_PATH=/path/to/chromium pnpm run test:render   # if no browser is found
```

These render local fixtures and scenes from a mock API with an installed Chrome, Chromium or Edge, then check PNG dimensions and pixels. Run them once more with `EXCALIDRAW_BROWSER_PATH=/path/to/firefox` when you touch the renderer, since Firefox is the fallback. Font downloads go to a local mock mirror with a temporary cache, so the tests never use the network or your font cache.

`pnpm run bench` (after a build) times complete commands and reports package and install sizes; add `--install` to measure a real install with dependencies.

### Live API

```bash
EXCALIDRAW_API_URL="https://api.excalidraw.com" \
EXCALIDRAW_API_KEY="your_api_key" \
pnpm run test:e2e
```

The e2e suite runs real commands against a live workspace and deletes the resources it creates. It is skipped unless both variables are set. Invite and log commands need admin rights, so use a workspace key with full permissions or a personal key that belongs to an admin. Set `EXCALIDRAW_E2E_DEBUG=1` to print a summary of each response.

## CI

Every pull request runs the offline, rendering (with Chrome) and live API tests on Node 22. The live API tests use the test workspace key from the `EXCALIDRAW_E2E_API_KEY` secret, and `EXCALIDRAW_API_URL` from a repository variable if set. Pull requests from forks don't get the key, so their live API tests skip; a maintainer can push a fork's changes to a branch here to run them.
