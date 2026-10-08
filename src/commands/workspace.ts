import { Command } from "commander";
import { apiPath, getClient } from "../client.js";
import { emitOutput } from "../output.js";
import { inviteTable, userTable } from "../tables.js";
import { asListCommand } from "./list.js";
import {
  InviteCreateOptionsSchema,
  InviteLinkCreateOptionsSchema,
  InviteUpdateOptionsSchema,
  WorkspaceUpdateOptionsSchema,
  WorkspaceUserUpdateOptionsSchema,
  parseOptions,
} from "../schemas.js";

export function registerWorkspaceCommands(program: Command) {
  const workspace = program
    .command("workspace")
    .summary("View and administer the current workspace")
    .description("Manage workspace metadata, users, and invites for the API key's workspace.")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw workspace get
  $ excalidraw workspace users list --limit 50
  $ excalidraw workspace invites create --email teammate@example.com --role member
  $ excalidraw workspace invites create-link --role member --max-uses 10

NOTES
  All workspace commands operate on the workspace associated with the API key.
`,
    );

  workspace
    .command("get")
    .summary("Show current workspace metadata")
    .description("Return workspace metadata, including its name, picture, subscription status, and user IDs.")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw workspace get
`,
    )
    .action(async (_options, command: Command) => {
      const result = await getClient(command).request("GET", "/workspaces");
      emitOutput(command, result);
    });

  workspace
    .command("update")
    .summary("Update workspace metadata")
    .description("Rename the workspace or change its picture.")
    .option("--name <name>", "new workspace name")
    .option("--picture <url>", "new workspace picture URL, or \"none\" to remove it")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw workspace update --name "Design team"
  $ excalidraw workspace update --picture https://example.com/workspace.png
  $ excalidraw workspace update --picture none

NOTES
  Provide at least one field to update. Omitted fields stay unchanged.
`,
    )
    .action(async (options, command: Command) => {
      const body = parseOptions(WorkspaceUpdateOptionsSchema, options);
      const result = await getClient(command).request("PATCH", "/workspaces", { body });
      emitOutput(command, result);
    });

  registerWorkspaceUsersCommands(workspace);
  registerWorkspaceInvitesCommands(workspace);
}

function registerWorkspaceUsersCommands(workspace: Command) {
  const users = workspace
    .command("users")
    .summary("List, inspect, update, or remove workspace users")
    .description("Manage users who currently have access to the workspace.")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw workspace users list --limit 50
  $ excalidraw workspace users get <userId>
  $ excalidraw workspace users update <userId> --role admin
  $ excalidraw workspace users remove <userId>
`,
    );

  asListCommand(
    users
      .command("list")
      .summary("List workspace users")
      .description("Return users in the current workspace with their workspace roles."),
    {
      noun: "users",
      path: () => "/workspaces/users",
      table: userTable,
      examples: [
        "excalidraw workspace users list",
        "excalidraw workspace users list --limit 100",
        "excalidraw workspace users list --all --output table",
      ],
      notes: ["Use this to discover user IDs before role updates or removals."],
    },
  );

  users
    .command("get")
    .summary("Show one workspace user")
    .description("Get profile metadata and workspace role for a specific user.")
    .argument("<userId>", "workspace user ID")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw workspace users get <userId>
`,
    )
    .action(async (userId: string, _options, command: Command) => {
      const result = await getClient(command).request("GET", apiPath`/workspaces/users/${userId}`);
      emitOutput(command, result);
    });

  users
    .command("update")
    .summary("Update a workspace user")
    .description("Update a user's display metadata or workspace role.")
    .argument("<userId>", "workspace user ID to update")
    .option("--name <name>", "new user display name")
    .option("--picture <url>", "new user picture URL, or \"none\" to remove it")
    .option("--role <role>", "workspace role to assign: member or admin")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw workspace users update <userId> --role admin
  $ excalidraw workspace users update <userId> --name "Ada Lovelace"
  $ excalidraw workspace users update <userId> --picture none

NOTES
  Email updates are not supported by the public API.
  Downgrading the sole workspace admin fails.
`,
    )
    .action(async (userId: string, options, command: Command) => {
      const body = parseOptions(WorkspaceUserUpdateOptionsSchema, options);
      const result = await getClient(command).request("PATCH", apiPath`/workspaces/users/${userId}`, {
        body,
      });
      emitOutput(command, result);
    });

  users
    .command("remove")
    .summary("Remove a user from the workspace")
    .description("Revoke a user's access to the current workspace.")
    .argument("<userId>", "workspace user ID to remove")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw workspace users remove <userId>

NOTES
  Removing a user revokes workspace access, workspace/team membership, permissions, and that user's API keys for this workspace.
  It does not delete the global user account. Removing the sole workspace admin fails.
