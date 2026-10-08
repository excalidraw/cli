import { Command } from "commander";
import { apiPath, getClient } from "../client.js";
import { emitOutput } from "../output.js";
import { createScene } from "../scene-content.js";
import { collectionTable, sceneTable } from "../tables.js";
import { asListCommand } from "./list.js";
import {
  CollectionCreateOptionsSchema,
  CollectionSceneCreateOptionsSchema,
  CollectionUpdateOptionsSchema,
  parseOptions,
} from "../schemas.js";

export function registerCollectionsCommands(program: Command) {
  const collections = program
    .command("collections")
    .summary("Organize scenes into workspace collections")
    .description("List, create, rename, delete, and populate collections in the current workspace.")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw collections list --limit 50
  $ excalidraw collections create --name "Product diagrams"
  $ excalidraw collections scenes list <collectionId>

NOTES
  Use collection IDs with scenes commands to scope list and create operations.
`,
    );

  asListCommand(
    collections
      .command("list")
      .summary("List workspace collections")
      .description("Return collection metadata for the current workspace with optional pagination."),
    {
      noun: "collections",
      path: () => "/collections",
      table: collectionTable,
      examples: [
        "excalidraw collections list",
        "excalidraw collections list --limit 100",
        "excalidraw collections list --all --output table",
      ],
      notes: ["Use this to discover collection IDs before creating or moving scenes."],
    },
  );

  collections
    .command("get")
    .summary("Show one collection")
    .description("Get metadata for a specific collection by ID.")
    .argument("<collectionId>", "collection ID returned by a list or create command")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw collections get <collectionId>
`,
    )
    .action(async (collectionId: string, _options, command: Command) => {
      const result = await getClient(command).request("GET", apiPath`/collections/${collectionId}`);
      emitOutput(command, result);
    });

  collections
    .command("create")
    .summary("Create a collection")
    .description("Create a workspace collection for grouping scenes by project, team, or topic.")
    .requiredOption("--name <name>", "name for the new collection")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw collections create --name "Roadmap"
`,
    )
    .action(async (options, command: Command) => {
      const body = parseOptions(CollectionCreateOptionsSchema, options);
      const result = await getClient(command).request("POST", "/collections", { body });
      emitOutput(command, result);
    });

  collections
    .command("update")
    .summary("Rename a collection")
    .description("Update collection metadata. Currently, collections can be renamed.")
    .argument("<collectionId>", "collection ID to update")
    .requiredOption("--name <name>", "new collection name")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw collections update <collectionId> --name "Architecture"
`,
    )
    .action(async (collectionId: string, options, command: Command) => {
      const body = parseOptions(CollectionUpdateOptionsSchema, options);
      const result = await getClient(command).request("PATCH", apiPath`/collections/${collectionId}`, {
        body,
      });
      emitOutput(command, result);
    });

  collections
    .command("delete")
    .summary("Move a collection and its scenes to trash")
    .description("Soft-delete a collection and every scene in it by moving them to trash. Nothing is permanently destroyed.")
    .argument("<collectionId>", "collection ID to move to trash")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw collections delete <collectionId>

NOTES
  Every scene in the collection is moved to trash along with it.
  Check collection contents before deletion with "collections scenes list".
`,
    )
    .action(async (collectionId: string, _options, command: Command) => {
      const result = await getClient(command).request("DELETE", apiPath`/collections/${collectionId}`);
      emitOutput(command, result);
    });

  const scenes = collections
    .command("scenes")
    .summary("List or create scenes inside a collection")
    .description("Work with scenes through a collection-scoped view.")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw collections scenes list <collectionId> --limit 25
  $ excalidraw collections scenes create <collectionId> --name "New diagram"
`,
    );

  asListCommand(
    scenes
      .command("list")
      .summary("List scenes in one collection")
      .description("Return scene metadata for a collection without fetching full canvas content.")
      .argument("<collectionId>", "collection ID to list scenes from"),
    {
      noun: "scenes",
      path: (collectionId) => apiPath`/collections/${collectionId}/scenes`,
      table: sceneTable,
      examples: [
        "excalidraw collections scenes list <collectionId>",
        "excalidraw collections scenes list <collectionId> --limit 100",
        "excalidraw collections scenes list <collectionId> --all --output table",
      ],
    },
  );

  scenes
    .command("create")
    .summary("Create a scene in a collection, optionally with content from a file")
    .description(
      "Create a scene in the selected collection. With --file, write its drawing content in the same run; without it, the scene starts empty.",
    )
    .argument("<collectionId>", "collection ID to create the scene in")
    .requiredOption("--name <name>", "name for the new scene")
    .option("--pinned", "pin the scene in the workspace UI", false)
    .option("--file <file>", "scene content JSON to write into the new scene; use - to read stdin")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw collections scenes create <collectionId> --name "Onboarding map"
  $ excalidraw collections scenes create <collectionId> --name "Pinned board" --pinned
  $ excalidraw collections scenes create <collectionId> --name "Imported" --file drawing.excalidraw

NOTES
  Without --file the created scene starts empty. Use "excalidraw scenes content patch" or "excalidraw scenes content put" to add canvas content.
  With --file, a full Excalidraw export is written via PUT and a partial payload is merged via PATCH; see "excalidraw scenes create --help".
`,
    )
    .action(async (collectionId: string, options, command: Command) => {
      const { file, ...body } = parseOptions(CollectionSceneCreateOptionsSchema, options);
      const path = apiPath`/collections/${collectionId}/scenes`;
      emitOutput(command, await createScene(getClient(command), path, body, file));
    });
}
