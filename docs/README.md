# Excalidraw CLI

Render Excalidraw drawings and Mermaid diagrams from your terminal, free and without an account. With an [Excalidraw+](https://plus.excalidraw.com) API key, manage your workspace too.

## Install

```bash
npm install -g @excalidraw/cli
```

Or try it without installing: `npx @excalidraw/cli --help`. Requires Node.js 22 or newer.

To update, run `excalidraw update`. It installs the latest version with the package manager you installed the CLI with: npm, pnpm, yarn, bun or Volta. `excalidraw update --check` only reports whether a newer version is out.

Commands you run in a terminal check for a newer version at most once a day, while the command runs, and mention it after the output. Set `EXCALIDRAW_NO_UPDATE_NOTIFIER=1` to turn this off.

## Quick start

### No account needed

`render` and `mermaid` run on your computer with an installed Chrome, Chromium, Edge or Firefox. Nothing is uploaded.

```bash
# Render a drawing, or each slide of a deck
excalidraw render drawing.excalidraw --out drawing.png
excalidraw render deck.excalidraw --all-frames --out slides/

# Turn a Mermaid diagram into an editable Excalidraw scene, or straight into an SVG
excalidraw mermaid flow.mmd --out flow.excalidraw
excalidraw mermaid flow.mmd --out flow.svg
```

### With Excalidraw+

Workspace commands need an Excalidraw+ API key. Create one in Excalidraw+ under **Account settings → MCP/API key** (a personal key) or **Workspace settings → MCP/API Keys**; the [authentication docs](https://plus.excalidraw.com/docs/api/authentication) explain both. Logging in with the browser (OAuth) is coming soon.

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

## Commands

No account needed:

| Command | What it does |
| --- | --- |
| `render` | Render a local file to PNG or SVG |
| `mermaid` | Convert a Mermaid diagram into an Excalidraw scene, PNG or SVG |
| `update` | Update the CLI to the latest version |

With an Excalidraw+ API key:

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
| `collections` | Manage collections and the scenes in them |
| `workspace` | Read or update the workspace name and picture |
| `workspace users` | List, update or remove members |
| `workspace invites` | Manage email invites and invite links |
| `logs` | Query the workspace audit log |

Updating the workspace, and the `users`, `invites` and `logs` commands, need admin rights. A personal key that belongs to a member gets `HTTP 403`.

## Guides

- [Render to PNG or SVG](rendering.md): image options, slides, fonts and browsers.
- [Mermaid diagrams](mermaid.md): turn Mermaid into editable Excalidraw scenes.
- [Editing scene content](scene-content.md): replace or patch a workspace scene.
- [Scripting and agents](scripting.md): JSON output, stdin and stdout, retries and exit codes.
- [Configuration](configuration.md): flags, environment variables and API keys.
