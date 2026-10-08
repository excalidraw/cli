import { Command } from "commander";
import { getClient } from "../client.js";
import { emitOutput } from "../output.js";
import { fetchAllLogs } from "../paginate.js";
import { LogsListOptionsSchema, parseOptions } from "../schemas.js";
import { logTable } from "../tables.js";

export function registerLogsCommands(program: Command) {
  const logs = program
    .command("logs")
    .summary("Query workspace audit logs")
    .description("Inspect workspace activity for auditing, debugging, and compliance workflows.")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw logs list --limit 25
  $ excalidraw logs list --user <userId> --operation update
  $ excalidraw logs list --action scene --date-from 2024-01-01 --date-to 2024-01-31

NOTES
  Use logs to understand which workspace, collection, scene, user, and invite changes happened.
`,
    );

  logs
    .command("list")
    .summary("List workspace audit log entries")
    .description(
      "Return audit logs with optional filters for user, action, operation, date range, and pagination.",
    )
    .option("--limit <number>", "maximum number of logs to return, from 1 to 100; default 50")
    .option("--cursor <cursor>", "nextCursor value from a previous response")
    .option("--page <page>", "page number, starting at 1; cannot be combined with --cursor")
    .option("--user <userId>", "only include logs for this user ID")
    .option("--action <action>", "only include a supported action from the response's availableActions list")
    .option("--operation <operation>", "only include operation: create, read, update, or delete")
    .option("--date-from <date>", "only include logs on or after this ISO 8601 date")
    .option("--date-to <date>", "only include logs on or before this ISO 8601 date")
    .option("--all", "follow nextCursor and print every matching log; --limit sets the page size")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw logs list --limit 25
  $ excalidraw logs list --cursor <nextCursor>
  $ excalidraw logs list --page 2 --limit 50
  $ excalidraw logs list --operation delete --date-from 2024-01-01
  $ excalidraw logs list --action workspace:invite --user <userId>
  $ excalidraw logs list --all --date-from 2024-01-01 --output table

NOTES
  Prefer cursor pagination for sequential scans. Use page pagination for page-number navigation.
  --all follows cursor pagination until hasMore is false and prints { count, logs, availableActions }.
  --all cannot be combined with --page; use --cursor to choose where the scan starts.
  The response includes availableActions; unsupported --action values are ignored by the API.
`,
    )
    .action(async (options, command: Command) => {
      const { all, ...query } = parseOptions(LogsListOptionsSchema, options);
      const client = getClient(command);
      const result = all
        ? await fetchAllLogs(client, query)
        : await client.request("GET", "/logs", { query });
      emitOutput(command, result, logTable);
    });
}
