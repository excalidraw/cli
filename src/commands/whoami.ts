import { Command } from "commander";
import { z } from "zod/v4";
import { createClient } from "../client.js";
import { resolveConfig } from "../config.js";
import { emitOutput } from "../output.js";
import { keyValueTable } from "../tables.js";

import type { PublicApiClient } from "../client.js";

const WorkspaceSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    subscriptionStatus: z.string(),
  })
  .loose();

/** Fetches the summary of the key's workspace that whoami and login print. */
export async function fetchWorkspaceSummary(client: PublicApiClient) {
  const workspace = WorkspaceSummarySchema.parse(await client.request("GET", "/workspaces", { raw: false }));

  return {
    id: workspace.id,
    name: workspace.name,
    subscriptionStatus: workspace.subscriptionStatus,
  };
}

export function registerWhoamiCommand(program: Command) {
  program
    .command("whoami")
    .summary("Show which workspace and key the CLI is using")
    .description(
      "Validate the configured API key by fetching its workspace, and report the key type, where the key came from, and the API origin.",
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
  credentialSource is "flag" for --api-key, "env" for EXCALIDRAW_API_KEY, or "login" for the
  key that "excalidraw login" saved. The flag and the variable take precedence over a saved key.
  A workspace key limited to certain permissions can get HTTP 403 here even though it is valid.
`,
    )
    .action(async (_options, command: Command) => {
      const config = resolveConfig(command);
      const client = createClient(config);
      const workspace = await fetchWorkspaceSummary(client);

      emitOutput(
        command,
        { apiUrl: client.apiUrl, keyType: client.keyType, credentialSource: config.credentialSource, workspace },
        keyValueTable,
      );
    });
}