`,
    )
    .action(async (userId: string, _options, command: Command) => {
      const result = await getClient(command).request("DELETE", apiPath`/workspaces/users/${userId}`);
      emitOutput(command, result);
    });
}

function registerWorkspaceInvitesCommands(workspace: Command) {
  const invites = workspace
    .command("invites")
    .summary("Manage email invites and invite links")
    .description("Create, inspect, update, and revoke workspace invites.")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw workspace invites list --limit 50
  $ excalidraw workspace invites create --email teammate@example.com --role member
  $ excalidraw workspace invites create-link --role admin --max-uses 1
  $ excalidraw workspace invites delete <inviteId>
`,
    );

  asListCommand(
    invites
      .command("list")
      .summary("List workspace invites")
      .description("Return pending and active invites for the current workspace."),
    {
      noun: "invites",
      path: () => "/workspaces/invites",
      table: inviteTable,
      examples: [
        "excalidraw workspace invites list",
        "excalidraw workspace invites list --limit 100",
        "excalidraw workspace invites list --all --output table",
      ],
      notes: ["Use this to discover invite IDs before updating or revoking invites."],
    },
  );

  invites
    .command("get")
    .summary("Show one workspace invite")
    .description("Get status, role, usage limits, and metadata for a workspace invite.")
    .argument("<inviteId>", "workspace invite ID")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw workspace invites get <inviteId>
`,
    )
    .action(async (inviteId: string, _options, command: Command) => {
      const result = await getClient(command).request("GET", apiPath`/workspaces/invites/${inviteId}`);
      emitOutput(command, result);
    });

  invites
    .command("create")
    .summary("Create an email invite")
    .description("Invite one email address to join the workspace with a member or admin role.")
    .requiredOption("--email <email>", "email address to invite")
    .requiredOption("--role <role>", "workspace role to grant: member or admin")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw workspace invites create --email teammate@example.com --role member
  $ excalidraw workspace invites create --email lead@example.com --role admin
`,
    )
    .action(async (options, command: Command) => {
      const body = parseOptions(InviteCreateOptionsSchema, options);
      const result = await getClient(command).request("POST", "/workspaces/invites", { body });
      emitOutput(command, result);
    });

  invites
    .command("create-link")
    .summary("Create an invite link")
    .description("Create a workspace invite link that can be redeemed a set number of times.")
    .requiredOption("--role <role>", "workspace role granted by the link: member or admin")
    .option(
      "--max-uses <number|unlimited>",
      "number of times the link can be redeemed, or \"unlimited\"; default 1",
    )
    .option(
      "--restricted-domains <domains>",
      "comma-separated email domains allowed to redeem the link, for example example.com,example.org",
    )
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw workspace invites create-link --role member
  $ excalidraw workspace invites create-link --role admin --max-uses 1
  $ excalidraw workspace invites create-link --role member --max-uses unlimited
  $ excalidraw workspace invites create-link --role member --restricted-domains example.com,example.org

NOTES
  Links are single-use unless you pass --max-uses. Use "unlimited" for a link that never runs out.
  --restricted-domains limits redemption to users whose email matches one of the domains.
`,
    )
    .action(async (options, command: Command) => {
      const body = parseOptions(InviteLinkCreateOptionsSchema, options);
      const result = await getClient(command).request("POST", "/workspaces/invites", { body });
      emitOutput(command, result);
    });

  invites
    .command("update")
    .summary("Update a workspace invite")
    .description("Change an invite's email address, role, or maximum usage count.")
    .argument("<inviteId>", "workspace invite ID to update")
    .option("--email <email>", "new invitee email for email invites")
    .option("--role <role>", "workspace role to grant: member or admin")
    .option("--max-uses <number|unlimited>", "maximum number of invite redemptions, or \"unlimited\"")
    .option(
      "--restricted-domains <domains>",
      "comma-separated email domains allowed to redeem the link, or \"none\" to remove the restriction",
    )
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw workspace invites update <inviteId> --role admin
  $ excalidraw workspace invites update <inviteId> --max-uses 5
  $ excalidraw workspace invites update <inviteId> --restricted-domains example.com
  $ excalidraw workspace invites update <inviteId> --restricted-domains none

NOTES
  Provide at least one field to update. Omitted fields stay unchanged.
  Email invites cannot update max uses or restricted domains. Link invites cannot update email.
`,
    )
    .action(async (inviteId: string, options, command: Command) => {
      const body = parseOptions(InviteUpdateOptionsSchema, options);
      const result = await getClient(command).request("PATCH", apiPath`/workspaces/invites/${inviteId}`, {
        body,
      });
      emitOutput(command, result);
    });

  invites
    .command("delete")
    .summary("Revoke a workspace invite")
    .description("Delete an invite so the email invitation or invite link can no longer be used.")
    .argument("<inviteId>", "workspace invite ID to revoke")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw workspace invites delete <inviteId>

NOTES
  Revoking an invite prevents future redemption but does not remove users who already joined.
  Only pending invites can be revoked; redeemed invites return an error.
`,
    )
    .action(async (inviteId: string, _options, command: Command) => {
      const result = await getClient(command).request("DELETE", apiPath`/workspaces/invites/${inviteId}`);
      emitOutput(command, result);
    });
}
