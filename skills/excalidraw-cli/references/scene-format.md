# Scene JSON

Read this before writing elements. The CLI accepts a loose document, then `@excalidraw/utils` 0.1.5 (bundled with CLI 0.2.0) restores defaults and draws. A file can pass the CLI and still render blank, because unknown element types are dropped with no error.

Copy a starting point from `assets/` rather than writing a scene from a blank object:

- [assets/labeled-rectangle.excalidraw](../assets/labeled-rectangle.excalidraw) — one shape and its label
- [assets/arrow-between-shapes.excalidraw](../assets/arrow-between-shapes.excalidraw) — two shapes and an arrow
- [assets/frame.excalidraw](../assets/frame.excalidraw) — a frame and a child
- [assets/patch-update-and-delete.json](../assets/patch-update-and-delete.json) — a patch body

## Contents

- [Which command checks what](#which-command-checks-what)
- [Minimal documents](#minimal-documents)
- [Elements the renderer keeps](#elements-the-renderer-keeps)
- [Fields to set on every element](#fields-to-set-on-every-element)
- [Text labels](#text-labels)
- [Arrows](#arrows)
- [Frames](#frames)
- [Images](#images)
- [Layout](#layout)
- [Patch and put](#patch-and-put)
- [Dropped without an error](#dropped-without-an-error)

## Which command checks what

| Command | Local check | What gets written |
| --- | --- | --- |
| `excalidraw render` | Each element needs non-empty `id` and `type`, finite `x` and `y`, and non-negative `width` and `height` | Nothing. PNG only |
| `scenes create --file` with `type: "excalidraw"` | Full export. Missing `version`, `source`, `appState`, and `files` are filled in. `elements` is required | PUT |
| `scenes create --file` without that `type` | JSON object with at least one of `elements`, `appState`, `files` | PATCH |
| `scenes content put` | Same full-export check. `elements` is required, so `{}` is refused and the scene is unchanged | PUT. Elements absent from the file are removed |
| `scenes content patch` | JSON object only. The CLI does not check the keys | PATCH, forwarded as-is |

`appState` and `files` default to `{}` for render. Document `type`, `version`, and `source` are not required to render.

Filled-in export defaults, used only when the field is missing:

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://www.npmjs.com/package/@excalidraw/cli",
  "appState": {},
  "files": {}
}
```

`version` here is the file format (always 2). It is not an element's `version`. Do not send `sceneVersion`; the server recomputes it.

## Minimal documents

Smallest file that renders:

```json
{
  "elements": [
    { "id": "box", "type": "rectangle", "x": 100, "y": 80, "width": 160, "height": 80 }
  ]
}
```

Full export for `scenes content put` or for `scenes create --file` when the file should own the scene. An empty `elements` array is valid for put and creates an empty scene; render rejects it.

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://www.npmjs.com/package/@excalidraw/cli",
  "elements": [],
  "appState": { "viewBackgroundColor": "#ffffff" },
  "files": {}
}
```

Patch body. No `type`, `version`, or `source`.

```json
{ "appState": { "viewBackgroundColor": "#f8f9fa" } }
```

On patch, `appState` keeps only `viewBackgroundColor` (string) and `lockedMultiSelections` (object of id → `true`). Other app state is dropped by the API. Render also reads `exportWithDarkMode` and `exportBackground` from a local file: `--theme` overrides the first, and `--transparent` or `exportBackground: false` clears the background. The default canvas color is `#ffffff`.

## Elements the renderer keeps

Use only these `type` values:

`rectangle`, `diamond`, `ellipse`, `stickynote`, `text`, `line`, `arrow`, `freedraw`, `image`, `frame`, `magicframe`

`selection` is removed. `iframe` and `embeddable` are real types but export draws nothing in them; do not use them when the user should see the contents. Any other `type` is removed during restore. The CLI still exits 0. The bundled renderer draws `stickynote`; prefer `rectangle` when the scene must round-trip through the API, which does not document that type.

Prefer `rectangle`, `diamond`, `ellipse`, `text`, `arrow`, and `frame` for diagrams. Skip `freedraw` unless the user supplied points.

## Fields to set on every element

Restore fills gaps, then deletes some elements. Set the fields below yourself so a later patch has a stable element to version.

| Field | Use |
| --- | --- |
| `id` | Stable string. Prefer `[A-Za-z0-9_-]{1,128}`. Duplicate ids in one file are split at render |
| `type` | One of the types above |
| `x`, `y` | Scene position of the top-left, in pixels |
| `width`, `height` | Box size. Both 0 deletes the element. Arrows and lines recompute these from `points` |
| `angle` | `0` unless the user asked for a rotation |
| `strokeColor` | `#1e1e1e` |
| `backgroundColor` | A fill from the palette below, or `transparent` |
| `fillStyle` | `solid`. Also valid: `hachure`, `cross-hatch`, `zigzag`. A bad value throws inside the renderer |
| `strokeWidth` | `2`. `0` is replaced with `2` |
| `strokeStyle` | `solid`. Also valid: `dashed`, `dotted` |
| `roughness` | `1` for the hand-drawn look. `0` is architect (clean), `2` is looser. `0` is kept |
| `opacity` | `100` |
| `roundness` | `null`, or `{ "type": 3 }` on rectangles (adaptive corner radius). Curves on diamonds and arrows use `{ "type": 2 }` |
| `seed` | Any integer. It drives the wobble; keep it stable across edits so the shape does not reshuffle |
| `version` | Integer. Start at 1. On every later edit, set it higher than the stored version |
| `versionNonce` | New integer on every edit. Breaks ties when `version` is equal |
| `index` | Fractional index string (`a0`, `a1`, `a2`) or omit it. Array order is the paint order; later elements are on top. An index that is not strictly between its neighbors is rewritten |
| `isDeleted` | `false`, or `true` to tombstone on patch |
| `groupIds` | `[]`, or shared strings for shapes that move together. Deepest group first |
| `frameId` | `null`, or the id of a `frame` / `magicframe`. This does not move the element; `x` and `y` stay absolute |
| `boundElements` | `null`, or a list of `{ "id", "type": "text" \| "arrow" }` |
| `link` | `null` |
| `locked` | `false` |
| `updated` | Integer timestamp |

`index` does not replace array order. Put a container before its label.

Palette, in order, when the diagram has several boxes: `#a5d8ff`, `#b2f2bb`, `#ffec99`, `#ffd8a8`, `#d0bfff`, `#ffc9c9`. Stroke stays `#1e1e1e`. Background of the scene stays `#ffffff`.

## Text labels

There is no `label` property. A label is a second element of `type: "text"`.

The renderer does not reflow or recenter text. `textAlign` and `verticalAlign` apply inside the text element's own box. For a centered label, set the text element's `x`, `y`, `width`, and `height` to the container's box.

Also set:

- `text` and `originalText` to the same string. An empty string deletes the element.
- `fontSize` to `20` unless the user wants a title (`28`) or a caption (`16`).
- `fontFamily` to `5` (Excalifont). Other bundled families: Virgil `1`, Helvetica `2`, Cascadia `3`, Nunito `6`, Lilita One `7`, Comic Shanns `8`, Liberation Sans `9`, Assistant `10`. `4` is unused.
- `lineHeight` to `1.25` for Excalifont.
- `textAlign` to `center` and `verticalAlign` to `middle` for labels inside shapes. Use `left` / `top` for standalone text.
- `containerId` to the shape id, and add `{ "id": "<text id>", "type": "text" }` to the shape's `boundElements`.
- `autoResize` to `true` and `baseFontSize` to `null` for normal labels.

Containers that can hold text are `rectangle`, `stickynote`, `diamond`, `ellipse`, and `arrow`. Place the text after its container in the array.

A text box smaller than its glyphs clips them. For a label inside a shape, reuse the shape's box. For standalone text, give the element a width that fits the string on one line, then check the PNG.

`stickynote` needs a `baseHeight` (use the element's `height`). Restore forces a solid, non-transparent fill.

## Arrows

The stroke follows `points`. Bindings attach the arrow to shapes in the editor; they are not required for the PNG, and they are dropped when they are incomplete.

- `x` and `y` are the first point in scene coordinates. `points[0]` must be `[0, 0]`. Further points are offsets from that origin.
- Set `width` and `height` to the point bounds. Restore overwrites them from `points`.
- Two points closer than 0.1 scene units delete the arrow. A line or arrow wider or taller than 75000 is deleted.
- `endArrowhead: "arrow"` is the normal head. Omitting `endArrowhead` also becomes `"arrow"`. Use `null` for no head. `startArrowhead: null` unless the user wants two heads.
- `elbowed: false` and `roundness: null` is a straight arrow. A curved arrow uses `roundness: { "type": 2 }`. An elbow arrow needs `elbowed: true` and at least four points if you care about the route.
- Lines (`type: "line"`) always lose `startBinding` and `endBinding`. Use `arrow` when it should connect two shapes.

Binding on each end, when you include one:

```json
{ "elementId": "box-a", "fixedPoint": [1, 0.5], "mode": "inside" }
```

`fixedPoint` is a fraction of the target box, not a scene point. Right edge `[1, 0.5]`, left `[0, 0.5]`, top `[0.5, 0]`, bottom `[0.5, 1]`. `mode` is `inside`, `orbit`, or `skip`. Include `mode`; without it the binding is legacy and restore can drop it. Also add `{ "id": "<arrow id>", "type": "arrow" }` to each target's `boundElements`.

Bindable targets are `rectangle`, `stickynote`, `diamond`, `ellipse`, `image`, `iframe`, `embeddable`, `frame`, `magicframe`, and a `text` element whose `containerId` is null.

Start the arrow on the source edge and end it on the target edge so the shaft does not cross the fill. Example: a box at `(80, 80)` sized `160×80` has a right-center of `(240, 120)`. That is the arrow's `x` and `y`.

Other arrowheads, if the user asks: `bar`, `circle`, `circle_outline`, `triangle`, `triangle_outline`, `diamond`, `diamond_outline`.

## Frames

A frame is an element with `type: "frame"` or `magicframe`, a `name` string, and a non-zero box. Children point at it with `frameId` and keep absolute coordinates. They should sit inside the frame rectangle.

`excalidraw render drawing.excalidraw --frame-id frame-1` clips to that frame and omits the frame chrome. A full-scene render draws the frame name and outline. `--padding` does not apply to frame exports.

## Images

An image element sets `fileId`. `files[fileId]` must exist and its `dataURL` must match `data:image/<subtype>;` or `data:image/<subtype>,`. `https://` URLs fail the render. The bytes must decode.

For an API write, each file object needs:

```json
{ "mimeType": "image/png", "id": "img1", "created": 1710000000000, "dataURL": "data:image/png;base64,..." }
```

`created` must be a positive integer. The CLI only checks that it is a number, so `0` passes the CLI and fails the API. `id` matches `^[A-Za-z0-9_-]{1,128}$`. Keep `dataURL` under about 20 MB.

Also set `status` to `"pending"`, `scale` to `[1, 1]`, and `crop` to `null` on the image element.

## Layout

Use a 16-pixel grid. Leave at least 64 pixels between boxes that an arrow connects, so the shaft is visible. Align edges or centers; do not place boxes by eye at offsets like 13 pixels.

Titles go above a group, not inside a box that already has a label. One label per shape. Keep labels to a few words; long sentences belong in a text element under the shape, with `textAlign: "left"` and a width you have checked.

Paint order is array order. Background frames first, then shapes, then arrows, then labels.

After the first render, open the PNG. Fix text that clips, arrows that start inside a fill, and boxes that collide. Re-render before uploading.

## Patch and put

Rendering a patch file locally draws only the elements in that file. It does not show the merged scene. Copy the GET document, drop in the changed elements, and render that copy when you need a preview.

Get the scene first when you are editing rather than replacing:

```bash
excalidraw scenes content get "$SCENE_ID" --out scene.json
```

Copy each element you change, increment `version`, set a new `versionNonce`, and send those complete elements. Leave every other element out of the patch so it stays as stored.

To soft-delete, send the element with `isDeleted: true` and a higher `version`. It remains as a tombstone and is not drawn. A later put that simply omits the id removes it instead of tombstoning it.

Do not include `type`, `version`, `source`, or `sceneVersion` on a patch body. Include only `elements`, `appState`, and `files`.

`filesFailedToEmbed` on a GET body can be left in a file you send back; write commands ignore it.

## Dropped without an error

The render command still succeeds when restore discards an element. The PNG is then missing that shape, or blank if every shape was discarded.

- Unknown `type`, and `selection`
- `isDeleted: true`
- `width` and `height` both 0
- Text with empty `text`
- Arrow or line with endpoints within 0.1, or a width or height over 75000
- Image whose `fileId` has no embedded data URL (this one **does** throw)
- Live image whose `fileId` is in `filesFailedToEmbed` (this one **does** throw)
