---
name: excalidraw-cli
description: >-
  Operate the official Excalidraw CLI (@excalidraw/cli) to manage an Excalidraw+
  workspace and render .excalidraw files to PNG. Use when the user mentions
  Excalidraw, .excalidraw, excalidraw.com, Excalidraw+, a whiteboard or
  hand-drawn diagram, scenes, collections, or exporting a sketch to PNG; when
  creating, updating, patching, or reading diagram JSON; when signing in with
  an API key; or when listing workspace members, invites, or audit logs. Use
  this even when they only say "draw this in Excalidraw" or "export the
  diagram" and never name the CLI.
license: MIT
compatibility: >-
  Requires Node.js 22 or newer and the excalidraw command from @excalidraw/cli.
  Rendering needs Chrome, Edge, Chromium, or Firefox. Workspace commands need
  an Excalidraw+ API key.
metadata:
  author: excalidraw
  cli-version: "0.2.0"
---

# Excalidraw CLI

Use the official `excalidraw` command from `@excalidraw/cli`. It manages an Excalidraw+ workspace over the HTTP API and renders `.excalidraw` JSON to PNG in a local browser. It is not a live canvas: there are no `add`, `query`, or `arrange` commands. Do not call third-party Excalidraw CLIs or MCP canvas servers for this task.

Flags and defaults below match CLI 0.2.0. If `excalidraw --version` is newer, trust `excalidraw <command> --help` for flags. Read [references/commands.md](references/commands.md) for the full command catalog. Read [references/scene-format.md](references/scene-format.md) before writing or editing elements.

## Run the CLI

Confirm Node.js is 22 or newer, then use an installed binary when one exists:

```bash
excalidraw --version
```

If `excalidraw` is not on `PATH`, run `npx --yes @excalidraw/cli` in its place. Add `--` before arguments when a flag could be read as an npx option.

Parse **stdout as JSON**. Diagnostics, retries, and `login` / `logout` text go to **stderr**. Any error exits 1. `-o table` changes `whoami`, `update`, and list commands only; other commands stay JSON. `--raw` prints the API body as received.

Pass `-` to read JSON from stdin (`render -`, `--file -`). Stdin must not be a terminal. `--out -` on a render command writes **PNG bytes only**, with no JSON summary, and is refused when stdout is a terminal.

## Authenticate

Workspace commands need an API key. `render` of a local file does not.

Set the key in the environment. Do not put it on the command line, do not echo it, and do not write it into the repo or into `credentials.json` by hand.

```bash
export EXCALIDRAW_API_KEY="..."
excalidraw whoami
```

`whoami` prints `apiUrl`, `keyType` (`personal` or `workspace`), `credentialSource` (`env`, `flag`, or `login`), and `workspace` (`id`, `name`, `subscriptionStatus`). Run it before the first write so later commands hit the workspace the user expects.

Key lookup order is `--api-key`, then `EXCALIDRAW_API_KEY`, then the key saved by `excalidraw login` for that API origin. A blank variable counts as unset. Keys are stored per origin in `~/.config/excalidraw-cli/credentials.json` (`$XDG_CONFIG_HOME` if set, `%APPDATA%` on Windows). `login` is interactive and is the wrong path for an agent. `login --api-key` saves a key, but the process list can expose it; prefer the environment variable for the session.

Personal keys start with `uk-`. They may pass `private` as a collection id, meaning that user's private collection. Any other key is a workspace key: it cannot see private scenes, and `scenes create` needs a real collection id.

`--api-url` / `EXCALIDRAW_API_URL` defaults to `https://api.excalidraw.com`. Pass the origin only; a trailing `/api/v1` is stripped. A staging key is not sent to production, and the reverse.

## Pick the command

| Goal | Command |
| --- | --- |
| PNG from a local file, no account | `excalidraw render <file> --out <png>` |
| PNG of a workspace scene | `excalidraw scenes render <sceneId> --out <png>` |
| Find scenes or collections | `scenes list` or `collections list`, with `--limit` or `--all` |
| Create a diagram in the workspace | `scenes create --name --collection-id --file` |
| Change elements in an existing scene | `scenes content patch` |
| Replace a scene with a file you fully own | `scenes content put` |
| Rename, pin, or move a scene | `scenes update` |
| Workspace members, invites, audit log | `workspace …`, `logs list` |

List commands return 5 items unless you pass `--limit` (1–100) or `--all`. `logs list` defaults to 50. `--all` on offset lists prints `{ count, data }`. On logs it follows `nextCursor` and prints `{ count, logs, availableActions }`, and it cannot be combined with `--page`.

Scene ids, collection ids, and user ids come from list or create output. `.`, `..`, and an empty id are rejected before the request.

## Draw or edit a scene

1. Read [references/scene-format.md](references/scene-format.md). Copy the closest asset and edit it. Do not invent a compact element schema; the renderer drops elements it does not understand and still exits 0.
   - [assets/labeled-rectangle.excalidraw](assets/labeled-rectangle.excalidraw) — one shape and its label
   - [assets/arrow-between-shapes.excalidraw](assets/arrow-between-shapes.excalidraw) — two shapes and an arrow
   - [assets/frame.excalidraw](assets/frame.excalidraw) — a frame and a child
   - [assets/patch-update-and-delete.json](assets/patch-update-and-delete.json) — a patch body
