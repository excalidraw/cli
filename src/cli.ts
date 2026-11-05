import { Command, Option } from "commander";
import { registerCollectionsCommands } from "./commands/collections.js";
import { registerLoginCommands } from "./commands/login.js";
import { registerLogsCommands } from "./commands/logs.js";
import { registerScenesCommands } from "./commands/scenes.js";
import { registerWhoamiCommand } from "./commands/whoami.js";
import { registerWorkspaceCommands } from "./commands/workspace.js";
import { registerMermaidCommand, registerRenderCommand } from "./commands/render.js";
import { registerUpdateCommand } from "./commands/update.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_RETRIES } from "./config.js";
import { packageJson } from "./package.js";
import { helpTheme } from "./theme.js";

export function createProgram() {
  const program = new Command();

  program
    .name("excalidraw")
    .description(
      "Excalidraw from your terminal. Render scenes and convert Mermaid diagrams on your computer, free and without an account. With an Excalidraw+ API key, manage your workspace's scenes, collections and members.",
    )
    .version(packageJson.version, "-v, --version", "print the CLI version")
    .optionsGroup("GLOBAL FLAGS")
    .addOption(
      new Option("--api-url <url>", "API origin; default https://api.excalidraw.com").env(
        "EXCALIDRAW_API_URL",
      ),
    )
    .addOption(
      new Option("--api-key <key>", 'API key; overrides the key "excalidraw login" saved').env(
        "EXCALIDRAW_API_KEY",
      ),
    )
    .addOption(
      new Option(
        "-o, --output <format>",
        "output format: json or table. Table applies to list commands, whoami and update; other commands print JSON",
      )
        .env("EXCALIDRAW_OUTPUT")
        .default("json"),
    )
    .option(
      "--raw",
      "print raw response text instead of parsed JSON where supported, and API error responses in full",
      false,
    )
    .addOption(
      new Option(
        "--retries <n>",
        `retries for rate-limited (429) responses and transient GET failures; default ${DEFAULT_RETRIES}`,
      ).env("EXCALIDRAW_RETRIES"),
    )
    .addOption(
      new Option(
        "--request-timeout <ms>",
        `deadline for each API request attempt, including reading the response; default ${DEFAULT_REQUEST_TIMEOUT_MS} ms`,
      ).env("EXCALIDRAW_REQUEST_TIMEOUT"),
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
  $ excalidraw whoami
  $ excalidraw scenes list --all --output table
  $ excalidraw scenes content get <sceneId> --out scene.json
  $ excalidraw scenes render <sceneId> --out scene.png
  $ excalidraw logs list --operation update --limit 10

SETUP
  render and mermaid work right away: they only need Chrome, Chromium, Edge or Firefox installed.
  For Excalidraw+ commands, run "excalidraw login" once to save an API key. In scripts and CI, set EXCALIDRAW_API_KEY or pass --api-key instead; both take precedence over the saved key.
  Use --api-url for development, staging, or self-hosted API origins. Pass the origin only; /api/v1 is added automatically. Saved keys are per origin.
  Run "excalidraw whoami" to confirm which workspace, key type and credential source the CLI is using.

OUTPUT
  Commands print formatted JSON by default. Use --output table for readable lists, or --raw for the raw API response text.
  Render and mermaid commands with --out - write only the image or scene to stdout, without a JSON summary.
  List commands accept --all to fetch every page. Retry notices are written to stderr so stdout stays machine-readable.

LEARN MORE
  Use "excalidraw <command> <subcommand> --help" for command-specific guidance.
`,
    )
    .showHelpAfterError()
    .showSuggestionAfterError();

  program.configureHelp({
    styleTitle: helpTheme.title,
    styleUsage: helpTheme.usage,
    styleCommandText: helpTheme.command,
    styleCommandDescription: helpTheme.description,
    styleOptionDescription: helpTheme.description,
    styleSubcommandDescription: helpTheme.description,
    styleArgumentDescription: helpTheme.description,
    styleDescriptionText: helpTheme.description,
    styleOptionText: helpTheme.option,
    styleOptionTerm: helpTheme.option,
    styleSubcommandText: helpTheme.subcommand,
    styleSubcommandTerm: helpTheme.subcommand,
    styleArgumentText: helpTheme.argument,
    styleArgumentTerm: helpTheme.argument,
  });

  program.commandsGroup("NO ACCOUNT NEEDED");
  registerRenderCommand(program);
  registerMermaidCommand(program);
  registerUpdateCommand(program);
  // Created now so it joins this group instead of a group of its own.
  program.helpCommand(true);

  program.commandsGroup("EXCALIDRAW+ (needs an API key, see login)");
  registerLoginCommands(program);
  registerWhoamiCommand(program);
  registerScenesCommands(program);
  registerCollectionsCommands(program);
  registerWorkspaceCommands(program);
  registerLogsCommands(program);

  return program;
}
