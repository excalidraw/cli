import { Command, Option } from "commander";
import { registerCollectionsCommands } from "./commands/collections.js";
import { registerLoginCommands } from "./commands/login.js";
import { registerLogsCommands } from "./commands/logs.js";
import { registerMcpCommands } from "./commands/mcp.js";
import { registerScenesCommands } from "./commands/scenes.js";
import { registerWhoamiCommand } from "./commands/whoami.js";
import { registerWorkspaceCommands } from "./commands/workspace.js";
import { registerMermaidCommand, registerRenderCommand } from "./commands/render.js";
import { registerUpdateCommand } from "./commands/update.js";
import { DEFAULT_API_URL, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_RETRIES } from "./config.js";
import { packageJson } from "./package.js";
import { FREE_GROUP, PLUS_GROUP, formatHelp } from "./help.js";

export function createProgram() {
  const program = new Command();

  program
    .name("excalidraw")
    .description(
      "Render Excalidraw drawings and Mermaid diagrams on your computer, free and without an account. Log in to Excalidraw+ to manage your workspace too.",
    )
    .usage("<command> [options]")
    .version(packageJson.version, "-v, --version", "print the CLI version")
    .addOption(new Option("--api-url <url>", "API origin").env("EXCALIDRAW_API_URL").default(undefined, DEFAULT_API_URL))
    .addOption(new Option("--api-key <key>", "API key, instead of the one login saved").env("EXCALIDRAW_API_KEY"))
    .addOption(
      new Option("-o, --output <format>", "json, or table for lists, whoami and update")
        .env("EXCALIDRAW_OUTPUT")
        .default("json"),
    )
    .option("--raw", "print API responses as received, and API errors in full", false)
    .addOption(
      new Option("--retries <n>", "retries after rate limits (429) and failed reads")
        .env("EXCALIDRAW_RETRIES")
        .default(undefined, String(DEFAULT_RETRIES)),
    )
    .addOption(
      new Option("--request-timeout <ms>", "deadline for each API request")
        .env("EXCALIDRAW_REQUEST_TIMEOUT")
        .default(undefined, `${DEFAULT_REQUEST_TIMEOUT_MS} ms`),
    )
    .addHelpText(
      "after",
      `
EXAMPLES
  No account needed:
  $ excalidraw render drawing.excalidraw --out drawing.png
  $ excalidraw render deck.excalidraw --all-frames --out slides/
  $ excalidraw mermaid flow.mmd --out flow.svg
  With Excalidraw+:
  $ excalidraw login
  $ excalidraw scenes list --all --output table
  $ excalidraw scenes content get <sceneId> --out scene.json
  $ excalidraw scenes render <sceneId> --out scene.png
  $ excalidraw mcp call create_mermaid_diagram --args-file diagram.json

SETUP
  render and mermaid only need an installed Chrome, Chromium, Edge or Firefox.
  "excalidraw login" logs in to Excalidraw+ with the browser, or saves an API key. In scripts and CI, set EXCALIDRAW_API_KEY or pass --api-key instead.
  --api-url points the CLI at a staging or self-hosted origin, without /api/v1. Logins are saved per origin.

AGENTS
  To draw in a workspace (diagrams, charts, tables, slides, screenshots), use the Excalidraw+ MCP tools through "excalidraw mcp": no MCP server to configure. Start with "excalidraw mcp instructions" and "excalidraw mcp tools".

OUTPUT
  Commands print JSON. --output table prints lists, whoami and update as tables, and --raw prints the API's response text.
  With --out -, render and mermaid write only the image or scene to stdout.
  Errors and retry notices go to stderr, and any error exits with status 1.
`,
    )
    .showHelpAfterError()
    .showSuggestionAfterError();

  // Subcommands created after this inherit it.
  program.configureHelp({ formatHelp });

  program.commandsGroup(FREE_GROUP);
  registerRenderCommand(program);
  registerMermaidCommand(program);
  registerUpdateCommand(program);

  program.commandsGroup(PLUS_GROUP);
  registerLoginCommands(program);
  registerWhoamiCommand(program);
  registerScenesCommands(program);
  registerCollectionsCommands(program);
  registerWorkspaceCommands(program);
  registerLogsCommands(program);
  registerMcpCommands(program);

  // Created last, so subcommands don't share it. The help leaves it out of the command list.
  program.helpCommand(true);

  return program;
}
