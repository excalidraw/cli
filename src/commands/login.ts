import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import { Command } from "commander";
import { ApiError, createClient } from "../client.js";
import { DEFAULT_API_URL, parseGlobalOptions } from "../config.js";
import { credentialsPath, readCredential, removeCredential, saveCredential } from "../credentials.js";
import { stripControlCharacters } from "../io.js";
import { FREE_GROUP, PLUS_GROUP } from "../help.js";
import { packageJson } from "../package.js";
import { brandBadge, freeAccent, plusAccent } from "../theme.js";
import { fetchWorkspaceSummary } from "./whoami.js";

import type { GlobalOptions } from "../config.js";

const API_KEY_DOCS_URL = "https://plus.excalidraw.com/docs/api/authentication";

export function registerLoginCommands(program: Command) {
  program
    .command("login")
    .summary("Log in to Excalidraw+ and save an API key for later commands")
    .description(
      "Pick a login method, check the API key against the API, and save it for the API origin. Later commands use the saved key unless --api-key or EXCALIDRAW_API_KEY is set. render and mermaid don't need a login.",
    )
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw login
  $ excalidraw login --api-key uk-...
  $ excalidraw login --api-url https://staging.example.com

NOTES
  Need a key? Create one in Excalidraw+ under Account settings → MCP/API key (personal) or Workspace settings → MCP/API Keys. See ${API_KEY_DOCS_URL}
  Logging in with the browser (OAuth) is coming soon.
  --api-key skips the prompts, e.g. in scripts.
  Keys are saved in ${credentialsPath()}, one per --api-url.
`,
    )
    .action(async (_options, command: Command) => {
      const options = parseGlobalOptions(command);
      // Only a key typed on the command line counts as an answer: EXCALIDRAW_API_KEY is often set
      // for other reasons, and saving it silently would surprise.
      const fromFlag = command.getOptionValueSourceWithGlobals("apiKey") === "cli" ? options.apiKey : undefined;

      if (fromFlag) {
        const { workspace, warning } = await logIn(options, fromFlag);
        console.error(chalk.green(loggedInMessage(workspace)));
        if (warning) {
          console.error(chalk.yellow(warning));
        }
      } else {
        await logInInteractively(options);
      }

      warnAboutEnvironmentKey("EXCALIDRAW_API_KEY is set, so commands use it instead of the saved key. Unset it to use the saved key.");
    });

  program
    .command("logout")
    .summary("Remove the saved API key")
    .description("Remove the API key that login saved for the API origin.")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw logout
  $ excalidraw logout --api-url https://staging.example.com

NOTES
  logout prints a confirmation, not JSON, and succeeds when no key was saved. The key itself stays valid: to revoke it, delete it in Excalidraw+.
`,
    )
    .action(async (_options, command: Command) => {
      const options = parseGlobalOptions(command);

      if (await removeCredential(options.apiUrl)) {
        console.error(chalk.green(`Logged out of ${options.apiUrl}`));
      } else {
        console.error(`No key was saved for ${options.apiUrl}`);
      }

      warnAboutEnvironmentKey("EXCALIDRAW_API_KEY is still set, so commands keep using it.");
    });
}

