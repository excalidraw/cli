import { Command } from "commander";
import { z } from "zod/v4";
import { getClient } from "../client.js";
import { emitOutput } from "../output.js";
import { keyValueTable } from "../tables.js";

const WorkspaceSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    subscriptionStatus: z.string(),
    users: z.array(z.unknown()).optional(),
  })
  .loose();

export function registerWhoamiCommand(program: Command) {
  program
    .command("whoami")
    .summary("Show which workspace and key type the CLI is using")
    .description(
      "Validate the configured API key by fetching its workspace, and report the key type and API origin.",
    )
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw whoami
  $ excalidraw whoami --output table
  $ excalidraw whoami --api-key uk-... --api-url https://staging.example.com

NOTES
  Run this first when a command fails with HTTP 401 or 403. It shows which workspace the key
  belongs to and whether it is a personal (uk-) or workspace key.
  A workspace key limited to certain permissions can get HTTP 403 here even though it is valid.
`,
    )
    .action(async (_options, command: Command) => {
      const client = getClient(command);
      const workspace = WorkspaceSummarySchema.parse(
        await client.request("GET", "/workspaces", { raw: false }),
      );

      emitOutput(
        command,
        {
          apiUrl: client.apiUrl,
          keyType: client.keyType,
          workspace: {
            id: workspace.id,
            name: workspace.name,
            subscriptionStatus: workspace.subscriptionStatus,
            userCount: workspace.users?.length ?? null,
          },
        },
        keyValueTable,
      );
    });
}
