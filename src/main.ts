#!/usr/bin/env node

import chalk from "chalk";
import { ZodError } from "zod/v4";
import { ApiError } from "./client.js";
import { createProgram } from "./cli.js";
import { ConfigError } from "./config.js";
import { stripControlCharacters } from "./io.js";
import { helpTheme } from "./theme.js";
import { startUpdateCheck } from "./update.js";

// Handles every stdout write failure. It never exits the process, so pending cleanup (like closing
// the render browser) still runs. The stream is destroyed after the first error and later writes are dropped.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  // The reader closed the pipe early, e.g. `excalidraw scenes list --all | head`. Stop quietly.
  if (error.code === "EPIPE") {
    return;
  }
  // Report other write failures (e.g. a full disk) as a readable error rather than a crash.
  console.error(chalk.red(`Could not write to stdout: ${error.message}`));
  process.exitCode = 1;
});

const program = createProgram();
let updateCheck: ReturnType<typeof startUpdateCheck>;

// Runs only for commands that do something, not for --help, --version or usage errors.
program.hook("preAction", (_program, command) => {
  // `excalidraw update` looks up the latest version itself.
  if (command.parent !== program || command.name() !== "update") {
    updateCheck = startUpdateCheck();
  }
});

// Error messages can quote API responses and scene content, such as an element ID, that other users wrote.
function printError(style: (text: string) => string, text: string) {
  console.error(style(stripControlCharacters(text)));
}

/** Error bodies, such as a gateway's HTML page, are cut short unless --raw asks for all of it. */
const MAX_ERROR_BODY_LENGTH = 500;

function shortenErrorBody(body: string) {
  const characters = Array.from(body);
  if (characters.length <= MAX_ERROR_BODY_LENGTH) {
    return body;
  }
  const rest = characters.length - MAX_ERROR_BODY_LENGTH;
  return `${characters.slice(0, MAX_ERROR_BODY_LENGTH).join("")}… (${rest} more characters; use --raw to print the whole response)`;
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof ApiError) {
    printError(chalk.red, `HTTP ${error.status}: ${error.message}`);
    if (error.body) {
      printError(chalk.dim, program.opts().raw ? error.body : shortenErrorBody(error.body));
    }
  } else if (error instanceof ZodError) {
    for (const issue of error.issues) {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      printError(chalk.red, `${path}${issue.message}`);
    }
  } else if (error instanceof ConfigError) {
    console.error(chalk.red.bold("Configuration error:"));
    for (const issue of error.issues) {
      printError(helpTheme.description, `  - ${issue}`);
    }
  } else if (error instanceof Error) {
    printError(chalk.red, error.message);
  } else {
    console.error(chalk.red("Unknown error"));
  }

  process.exitCode = 1;
}

updateCheck?.finish();