async function logInInteractively(options: GlobalOptions) {
  if (!process.stdin.isTTY) {
    throw new Error(
      'excalidraw login asks for the key in a terminal. In scripts, pass it with "excalidraw login --api-key <key>", or set EXCALIDRAW_API_KEY instead of logging in.',
    );
  }

  // Loaded on demand, so other commands don't pay for it.
  const prompts = await import("@clack/prompts");
  // Prompts go to stderr, which every command keeps for messages to people.
  const output = process.stderr;
  const cancelled = () => new Error("Login cancelled. Nothing was saved.");
  // The default API is Excalidraw+ itself; other origins are named, so a staging key isn't mistaken for production.
  const target = options.apiUrl === DEFAULT_API_URL ? "Excalidraw+" : options.apiUrl;

  output.write(banner());
  const saved = savedCredential(options.apiUrl)
    ? `\n${chalk.dim("You're already logged in; a new key replaces the saved one.")}`
    : "";

  const method = await prompts.select({
    message: `Log in to ${target}?${saved}`,
    options: [
      { value: "api-key", label: "Paste an API key" },
      { value: "oauth", label: "Log in with the browser", hint: "coming soon", disabled: true },
      { value: "skip", label: "Not now, keep using the free CLI (no account needed)" },
    ],
    output,
  });
  if (prompts.isCancel(method)) {
    throw cancelled();
  }
  if (method === "skip") {
    prompts.outro(
      ["No problem, nothing saved.", `   ${chalk.dim("Try")} ${chalk.cyan("excalidraw render drawing.excalidraw --out drawing.png")}`].join("\n"),
      { output },
    );
    return;
  }

  prompts.log.message(
    [
      "Create one in Excalidraw+ under Account settings → MCP/API key,",
      "or Workspace settings → MCP/API Keys for a workspace key.",
      chalk.dim(API_KEY_DOCS_URL),
    ].join("\n"),
    { output },
  );
  const apiKey = await prompts.password({
    message: "Paste your API key:",
    validate: (value) => (value?.trim() ? undefined : "Paste an API key, or press Ctrl+C to cancel."),
    output,
  });
  if (prompts.isCancel(apiKey)) {
    throw cancelled();
  }

  const spinner = prompts.spinner({ output });
  spinner.start("Checking the key");

  try {
    const { workspace, warning, keyType } = await logIn(options, apiKey.trim());
    spinner.stop("Key accepted");
    if (warning) {
      prompts.log.warn(warning, { output });
    }
    prompts.outro(
      [
        `${chalk.green(loggedInMessage(workspace))} ${chalk.dim(`(${keyType === "personal" ? "personal" : "workspace"} key)`)}`,
        `   ${chalk.dim("Try")} ${chalk.cyan("excalidraw scenes list --output table")}`,
      ].join("\n"),
      { output },
    );
  } catch (error) {
    spinner.error("Login failed");
    throw error;
  }
}

/** What works without an account, next to what logging in adds. */
const FEATURES = [
  [".excalidraw → PNG or SVG", "scenes and collections"],
  ["each frame → its own image", "public links and presentations"],
  ["Mermaid → editable diagram", "render and edit workspace scenes"],
  ["dark, transparent, 16× scale", "members, invites, audit logs"],
];

/** The CLI's name, then what works without an account next to what logging in adds. */
function banner() {
  const column = 33;
  const pad = (text: string) => text + " ".repeat(Math.max(column - stripVTControlCharacters(text).length, 1));
  const free = (text: string) => text.replace("→", chalk.dim("→"));
  return [
    "",
    `  ${brandBadge("✎ Excalidraw CLI")} ${chalk.dim(`v${packageJson.version} · excalidraw.com`)}`,
    "",
    `  ${pad(freeAccent.bold(FREE_GROUP))}${plusAccent.bold(PLUS_GROUP)}`,
    ...FEATURES.map(([left, right]) => `  ${pad(`${freeAccent("✓")} ${free(left)}`)}${plusAccent("✓")} ${right}`),
    "",
    `  ${plusAccent("✦")} ${chalk.bold("Great with AI agents:")} ${chalk.dim("JSON output, stdin and stdout, EXCALIDRAW_API_KEY")}`,
    "",
  ].join("\n");
}

/** Whether a key is saved for the origin. A damaged file counts as none: logging in replaces it. */
function savedCredential(apiUrl: string) {
  try {
    return readCredential(apiUrl) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Checks the key against the API, then saves it for the API origin. A rejected key isn't saved.
 * Returns the key's workspace, or null with a warning when the API won't show it.
 */
async function logIn(options: GlobalOptions, apiKey: string) {
  const client = createClient({ ...options, apiKey });
  let workspace: Awaited<ReturnType<typeof fetchWorkspaceSummary>> | null = null;
  let warning: string | undefined;

  try {
    workspace = await fetchWorkspaceSummary(client);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw new Error(`The API rejected the key (HTTP 401: ${error.message}), so it was not saved.`, { cause: error });
    }
    if (!(error instanceof ApiError && error.status === 403)) {
      throw error;
    }
    // The key is valid, but it lacks the permission to read the workspace, or the workspace was
    // canceled or removed. The API's message says which.
    warning = `Saved the key, but the API refused to show its workspace (HTTP 403: ${stripControlCharacters(error.message)}).`;
  }

  await saveCredential(options.apiUrl, { type: "api-key", apiKey });

  return { workspace, warning, keyType: client.keyType };
}

function loggedInMessage(workspace: { name: string } | null) {
  return workspace ? `Logged in to ${stripControlCharacters(workspace.name)}` : "Logged in";
}

/** The variable takes precedence over the saved key, which could make login and logout look like they did nothing. */
function warnAboutEnvironmentKey(message: string) {
  if (process.env.EXCALIDRAW_API_KEY?.trim()) {
    console.error(chalk.yellow(message));
  }
}
