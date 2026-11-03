# Excalidraw CLI

[![npm](https://img.shields.io/npm/v/@excalidraw/cli)](https://www.npmjs.com/package/@excalidraw/cli)
[![license](https://img.shields.io/npm/l/@excalidraw/cli)](LICENSE)

Manage your [Excalidraw+](https://plus.excalidraw.com) workspace from the terminal, render any `.excalidraw` file to PNG or SVG, and turn Mermaid diagrams into Excalidraw scenes. Rendering and Mermaid conversion run locally and need no account.

```console
$ excalidraw scenes list --limit 3 -o table
ID                    NAME                 COLLECTION            PINNED  UPDATED
k3Vn8QpLx2RtY7wZbC4d  Architecture sketch  f9Hs2KdLm4NqP8rTvX1a  yes     2026-09-21T14:03:11.000Z
Qm7Tz1XcV5bN9kLp3HsA  Sprint board         f9Hs2KdLm4NqP8rTvX1a  no      2026-09-20T09:41:52.000Z
w2Ej6YhRu8IoP4aSd0Fg  Onboarding flow      Lr5Tg7YhUj3IkO9pWe2q  no      2026-09-18T16:27:05.000Z
```

Output is JSON by default, so it works with `jq`, shell scripts and AI agents.

## Install

```bash
npm install -g @excalidraw/cli
```

Or try it without installing: `npx @excalidraw/cli --help`. Requires Node.js 22 or newer.

To update, run `excalidraw update`. It installs the latest version with the package manager you installed the CLI with: npm, pnpm, yarn, bun or Volta. `excalidraw update --check` only reports whether a newer version is out.

Commands you run in a terminal check for a newer version at most once a day, while the command runs, and mention it after the output. Set `EXCALIDRAW_NO_UPDATE_NOTIFIER=1` to turn this off.

## Quick start

Workspace commands need an Excalidraw+ API key. The [authentication docs](https://plus.excalidraw.com/docs/api/authentication) explain how to create one.

```bash
# Paste your API key once; later commands use it
excalidraw login

# Check which workspace the key belongs to
excalidraw whoami

# Create a collection, then a scene in it from a local file
excalidraw collections create --name "Product diagrams"
excalidraw scenes create --name "Architecture" --collection-id <collectionId> --file drawing.excalidraw

# Save a scene's content, or render it straight to PNG
excalidraw scenes content get <sceneId> --out scene.json
excalidraw scenes render <sceneId> --out scene.png

# Share it with anyone who has the link
excalidraw scenes share <sceneId> --access view
```

Every command has `--help` with examples, for instance `excalidraw scenes content patch --help`.

## Render to PNG or SVG

`render` turns a local file into a PNG or SVG, no API key needed. `scenes render` does the same for a scene in your workspace.

```bash
excalidraw render drawing.excalidraw --out drawing.png
excalidraw render drawing.excalidraw --out drawing.svg --theme dark
cat drawing.excalidraw | excalidraw render - --out drawing.png
excalidraw scenes render <sceneId> --frame-id <frameId> --out frame.png
```

The format follows the `--out` extension, `.png` or `.svg`, or `--format`. SVGs embed the fonts their text uses, cut down to the characters it needs, so they look the same wherever they're opened.

`--all-frames` renders each frame to its own file, for example a deck's slides. Files are numbered in presentation order and named after their frames, and the command prints them as JSON:

```bash
excalidraw scenes render <sceneId> --all-frames --out slides/
# slides/01-title.png, slides/02-agenda.png, ...
```

With a file path, the command prints the image's path and dimensions as JSON. Pass `--out -` to write the image to stdout instead, for example to pipe it into another program:

```bash
node generate-scene.js | excalidraw render - --out - > drawing.png
excalidraw scenes render <sceneId> --out - | magick png:- -resize 50% preview.png
```

Rendering uses a browser that's already installed: Chrome, Edge or Chromium, or Firefox (slower) if none of those is. The CLI doesn't download one. If it can't find yours, pass `--browser-path` or set `EXCALIDRAW_BROWSER_PATH`.

| Option | Default | Notes |
| --- | --- | --- |
| `--out <file>` | required | File path, or `-` for stdout. A directory with `--all-frames`. |
| `--format <png\|svg>` | `--out` extension, else `png` | |
| `--frame-id <id>` | | Render just this frame. |
| `--all-frames` | off | Render each frame to its own file in the `--out` directory. |
| `--scale <n>` | `1` | Resolution multiplier, up to 16. |
| `--max-width`, `--max-height` | `2048` | PNG size limits in pixels, up to 16384. Raise them along with `--scale`. |
| `--padding <px>` | `20` | Ignored for frames. |
| `--theme <light\|dark>` | scene setting | |
| `--transparent` | off | Transparent background. |
| `--timeout <ms>` | `30000` | How long a render may take. |

- Images must be embedded in the file. Image URLs and website embeds aren't loaded.
- PNGs keep the scene's aspect ratio and stay under 64 megapixels.
- Chinese, Japanese and Korean text in the hand-drawn font, Excalifont, is drawn in Xiaolai, which is downloaded the first time a scene uses it, then cached. Without network access, that text uses a system font. As in Excalidraw itself, CJK text in the other fonts, such as Virgil or Comic Shanns, always uses a system font. See [CJK fonts](#cjk-fonts) for proxies, mirrors and offline use.
- Emoji come from your system's fonts.

### CJK fonts

The CLI downloads Xiaolai's files from Excalidraw's CDN, then [npmmirror](https://npmmirror.com), then jsDelivr, whichever answers first, and checks each file against its SHA-256. If a download fails, the command still renders and prints a warning naming the reason.

- Behind a proxy, set `HTTPS_PROXY` (or `HTTP_PROXY`) as you would for curl. `NO_PROXY` lists hosts to reach directly. This applies to API requests and the update check too. SOCKS proxies aren't supported.
- `--fonts-url` (or `EXCALIDRAW_FONTS_URL`) replaces the download locations with your own: comma-separated URLs that mirror `@excalidraw/excalidraw@0.18.1`'s `dist/prod/` folder, or `none` to turn downloads off.
- For offline use, point `--fonts-url` at a local copy of that folder. Files are read from it directly, not copied to the cache:

```bash
mkdir -p ~/excalidraw-fonts && cd ~/excalidraw-fonts
npm pack @excalidraw/excalidraw@0.18.1 --registry https://registry.npmmirror.com
tar -xzf excalidraw-excalidraw-0.18.1.tgz
export EXCALIDRAW_FONTS_URL=~/excalidraw-fonts/package/dist/prod
```

## Mermaid diagrams

`mermaid` converts a [Mermaid](https://mermaid.js.org) definition into editable Excalidraw shapes and arrows, as the editor's Mermaid import does, and saves it as a scene or renders it. Diagrams are laid out by [Pele](https://pele.run). It runs locally with the same browser as `render`, no API key needed.

```bash
excalidraw mermaid flow.mmd --out flow.excalidraw
excalidraw mermaid flow.mmd --out flow.svg --elbow
echo "graph LR; A-->B" | excalidraw mermaid - --out - > flow.excalidraw

# Put the result in your workspace
excalidraw mermaid flow.mmd --out flow.excalidraw
excalidraw scenes create --name "Flow" --collection-id <collectionId> --file flow.excalidraw
```

- The format follows the `--out` extension (`.excalidraw`, `.json`, `.png`, `.svg`) or `--format`.
- Flowcharts (including `swimlane-beta`), sequence, class, ER and state diagrams become editable elements. Other types, such as gantt and pie, become one image.
- `--elbow` draws flowchart edges and state transitions as elbow arrows. `--font-size` sets the text size (default 20).
- The `render` image options, such as `--scale` and `--theme`, apply to PNG and SVG output.
- A syntax error fails the command with the line to fix.

## Commands

| Command | What it does |
| --- | --- |
| `login` | Check an API key and save it for later commands |
| `logout` | Remove the saved API key |
| `whoami` | Show the workspace, key type, credential source and API origin in use |
| `scenes` | List, create, rename, move, pin and trash scenes |
| `scenes share` | Turn a scene's public view or edit link on or off |
| `scenes share-slides` | Share a scene's frames as a presentation link |
| `scenes content` | Read, replace or patch a scene's drawing |
| `scenes render` | Render a workspace scene to PNG or SVG |
| `render` | Render a local file to PNG or SVG |
| `mermaid` | Convert a Mermaid diagram into an Excalidraw scene, PNG or SVG |
| `collections` | Manage collections and the scenes in them |
| `workspace` | Read or update the workspace name and picture |
| `workspace users` | List, update or remove members |
| `workspace invites` | Manage email invites and invite links |
| `logs` | Query the workspace audit log |
| `update` | Update the CLI to the latest version |

Updating the workspace, and the `users`, `invites` and `logs` commands, need admin rights. A personal key that belongs to a member gets `HTTP 403`.

## Editing scene content

`scenes content put` replaces the whole scene with your file, so elements missing from the file are removed. Use it when the file is the source of truth. The file only needs `elements`; missing fields such as `version` and `appState` are filled in.

`scenes content patch` merges a partial payload into the stored scene:

- Elements merge by ID, and the higher `version` wins. Send an element with `isDeleted: true` to remove it.
- Files are added or replaced by ID.
- From `appState`, only `viewBackgroundColor` and `lockedMultiSelections` are stored.

```bash
echo '{"appState":{"viewBackgroundColor":"#f8f9fa"}}' | excalidraw scenes content patch <sceneId> --file -
```

`scenes create --file` creates a scene and fills it in one step, from a full export or a partial payload like the one above. An invalid file is rejected before the scene is created. If writing the content fails afterwards, the error names the new scene so you can retry.

## Scripting and agents

- Commands print JSON, except `login` and `logout`, which print a confirmation. `-o table` prints list commands, `whoami` and `update` as a table.
- Set `EXCALIDRAW_API_KEY` rather than running `login`, which asks for the key in a terminal. `excalidraw login --api-key <key>` saves a key without asking.
- Lists return 5 items by default (50 for logs), up to 100 with `--limit`. `--all` fetches every page.
- `--raw` prints the API's response text as received, and shows API errors in full.
- `-` as a file path reads from stdin for inputs (`render -`, `--file -`) and writes to stdout for `--out`.
- Rate-limited and failed read requests are retried, see `--retries` and `--request-timeout`. Retry notices go to stderr, so stdout stays parseable.
- Any error exits with status 1.
- The update check only runs when stdout and stderr are both a terminal, and never in CI (`CI` set), so it doesn't touch piped output or slow down scripts.

## Configuration

These flags can also be set with environment variables.

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--api-key` | `EXCALIDRAW_API_KEY` | key saved by `login` |
| `--api-url` | `EXCALIDRAW_API_URL` | `https://api.excalidraw.com` |
| `-o, --output` | `EXCALIDRAW_OUTPUT` | `json` |
| `--retries` | `EXCALIDRAW_RETRIES` | `3` |
| `--request-timeout` | `EXCALIDRAW_REQUEST_TIMEOUT` | `60000` ms |
| `--browser-path` | `EXCALIDRAW_BROWSER_PATH` | detected |
| `--fonts-url` | `EXCALIDRAW_FONTS_URL` | Excalidraw's CDN, npmmirror, jsDelivr |

For a self-hosted or staging instance, set `--api-url` to the origin, without `/api/v1`.

Requests go through the proxy `HTTPS_PROXY` or `HTTP_PROXY` names, except to hosts `NO_PROXY` lists.

### API keys

There are two kinds of API key. Workspace keys act for the whole workspace. They can't see private scenes, so `scenes create` needs a real collection ID. Personal keys start with `uk-` and act as one user, with that user's role. They can pass `private` as the collection ID to use the owner's private collection. Run `excalidraw whoami` to see which kind you're using.

`excalidraw login` asks how to sign in (an API key for now; OAuth is coming), checks the key against the API and saves it. A key the API rejects isn't saved. Commands use the saved key when neither `--api-key` nor `EXCALIDRAW_API_KEY` is set; `whoami` reports which one is in use as `credentialSource` (`flag`, `env` or `login`).

Keys are saved per API origin, so a staging key is only sent to staging: `excalidraw login --api-url https://staging.example.com` saves one next to your production key. They live in `~/.config/excalidraw-cli/credentials.json` (`$XDG_CONFIG_HOME` if set, `%APPDATA%` on Windows), readable only by you. `excalidraw logout` removes the key for the origin; to revoke the key itself, delete it in Excalidraw+.

The full API reference lives at [plus.excalidraw.com/docs/api](https://plus.excalidraw.com/docs/api).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for building the CLI and running the tests.

## License

[MIT](LICENSE)
