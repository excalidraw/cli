# MCP tools

`excalidraw mcp` runs the tools of the [Excalidraw+ MCP server](https://plus.excalidraw.com/docs/mcp) with the CLI's login. An agent that can run shell commands gets the same drawing tools as one connected to the server (diagrams, charts, tables, slides, sticky notes, layout checks and screenshots) without an MCP server to configure: log in once with `excalidraw login`, and tell the agent to use `excalidraw mcp`.

```bash
# How to draw with the tools: read once per conversation
excalidraw mcp instructions

# Which tools there are, then one tool's arguments
excalidraw mcp tools --output table
excalidraw mcp schema create_mermaid_diagram

# Run a tool
excalidraw mcp call create_mermaid_diagram --args-file diagram.json
excalidraw mcp call take_screenshot --args '{"sceneId":"<sceneId>"}' --out scene.png
```

## For agents

Add a line like this to the instructions your agent reads, such as `AGENTS.md` or `CLAUDE.md`:

```text
To draw or edit Excalidraw+ scenes, use the `excalidraw` CLI: run `excalidraw mcp instructions` first, then `excalidraw mcp tools`, `excalidraw mcp schema <tool>` and `excalidraw mcp call <tool>`.
```

- `mcp instructions` prints what an MCP client would show its agent when connecting: which tool fits which content, and how to check a result.
- `mcp tools` prints each tool's name, the first sentence of its description, and `readOnly` and `destructive`. Read-only tools change nothing; destructive ones may change or remove existing content; the others only add. The list is short so it costs little context; the server's full definitions are many times larger.
- `mcp schema <tool...>` prints a tool's whole description and `inputSchema`, the JSON Schema its arguments must match.
- Tools the login has no permission for are not listed.

## Calling a tool

- Pass the arguments as one JSON object with `--args`, or from a file with `--args-file`, where `-` reads stdin. Prefer a file for large or quoted content, such as a Mermaid definition: the shell can mangle `--args`.
- The result is printed as JSON, or as text for tools that return text, such as the format guides.
- A tool that fails, for instance on arguments that don't match its schema, prints its message to stderr and exits with status 1.
- Tool calls are not retried when the response is lost, since a write may have been applied. Rate limits are retried. Slow tools may need a longer `--request-timeout`.

## Images

`take_screenshot`, and write tools called with `"screenshot": true`, return a PNG next to their result.

- `--out <file>` saves it there. Without `--out` it goes to a new directory in the system's temporary directory that only you can read.
- The path is printed to stderr, so stdout stays the tool's JSON result.
- `--out -` writes only the image to stdout, and the tool's result to stderr.
- When a write succeeds but its screenshot fails, the result is printed as usual and the reason goes to stderr as `screenshotError`. The write was applied: don't repeat it.

## Raw output

`--raw` prints what the server sent instead: the full tool definitions for `tools` and `schema`, and for `call` the whole MCP result with images as base64, without saving a file.

## How it works

The commands send MCP requests (`initialize`, `tools/list`, `tools/call`) to `/api/v1/mcp` on the API origin, with the same login, proxy, retry and timeout settings as the other commands. An API key or a browser login both work.
