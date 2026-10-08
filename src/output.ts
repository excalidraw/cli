import { getOutputOptions } from "./config.js";
import { printOutput } from "./io.js";
import { formatTable } from "./table.js";

import type { Command } from "commander";
import type { TableSpec } from "./table.js";

/**
 * Prints a command result honoring the global --output flag. Raw text is always
 * printed verbatim. Commands without a table spec fall back to JSON.
 */
export function emitOutput(command: Command, value: unknown, table?: TableSpec) {
  const { output } = getOutputOptions(command.optsWithGlobals());

  if (typeof value === "string") {
    printOutput(value);
    return;
  }

  if (output === "table" && table) {
    printOutput(formatTable(table.rows(value), table.columns));
    return;
  }

  printOutput(value);
}
