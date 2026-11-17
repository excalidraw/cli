import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import { Command } from "commander";
import { ApiError, createClient } from "../client.js";
import { DEFAULT_API_URL, parseGlobalOptions } from "../config.js";
import { credentialsPath, readCredential, removeCredential, saveCredential } from "../credentials.js";
import { stripControlCharacters } from "../io.js";
import { FREE_GROUP, PLUS_GROUP } from "../help.js";
import { OAuthError, logInWithBrowser, revokeOAuthCredential } from "../oauth.js";
import { packageJson } from "../package.js";
import { brandBadge, freeAccent, plusAccent } from "../theme.js";
import { fetchWorkspaceSummary } from "./whoami.js";

import type { GlobalOptions } from "../config.js";
import type { Credential } from "../credentials.js";

const API_KEY_DOCS_URL = "https://plus.excalidraw.com/docs/api/authentication";

export function registerLoginCommands(program: Command) {
  program
    .command("login")
    .summary("Log in to Excalidraw+ for later commands")
    .description(
      "Log in with the browser, or with an API key, check the login against the API, and save it for the API origin. Later commands use it unless --api-key or EXCALIDRAW_API_KEY is set. render and mermaid don't need a login.",
    )
    .option("--web", "log in with the browser without asking")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw login
  $ excalidraw login --web
  $ excalidraw login --api-key uk-...
  $ excalidraw login --api-url https://staging.example.com

NOTES
  Logging in with the browser asks you to pick a workspace and allow the CLI. It then acts as you in that workspace, like a personal API key, and stays logged in until you log out or disconnect "Excalidraw CLI" in Excalidraw+ under Settings → Connected apps.
  The browser opens on this computer: it sends the login back to the CLI on 127.0.0.1. Over SSH, log in with an API key instead. BROWSER picks the browser command.
  Need a key? Create one in Excalidraw+ under Account settings → MCP/API key (personal) or Workspace settings → MCP/API Keys. See ${API_KEY_DOCS_URL}
  --api-key skips the prompts, e.g. in scripts.
  Logins are saved in ${credentialsPath()}, one per --api-url.
`,
    )
    .action(async (options: { web?: boolean }, command: Command) => {
      const globalOptions = parseGlobalOptions(command);
      // Only a key typed on the command line counts as an answer: EXCALIDRAW_API_KEY is often set
      // for other reasons, and saving it silently would surprise.
      const fromFlag = command.getOptionValueSourceWithGlobals("apiKey") === "cli" ? globalOptions.apiKey : undefined;

      if (fromFlag && options.web) {
        throw new Error("Pass either --web or --api-key, not both.");
      }

      if (fromFlag) {
        const { workspace, warning } = await verifyAndSave(globalOptions, { type: "api-key", apiKey: fromFlag });
        console.error(chalk.green(loggedInMessage(workspace)));
        if (warning) {
          console.error(chalk.yellow(warning));
        }
      } else if (options.web) {
        await logInWithBrowserPlainly(globalOptions);
      } else {
        await logInInteractively(globalOptions);
      }

      warnAboutEnvironmentKey("EXCALIDRAW_API_KEY is set, so commands use it instead of the saved login. Unset it to use the saved login.");
    });

  program
    .command("logout")
    .summary("Remove the saved login")
    .description("Remove the API key or browser login that login saved for the API origin, and revoke a browser login.")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw logout
  $ excalidraw logout --api-url https://staging.example.com

NOTES
  logout prints a confirmation, not JSON, and succeeds when nothing was saved.
  A browser login is revoked, so its tokens stop working. An API key stays valid: to revoke it, delete it in Excalidraw+.
`,
    )
    .action(async (_options, command: Command) => {
      const options = parseGlobalOptions(command);
      const saved = savedCredential(options.apiUrl);
      let revokeWarning: string | undefined;

      if (saved?.type === "oauth") {
        try {
          await revokeOAuthCredential(saved, { timeout: options.requestTimeout });
        } catch (error) {
          // The saved tokens go either way: logging out must work offline and with a dead login.
          // A server that turned the token down knows it no longer works (it was revoked, or the app
          // disconnected), so only a server that couldn't be asked leaves something to cut off.
          if (!isTokenRefusal(error)) {
            revokeWarning = `Couldn't revoke the browser login (${error instanceof Error ? stripControlCharacters(error.message) : String(error)}). To cut it off, disconnect "Excalidraw CLI" in Excalidraw+ under Settings → Connected apps.`;
          }
        }
      }

      if (await removeCredential(options.apiUrl)) {
        console.error(chalk.green(`Logged out of ${options.apiUrl}`));
      } else {
        console.error(`No login was saved for ${options.apiUrl}`);
      }
      if (revokeWarning) {
        console.error(chalk.yellow(revokeWarning));
      }

      warnAboutEnvironmentKey("EXCALIDRAW_API_KEY is still set, so commands keep using it.");
    });
}

