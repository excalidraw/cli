<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-dark.png">
    <img alt="Excalidraw CLI: turn .excalidraw files and Mermaid diagrams into PNG, SVG, slides and Excalidraw+ scenes from your terminal" src=".github/assets/banner-light.png" width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://plus.excalidraw.com/docs/cli"><b>Documentation</b></a> ·
  <a href="https://www.npmjs.com/package/@excalidraw/cli">npm</a> ·
  <a href="https://plus.excalidraw.com">Excalidraw+</a> ·
  <a href="https://excalidraw.com">Excalidraw</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@excalidraw/cli"><img alt="npm" src="https://img.shields.io/npm/v/@excalidraw/cli"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@excalidraw/cli"></a>
</p>

Render Excalidraw drawings and Mermaid diagrams from your terminal, free and without an account. Log in to [Excalidraw+](https://plus.excalidraw.com) to manage your workspace too.

## Features

- 🖼️ **Render to PNG or SVG**: any `.excalidraw` file, light or dark, transparent, up to 16× scale.
- 🎞️ **Export slides**: each frame to its own image, in presentation order.
- 🧜 **Mermaid to Excalidraw**: flowcharts, sequence, class, ER and state diagrams, Gantt charts, quadrant charts and timelines become editable shapes.
- 🔒 **Runs locally**: uses the browser you already have. Nothing is uploaded, no account needed.
- ☁️ **Excalidraw+ workspace**: log in with your browser, then manage scenes, collections, share links, presentations, members and audit logs.
- 🤖 **Made for scripts and AI agents**: JSON output, stdin and stdout, and `EXCALIDRAW_API_KEY`.

## Install

```bash
npm install -g @excalidraw/cli
```

Or run it without installing: `npx @excalidraw/cli --help`. Requires Node.js 22 or newer. `excalidraw update` updates it.

## Quick start

```bash
# No account needed
excalidraw render drawing.excalidraw --out drawing.png
excalidraw render deck.excalidraw --all-frames --out slides/
excalidraw mermaid flow.mmd --out flow.excalidraw

# With Excalidraw+
excalidraw login --web    # log in with your browser
excalidraw scenes list --output table
excalidraw scenes render <sceneId> --out scene.png
```

Every command has `--help` with examples.

## Logging in

`excalidraw login` asks how to log in; pick the browser, or run `excalidraw login --web`. It opens Excalidraw+, where you sign in, pick a workspace and allow the CLI. The CLI then acts as you in that workspace, with your role, and stays logged in until you run `excalidraw logout` or disconnect it under **Settings → Connected apps**; either cuts it off at once.

For scripts, CI and machines without a browser, use an API key instead: `excalidraw login --api-key <key>`, `--api-key` or `EXCALIDRAW_API_KEY`. A key passed with `--api-key` or `EXCALIDRAW_API_KEY` takes priority over the saved login, so unset it to use your browser login. `excalidraw whoami` shows which one is in use. See [Configuration and API keys](https://plus.excalidraw.com/docs/cli/configuration).

## Documentation

📚 **[plus.excalidraw.com/docs/cli](https://plus.excalidraw.com/docs/cli)**

- [Render to PNG or SVG](https://plus.excalidraw.com/docs/cli/rendering)
- [Mermaid diagrams](https://plus.excalidraw.com/docs/cli/mermaid)
- [Editing scene content](https://plus.excalidraw.com/docs/cli/scene-content)
- [Scripting and agents](https://plus.excalidraw.com/docs/cli/scripting)
- [Configuration and API keys](https://plus.excalidraw.com/docs/cli/configuration)
- [Command reference](https://plus.excalidraw.com/docs/cli#commands)

The same guides are in [docs/](docs/README.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for building the CLI and running the tests.

## License

[MIT](LICENSE)
