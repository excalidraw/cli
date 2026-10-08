import { Command, Option } from "commander";
import { registerCollectionsCommands } from "./commands/collections.js";
import { registerLogsCommands } from "./commands/logs.js";
import { registerScenesCommands } from "./commands/scenes.js";
import { registerWhoamiCommand } from "./commands/whoami.js";
import { registerWorkspaceCommands } from "./commands/workspace.js";
import { registerRenderCommand } from "./commands/render.js";
import { registerUpdateCommand } from "./commands/update.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_RETRIES } from "./config.js";
import { packageJson } from "./package.js";
import { helpTheme } from "./theme.js";

export function createProgram() {
  const program = new Command();

  program
    .name("excalidraw")
    .description("Manage Excalidraw workspace resources and render scenes locally.")
    .version(packageJson.version, "-v, --version", "print the CLI version")
    .commandsGroup("CORE COMMANDS")
    .optionsGroup("GLOBAL FLAGS")
    .addOption(
      new Option("--api-url <url>", "API origin; default https://api.excalidraw.com").env(
        "EXCALIDRAW_API_URL",
      ),
    )
    .addOption(new Option("--api-key <key>", "API key").env("EXCALIDRAW_API_KEY"))
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
  $ excalidraw whoami
  $ excalidraw scenes list --limit 25
  $ excalidraw scenes list --all --output table
  $ excalidraw scenes get <sceneId>
  $ excalidraw scenes content get <sceneId> --out scene.json
  $ excalidraw scenes render <sceneId> --out scene.png
  $ excalidraw render drawing.excalidraw --out drawing.png
  $ excalidraw logs list --operation update --limit 10

SETUP
  Set EXCALIDRAW_API_KEY for non-interactive use, or pass --api-key per command.
  Local "render" commands do not require an API key.
  Use --api-url for development, staging, or self-hosted API origins. Pass the origin only; /api/v1 is added automatically.
  Run "excalidraw whoami" to confirm which workspace and key type the CLI is using.

OUTPUT
  Commands print formatted JSON by default. Use --output table for readable lists, or --raw for the raw API response text.
  Render commands with --out - write only binary PNG to stdout, without a JSON summary.
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

  registerWhoamiCommand(program);
  registerScenesCommands(program);
  registerRenderCommand(program);
  registerCollectionsCommands(program);
  registerWorkspaceCommands(program);
  registerLogsCommands(program);
  registerUpdateCommand(program);

  return program;
}
