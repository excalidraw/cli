# Command reference

Catalog for `@excalidraw/cli` 0.2.0. Run `excalidraw <command> --help` if the installed version is newer. Global flags work on every command.

## Global flags

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--api-url <url>` | `EXCALIDRAW_API_URL` | `https://api.excalidraw.com` |
| `--api-key <key>` | `EXCALIDRAW_API_KEY` | key saved by `login` for that origin |
| `-o, --output <json\|table>` | `EXCALIDRAW_OUTPUT` | `json` |
| `--raw` | | off; print the API body as text |
| `--retries <n>` | `EXCALIDRAW_RETRIES` | `3` (0–10) |
| `--request-timeout <ms>` | `EXCALIDRAW_REQUEST_TIMEOUT` | `60000` (1–600000) |
| `-v, --version` | | print the package version |

Requests go to `{origin}/api/v1/...`. `--api-url` is the origin, without `/api/v1`.

Stdout is pretty-printed JSON plus a newline, except where a command below says otherwise. stderr is for errors, retry notices, font warnings, and `login` / `logout`.

## login and logout

Neither command prints JSON.

`excalidraw login` prompts on a terminal. `excalidraw login --api-key <key>` checks the key and saves it for the current `--api-url` origin. A key the API rejects with 401 is not saved. HTTP 403 from the workspace lookup still saves the key and warns. Setting `EXCALIDRAW_API_KEY` does not by itself save a key.

`excalidraw logout` removes the saved key for the current origin and says so even when no key was saved. A key still present in `EXCALIDRAW_API_KEY` keeps working; logout warns about that.

Saved file: `$XDG_CONFIG_HOME/excalidraw-cli/credentials.json`, else `%APPDATA%\excalidraw-cli\credentials.json` on Windows, else `~/.config/excalidraw-cli/credentials.json`. Mode `0600` on the file and `0700` on the directory. Shape:

```json
{ "version": 1, "origins": { "https://api.excalidraw.com": { "type": "api-key", "apiKey": "..." } } }
```

## whoami

Requires a key. JSON:

```json
{
  "apiUrl": "https://api.excalidraw.com",
  "keyType": "personal",
  "credentialSource": "env",
  "workspace": { "id": "...", "name": "...", "subscriptionStatus": "..." }
}
```

`keyType` is `personal` when the key starts with `uk-`, otherwise `workspace`. `-o table` prints this as a two-column table.

## render

`excalidraw render <file>` renders local JSON. No API key.

`excalidraw scenes render <sceneId>` fetches scene content, then uses the same renderer. Requires a key that can read the scene. The JSON summary includes `sceneId`.

| Flag | Default | Constraint |
| --- | --- | --- |
| `--out <file>` | required | Path, or `-` for PNG bytes on stdout |
| `--frame-id <id>` | | A live `frame` or `magicframe` |
| `--padding <pixels>` | `20` | Integer 0–1000. Ignored for frames |
| `--scale <n>` | `1` | Positive, max 16 |
| `--max-width <pixels>` | `2048` | Integer 1–16384 |
| `--max-height <pixels>` | `2048` | Integer 1–16384 |
| `--theme <light\|dark>` | scene export setting | |
| `--transparent` | off | |
| `--browser-path <path>` | `EXCALIDRAW_BROWSER_PATH` or auto-detect | Chrome, Edge, Chromium, or Firefox |
| `--fonts-url <urls>` | `EXCALIDRAW_FONTS_URL` or the Excalidraw CDN | Comma-separated `http(s)` URLs, or `none` |
| `--timeout <ms>` | `30000` | Integer 1–600000 |

When `--out` is a file path, stdout is:

```json
{ "path": "/abs/drawing.png", "mimeType": "image/png", "width": 320, "height": 180, "frameId": null }
```

`scenes render` adds `sceneId`. When `--out` is `-`, stdout is the PNG and this object is not printed.

The browser order is Chrome, Edge, Chromium, then Firefox. Snap wrappers are deprioritized. A binary whose name matches `firefox` is driven as Firefox. Output is capped at 64 million pixels. Font warnings go to stderr.

## scenes

`excalidraw scenes` covers metadata. Drawing JSON is `scenes content` and `scenes render`.

| Command | Required | Notes |
| --- | --- | --- |
| `scenes list` | | `--limit` 1–100, `--offset` ≥ 0, `--all`, `--collection-id`. Default page size 5 |
| `scenes get <sceneId>` | | Metadata, links, pin, collection. No elements |
| `scenes create` | `--name`, `--collection-id` | `--pinned` defaults false. `--file` optional |
| `scenes update <sceneId>` | at least one of `--name`, `--collection-id`, `--pinned` / `--no-pinned` | Does not change elements |
| `scenes delete <sceneId>` | | Moves the scene to trash |
| `scenes content get <sceneId>` | | `--out <file>` writes JSON. `--out -` writes JSON to stdout and skips the summary |
| `scenes content put <sceneId>` | `--file` | Full replacement. See the skill's put/patch section |
| `scenes content patch <sceneId>` | `--file` | Merge. The CLI checks that the file is a JSON object |
| `scenes render <sceneId>` | `--out` | See render |