2. Write the JSON to a file. For a new scene that should become the whole drawing, include `"type": "excalidraw"`. For a patch, omit `type`, `version`, and `source`.
3. Render locally and look at the PNG. Fix overlap, clipped text, and missing shapes before uploading.

```bash
excalidraw render drawing.excalidraw --out /tmp/drawing.png
```

A file-path render prints `{ path, mimeType, width, height, frameId }` on stdout. `frameId` is null unless you passed `--frame-id`. Open the PNG and check it. `Cannot render an empty scene` means every element was deleted or failed validation. A successful render can still look blank when every element type was dropped.

4. Upload only after the PNG looks right.

```bash
# New scene. A file with type "excalidraw" is PUT; any other object is PATCHed.
excalidraw scenes create --name "Architecture" --collection-id "$COLLECTION_ID" --file drawing.excalidraw

# Incremental edit of a scene that already has content.
excalidraw scenes content patch "$SCENE_ID" --file patch.json
```

Create validates the file **before** it creates the scene. If the write still fails afterward, the error includes the new scene id; retry with `scenes content put` or `scenes content patch` on that id. Do not create a second scene.

### Put replaces, patch merges

This is the mistake that deletes a user's drawing.

- `scenes content put` replaces the scene. Elements missing from the file are **removed**. The file must include `elements` (it may be `[]`). Missing `type`, `version`, `source`, `appState`, and `files` are filled in. The server ignores `sceneVersion` and recomputes it. Connected editors reload.
- `scenes content patch` merges. Omitted elements stay. Elements merge by id: the higher `version` wins, and `versionNonce` breaks a tie. Send `isDeleted: true` with a higher version to soft-delete. Files are replaced by id. From `appState`, only `viewBackgroundColor` and `lockedMultiSelections` are stored.
- On patch, send the **complete** element you want stored, not a stub with only the field that changed. Reconciliation is by element version, not a field-by-field merge.
- `scenes create --file` and `collections scenes create --file` follow the same split: `type: "excalidraw"` selects PUT, anything else selects PATCH. A partial file must contain at least one of `elements`, `appState`, or `files`. Putting `"type": "excalidraw"` on a partial file makes the CLI demand a full export and then replace the scene.

Prefer patch for agent edits. Use put only when the file is the source of truth for the whole scene.

`scenes content get` returns the stored document. It may include `filesFailedToEmbed`; write commands ignore that field, but render throws if a live image's `fileId` is listed there. Fetch the scene again before rendering in that case. `scenes get` is metadata only and does not include elements.

## Render options

`--out` is required. Defaults: `--scale 1` (max 16), `--max-width` and `--max-height` 2048 (max 16384), `--padding 20` (0–1000, ignored for frames), `--timeout 30000`. The PNG keeps the scene aspect ratio and stays under 64 million pixels. `--theme light|dark` overrides the scene. `--transparent` clears the background.

`--frame-id` must be the id of a live `frame` or `magicframe` with non-zero width and height. The export is clipped to that frame. Padding is ignored.

The CLI uses an installed Chrome, Edge, or Chromium, then Firefox. It does not download a browser. If discovery fails, set `EXCALIDRAW_BROWSER_PATH` or `--browser-path`. Firefox renders, more slowly. The API key is not passed into the browser. External image URLs and website embeds are not loaded; images must be embedded `data:image/...` URLs in `files`.

Hand-drawn CJK text downloads the Xiaolai font on first use. `--fonts-url none` skips that download and falls back to a system font. Other families are bundled.

## Workspace changes that need a clear ask

Do these only when the user asked for that change:

- `scenes delete` and `collections delete` move resources to trash. Deleting a collection trashes **every scene in it**. List the collection's scenes first.
- `workspace update`, `workspace users`, `workspace invites`, and `logs` need admin rights. A personal key for a non-admin gets HTTP 403. The CLI does not check the role locally.
- `users remove`, invite create/delete, and role changes are membership changes. Repeat the email, role, and target back to the user in the result you report.

`excalidraw update` upgrades the installed CLI. Run it only when asked. `excalidraw update --check` reports `{ currentVersion, latestVersion, updateAvailable }` and does not install.

## When a call fails

- **401** or missing key: run `whoami`. Confirm `EXCALIDRAW_API_KEY` and that `--api-url` is the origin the key belongs to.
- **403**: the key is valid but not allowed. Workspace admin commands and private scenes fail this way. `whoami` itself can 403 for a key that cannot read the workspace.
- **Validation on stderr** (`file is not a complete Excalidraw export` or `not valid partial scene content`): the file never reached the API. Fix the listed paths. At most 10 issues are printed.
- **Scene was created, but writing its content failed**: keep that scene id and retry the content write. Do not create another scene.
- **GET** retries HTTP 429, 502, 503, and 504, plus timeouts. **Other methods retry 429 only.** A timed-out POST, PUT, or PATCH may already have been applied. Read the resource before sending the write again. `--retries` defaults to 3 and accepts 0–10; `0` means one attempt. Retry notes are on stderr.
- **Render**: `Frame not found`, `Frame has no area`, `missing embedded file data`, and `External image URLs are not supported` are local errors. Nothing was uploaded.

HTTP errors look like `HTTP <status>: <message>` on stderr. `--raw` prints the full body; otherwise it is truncated.
