# Render to PNG or SVG

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
| `--max-width`, `--max-height` | `16384` | Shrink the PNG to fit these sizes in pixels. |
| `--padding <px>` | `20` | Ignored for frames. |
| `--theme <light\|dark>` | scene setting | |
| `--transparent` | off | Transparent background. |
| `--timeout <ms>` | `30000` | How long a render may take. |

- Images must be embedded in the file. Image URLs and website embeds aren't loaded.
- PNGs keep the scene's aspect ratio and stay under 64 megapixels. When a limit makes a PNG smaller than `--scale` asks for, the command prints a warning. SVGs have no size limit.
- Chinese, Japanese and Korean text in the hand-drawn font, Excalifont, is drawn in Xiaolai, which is downloaded the first time a scene uses it, then cached. Without network access, that text uses a system font. As in Excalidraw itself, CJK text in the other fonts, such as Virgil or Comic Shanns, always uses a system font. See [CJK fonts](#cjk-fonts) for proxies, mirrors and offline use.
- Emoji come from your system's fonts.

## CJK fonts

The CLI downloads Xiaolai's files from Excalidraw's CDN and checks each against its SHA-256. When the CDN fails or doesn't answer in time, it tries [npmmirror](https://npmmirror.com), then jsDelivr. If every download fails, the command still renders and prints a warning naming the reason.

- Behind a proxy, set `HTTPS_PROXY` (or `HTTP_PROXY`) as you would for curl; a value without a scheme, such as `proxy.corp:8080`, is an HTTP proxy. `NO_PROXY` lists hosts to reach directly. This applies to API requests and the update check too. `socks5://` URLs work as well, though Node prints a warning that its SOCKS support is experimental. Other proxies, such as `socks4://`, are skipped with a warning.
- `--fonts-url` (or `EXCALIDRAW_FONTS_URL`) replaces the download locations with your own: comma-separated URLs that mirror `@excalidraw/excalidraw@0.18.1`'s `dist/prod/` folder, or `none` to turn downloads off.
- For offline use, point `--fonts-url` at a local copy of that folder. Files are read from it directly, not copied to the cache:

```bash
mkdir -p ~/excalidraw-fonts && cd ~/excalidraw-fonts
npm pack @excalidraw/excalidraw@0.18.1 --registry https://registry.npmmirror.com
tar -xzf excalidraw-excalidraw-0.18.1.tgz
export EXCALIDRAW_FONTS_URL=~/excalidraw-fonts/package/dist/prod
```