async function logInInteractively(options: GlobalOptions) {
  if (!process.stdin.isTTY) {
    throw new Error(
      'excalidraw login asks how to log in in a terminal. In scripts, pass a key with "excalidraw login --api-key <key>", log in with the browser with "excalidraw login --web", or set EXCALIDRAW_API_KEY instead of logging in.',
    );
  }

  // Loaded on demand, so other commands don't pay for it.
  const prompts = await import("@clack/prompts");
  // Prompts go to stderr, which every command keeps for messages to people.
  const output = process.stderr;
  const cancelled = () => new Error("Login cancelled. Nothing was saved.");
  // The default API is Excalidraw+ itself; other origins are named, so a staging login isn't mistaken for production.
  const target = options.apiUrl === DEFAULT_API_URL ? "Excalidraw+" : options.apiUrl;

  output.write(banner());
  const saved = savedCredential(options.apiUrl)
    ? `\n${chalk.dim("You're already logged in; a new login replaces the saved one.")}`
    : "";

  const method = await prompts.select({
    message: `Log in to ${target}?${saved}`,
    options: [
      { value: "browser", label: "Log in with the browser", hint: "recommended" },
      { value: "api-key", label: "Paste an API key" },
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

  let credential: Credential;
  let spinner = prompts.spinner({ output });

  if (method === "browser") {
    spinner.start("Connecting to Excalidraw+");
    try {
      credential = await logInWithBrowser({
        apiUrl: options.apiUrl,
        timeout: options.requestTimeout,
        onAuthorizationUrl: (url, opened) => {
          // A spinner redraws its line, so the link goes on a line of its own, between two spinners.
          spinner.stop(opened ? "Opened the browser" : "Couldn't open a browser");
          prompts.log.message(
            opened
              ? `If it didn't open, go to:\n${chalk.cyan(url)}`
              : `Open this link in a browser on this computer to log in:\n${chalk.cyan(url)}`,
            { output },
          );
          spinner = prompts.spinner({ output });
          spinner.start("Waiting for you to allow the CLI in the browser");
        },
      });
    } catch (error) {
      spinner.error("Login failed");
      throw error;
    }
    spinner.message("Checking the login");
  } else {
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
    credential = { type: "api-key", apiKey: apiKey.trim() };
    spinner.start("Checking the key");
  }

  try {
    const { workspace, warning, keyType } = await verifyAndSave(options, credential);
    spinner.stop(method === "browser" ? "Logged in with the browser" : "Key accepted");
    if (warning) {
      prompts.log.warn(warning, { output });
    }
    prompts.outro(
      [
        `${chalk.green(loggedInMessage(workspace))} ${chalk.dim(`(${describeLogin(keyType)})`)}`,
        `   ${chalk.dim("Try")} ${chalk.cyan("excalidraw scenes list --output table")}`,
      ].join("\n"),
      { output },
    );
  } catch (error) {
    spinner.error("Login failed");
    throw error;
  }
}

/** --web: the browser login without prompts, for terminals the prompts can't draw in. */
async function logInWithBrowserPlainly(options: GlobalOptions) {
  const credential = await logInWithBrowser({
    apiUrl: options.apiUrl,
    timeout: options.requestTimeout,
    onAuthorizationUrl: (url, opened) => {
      console.error(
        opened
          ? `Allow the CLI in the browser that opened. If it didn't open, go to:\n${url}`
          : `Open this link in a browser on this computer to log in:\n${url}`,
      );
    },
  });
  const { workspace, warning } = await verifyAndSave(options, credential);
  console.error(chalk.green(loggedInMessage(workspace)));
  if (warning) {
    console.error(chalk.yellow(warning));
  }
}

/** The authorization server answered the revocation with an error about the token, not a failure of its own. */
function isTokenRefusal(error: unknown) {
  return error instanceof OAuthError && !/^http_5\d\d$/.test(error.code);
}

function describeLogin(keyType: "personal" | "workspace" | "oauth") {
  return keyType === "oauth" ? "browser login" : `${keyType} key`;
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

/** The login saved for the origin. A damaged file, or a login a newer CLI saved, counts as none: logging in replaces it. */
function savedCredential(apiUrl: string) {
  try {
    return readCredential(apiUrl);
  } catch {
    return undefined;
  }
}

/**
 * Checks the key or browser login against the API, then saves it for the API origin. A rejected one
 * isn't saved. Returns the workspace, or null with a warning when the API won't show it.
 */
async function verifyAndSave(options: GlobalOptions, credential: Credential) {
  const client = createClient({ ...options, credential });
  const what = credential.type === "api-key" ? "key" : "login";
  let workspace: Awaited<ReturnType<typeof fetchWorkspaceSummary>> | null = null;
  let warning: string | undefined;

  try {
    workspace = await fetchWorkspaceSummary(client);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw new Error(`The API rejected the ${what} (HTTP 401: ${error.message}), so it was not saved.`, { cause: error });
    }
    if (!(error instanceof ApiError && error.status === 403)) {
      throw error;
    }
    // The key is valid, but it lacks the permission to read the workspace, or the workspace was
    // canceled or removed. The API's message says which.
    warning = `Saved the ${what}, but the API refused to show its workspace (HTTP 403: ${stripControlCharacters(error.message)}).`;
  }

  // A refresh while checking rotated a browser login's tokens: save the new ones.
  await saveCredential(options.apiUrl, client.oauthCredential ?? credential);

  return { workspace, warning, keyType: client.keyType };
}

function loggedInMessage(workspace: { name: string } | null) {
  return workspace ? `Logged in to ${stripControlCharacters(workspace.name)}` : "Logged in";
}

/** The variable takes precedence over the saved login, which could make login and logout look like they did nothing. */
function warnAboutEnvironmentKey(message: string) {
  if (process.env.EXCALIDRAW_API_KEY?.trim()) {
    console.error(chalk.yellow(message));
  }
}