`--all` is not sent to the API. The CLI walks pages of `--limit` or 100 and prints `{ count, data }` with no `hasNextPage`. A single page returns the API object, including `limit`, `offset`, `hasNextPage`, and `data`.

`scenes create` and `collections scenes create` share `--file` handling: the file is validated before the scene exists. `type: "excalidraw"` is written with PUT after the CLI fills missing export fields. Any other JSON object is a partial document and must include `elements`, `appState`, or `files`; it is written with PATCH.

Personal keys may use `--collection-id private`. Workspace keys must pass a real collection id.

## collections

| Command | Required | Notes |
| --- | --- | --- |
| `collections list` | | Same pagination as `scenes list`. Default page size 5 |
| `collections get <collectionId>` | | |
| `collections create` | `--name` | |
| `collections update <collectionId>` | `--name` | |
| `collections delete <collectionId>` | | Trashes the collection and every scene in it |
| `collections scenes list <collectionId>` | | Same pagination as `scenes list` |
| `collections scenes create <collectionId>` | `--name` | `--pinned`, `--file`. The collection id is the path, not a body field |

## workspace

Every command uses the workspace that owns the API key. Admin-only calls return HTTP 403 for a member key. The CLI does not check the role itself.

| Command | Required | Notes |
| --- | --- | --- |
| `workspace get` | | Name, picture, subscription, user ids |
| `workspace update` | `--name` or `--picture` | `--picture none` clears the picture. Picture values must be URLs |
| `workspace users list` | | Paginated, default 5 |
| `workspace users get <userId>` | | |
| `workspace users update <userId>` | at least one of `--name`, `--picture`, `--role` | `--role` is `member` or `admin`. `--picture none` clears it |
| `workspace users remove <userId>` | | |
| `workspace invites list` | | Paginated, default 5 |
| `workspace invites get <inviteId>` | | |
| `workspace invites create` | `--email`, `--role` | Role is `member` or `admin` |
| `workspace invites create-link` | `--role` | `--max-uses` defaults to `1`; pass an integer ≥ 1 or `unlimited`. `--restricted-domains` is a comma-separated list |
| `workspace invites update <inviteId>` | at least one field | `--email`, `--role`, `--max-uses`, `--restricted-domains`. `none` clears the domain restriction |
| `workspace invites delete <inviteId>` | | |

## logs

`excalidraw logs list` reads the audit log. Default page size is 50, not 5. There is no `--offset`.

| Flag | Notes |
| --- | --- |
| `--limit <n>` | 1–100 |
| `--cursor <cursor>` | `nextCursor` from the previous page |
| `--page <n>` | Page number starting at 1. Cannot combine with `--cursor` or `--all` |
| `--user <userId>` | |
| `--action <action>` | Use a value from the response's `availableActions`. Unknown values are ignored by the API |
| `--operation <op>` | `create`, `read`, `update`, or `delete` |
| `--date-from`, `--date-to` | ISO 8601 strings |
| `--all` | Follows `nextCursor`. Prints `{ count, logs, availableActions }` |

`-o table` works for this list.

## update

`excalidraw update` installs the latest CLI with the package manager that installed it (npm, pnpm, yarn, bun, or Volta). `excalidraw update --check` does not install.

Check output: `{ currentVersion, latestVersion, updateAvailable }`.

After an install: `{ currentVersion, latestVersion, updated: true, command: "<install command>" }`. When no install is possible: `updated: false` and `command: null`.

The daily update notice is separate. It runs only when stdout and stderr are both terminals, `CI` is unset, and `EXCALIDRAW_NO_UPDATE_NOTIFIER` / `NO_UPDATE_NOTIFIER` are unset, at most once a day. `excalidraw update` skips it. Agents parsing stdout will not see it, because piped stdout suppresses it.

## Errors

| Source | What stderr looks like |
| --- | --- |
| API | `HTTP <status>: <message>`, then a truncated body unless `--raw` |
| Option validation | `--flag: <message>` |
| Missing or bad global config | `Configuration error:` and a bullet list |
| Scene file | `<file> is not a complete Excalidraw export, so the scene was not changed:` or `so no scene was created:` plus indented issues |
| JSON | `Failed to parse JSON from <label>: ...` |
| Network | `Could not reach <origin>: ...`, or a timeout that names `--request-timeout` |
| Render | One line: empty scene, frame not found, frame has no area, missing embed, external URL, browser launch, timeout, or invalid PNG |

Non-GET requests that fail on the network say the request may already have been applied. Read before retrying a write.
