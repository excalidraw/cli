import { getClient } from "../client.js";
import { emitOutput } from "../output.js";
import { fetchAllPages } from "../paginate.js";
import { PaginationOptionsSchema, parseOptions } from "../schemas.js";

import type { Command } from "commander";
import type { z } from "zod/v4";
import type { TableSpec } from "../table.js";

type ListOptions = { all: boolean; limit?: number; offset?: number } & Record<
  string,
  string | number | boolean | undefined
>;

type ListSpec = {
  /** What the command lists, as help text names it, such as "scenes". */
  noun: string;
  /** The endpoint, built from the command's arguments. */
  path: (...args: string[]) => string;
  table: TableSpec;
  /** Full command lines, such as "excalidraw scenes list --limit 50". */
  examples: string[];
  notes?: string[];
  /** Defaults to --limit, --offset and --all; extend it for filters the command adds. */
  schema?: z.ZodType<ListOptions>;
};

/**
 * Makes `command` an offset-paginated list: adds --limit, --offset and --all, help in the shared
 * layout, and an action that prints one page or, with --all, every page combined.
 */
export function asListCommand(
  command: Command,
  { noun, path, table, examples, notes = [], schema = PaginationOptionsSchema }: ListSpec,
) {
  return command
    .option("--limit <number>", `maximum number of ${noun} to return, from 1 to 100; default 5`)
    .option("--offset <number>", `number of ${noun} to skip for offset pagination`)
    .option("--all", "fetch every page and print one combined list; --limit sets the page size")
    .addHelpText(
      "after",
      [
        "",
        "EXAMPLES",
        ...examples.map((example) => `  $ ${example}`),
        "",
        "NOTES",
        ...notes.map((note) => `  ${note}`),
        "  With --all the output is { count, data } instead of a single page with hasNextPage.",
        "",
      ].join("\n"),
    )
    .action(async function () {
      const { all, ...query } = parseOptions(schema, this.opts());
      const endpoint = path(...(this.processedArgs as string[]));
      const client = getClient(this);
      const result = all
        ? await fetchAllPages(client, endpoint, query)
        : await client.request("GET", endpoint, { query });
      emitOutput(this, result, table);
    });
}
