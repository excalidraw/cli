import { Command } from "commander";
import { apiPath, getClient } from "../client.js";
import { readJsonFile, writeOutputFile } from "../io.js";
import { emitOutput } from "../output.js";
import { createScene, readFullContent } from "../scene-content.js";
import { sceneTable } from "../tables.js";
import { asListCommand } from "./list.js";
import { registerSceneRenderCommand } from "./render.js";
import {
  ContentFileOptionsSchema,
  ContentGetOptionsSchema,
  JsonObjectSchema,
  SceneCreateOptionsSchema,
  SceneListOptionsSchema,
  SceneUpdateOptionsSchema,
  parseOptions,
} from "../schemas.js";

export function registerScenesCommands(program: Command) {
  const scenes = program
    .command("scenes")
    .summary("List, create, update, delete, and edit workspace scenes")
    .description(
      "Work with Excalidraw scenes, including metadata, collection placement, and drawing content.",
    )
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw scenes list --limit 25
  $ excalidraw scenes list --collection-id <collectionId>
  $ excalidraw scenes get <sceneId>
  $ excalidraw scenes content get <sceneId> --out scene.json

NOTES
  Scene metadata commands do not read or write drawing elements.
  Use "excalidraw scenes content --help" for commands that handle the canvas JSON.
  Every scene belongs to a collection. Personal (uk-) API keys may pass "private" as the collection ID.
`,
    );

  registerSceneRenderCommand(scenes);

  asListCommand(
    scenes
      .command("list")
      .summary("List scene metadata in the current workspace")
      .description(
        "List scene metadata, sharing links, and collection assignments without fetching full canvas content.",
      )
      .option("--collection-id <id>", "only return scenes in this collection"),
    {
      noun: "scenes",
      path: () => "/scenes",
      table: sceneTable,
      schema: SceneListOptionsSchema,
      examples: [
        "excalidraw scenes list --limit 50",
        "excalidraw scenes list --collection-id <collectionId> --limit 25",
        "excalidraw scenes list --all --output table",
      ],
      notes: [
        "Use this first when you need scene IDs for follow-up commands.",
        "Use --limit to keep output bounded for scripts and agents, or --all to walk every page.",
      ],
    },
  );

  scenes
    .command("get")
    .summary("Show metadata for one scene")
    .description("Get one scene's metadata, sharing links, pinned state, and collection assignment.")
    .argument("<sceneId>", "scene ID returned by a list or create command")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw scenes get <sceneId>

NOTES
  This returns metadata only. Use "scenes content get" to fetch drawing elements and files.
`,
    )
    .action(async (sceneId: string, _options, command: Command) => {
      const result = await getClient(command).request("GET", apiPath`/scenes/${sceneId}`);
      emitOutput(command, result);
    });

  scenes
    .command("create")
    .summary("Create a scene, optionally with content from a file")
    .description(
      "Create a scene in a collection. With --file, write its drawing content in the same run; without it, the scene starts empty.",
    )
    .requiredOption("--name <name>", "name for the new scene")
    .requiredOption(
      "--collection-id <id>",
      "collection to place the scene in; personal API keys may use \"private\"",
    )
    .option("--pinned", "pin the scene in the workspace UI", false)
    .option("--file <file>", "scene content JSON to write into the new scene; use - to read stdin")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw scenes create --name "Architecture sketch" --collection-id <collectionId>
  $ excalidraw scenes create --name "Sprint board" --collection-id <collectionId> --pinned
  $ excalidraw scenes create --name "Scratchpad" --collection-id private
  $ excalidraw scenes create --name "Imported" --collection-id <collectionId> --file drawing.excalidraw
  $ generate-diagram | excalidraw scenes create --name "Generated" --collection-id <collectionId> --file -

NOTES
  Without --file the created scene starts empty; add canvas JSON later with "scenes content put" or "scenes content patch".
  With --file, a full Excalidraw export (type: "excalidraw") replaces the empty scene via PUT, and a partial
  payload with elements, appState, or files is merged via PATCH. The file is validated before the scene is created;
  a full export's missing version, source, appState, and files are filled in.
  If writing content fails, the error names the created scene ID so you can retry with "scenes content put".
  The API requires a collection. Workspace API keys must pass a real collection ID;
  personal (uk-) API keys may also pass "private" for the key owner's private collection.
`,
    )
    .action(async (options, command: Command) => {
      const { file, ...body } = parseOptions(SceneCreateOptionsSchema, options);
      emitOutput(command, await createScene(getClient(command), "/scenes", body, file));
    });

  scenes
    .command("update")
    .summary("Update scene metadata")
    .description("Rename, pin, or move a scene without changing its drawing content.")
    .argument("<sceneId>", "scene ID to update")
    .option("--name <name>", "new scene name")
    .option("--collection-id <id>", "move the scene to this collection; personal API keys may use \"private\"")
    .option("--pinned", "pin the scene in the workspace UI")
    .option("--no-pinned", "unpin the scene")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw scenes update <sceneId> --name "Updated diagram"
  $ excalidraw scenes update <sceneId> --collection-id <collectionId>
  $ excalidraw scenes update <sceneId> --no-pinned

NOTES
  Provide at least one field to update. Omitted fields stay unchanged.
  Use --pinned to pin and --no-pinned to unpin.
`,
    )
    .action(async (sceneId: string, options, command: Command) => {
      const body = parseOptions(SceneUpdateOptionsSchema, options);
      const result = await getClient(command).request("PATCH", apiPath`/scenes/${sceneId}`, { body });
      emitOutput(command, result);
    });

  scenes
    .command("delete")
    .summary("Move a scene to trash")
    .description("Soft-delete a scene by moving it to trash. This does not permanently destroy it.")
    .argument("<sceneId>", "scene ID to move to trash")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw scenes delete <sceneId>

NOTES
  Existing links or integrations may stop working while the scene is in trash.
`,
    )
    .action(async (sceneId: string, _options, command: Command) => {
      const result = await getClient(command).request("DELETE", apiPath`/scenes/${sceneId}`);
      emitOutput(command, result);
    });

  const content = scenes
    .command("content")
    .summary("Read, replace, or patch scene canvas JSON")
    .description(
      "Work with the complete Excalidraw scene content: elements, files, app state, and version data.",
    )
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw scenes content get <sceneId> --out scene.json
  $ excalidraw scenes content patch <sceneId> --file patch.json
  $ excalidraw scenes content put <sceneId> --file replacement.json

NOTES
  Prefer patch for incremental agent edits. Use put only for authoritative full replacements.
  Patch merges with the stored scene; put replaces the stored scene.
`,
    );

  content
    .command("get")
    .summary("Fetch complete scene content")
    .description("Return the full scene JSON, including elements, files, app state, and embedded file status.")
    .argument("<sceneId>", "scene ID to read")
    .option("--out <file>", "write response JSON to a file (overwrites); - prints to stdout")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw scenes content get <sceneId>
  $ excalidraw scenes content get <sceneId> --out scene.json

NOTES
  Large scenes can produce large JSON. Use --out when saving content for review, backup, or later patching.
  GET responses may include filesFailedToEmbed; write commands ignore that field if it is reused as input.
`,
    )
    .action(async (sceneId: string, options, command: Command) => {
      const { out } = parseOptions(ContentGetOptionsSchema, options);
      const result = await getClient(command).request("GET", apiPath`/scenes/${sceneId}/content`);

      if (out) {
        await writeOutputFile(out, result);
        return;
      }

      emitOutput(command, result);
    });

  content
    .command("put")
    .summary("Replace all content in a scene")
    .description(
      "Authoritatively replace a scene with the complete Excalidraw content JSON from a file.",
    )
    .argument("<sceneId>", "scene ID to replace")
    .requiredOption("--file <file>", "complete scene content JSON file; use - to read stdin")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw scenes content put <sceneId> --file replacement.json
  $ cat drawing.excalidraw | excalidraw scenes content put <sceneId> --file -

NOTES
  This is a full replacement: elements not present in the file are removed from the scene.
  The file must contain elements. Missing type, version, source, appState, and files are filled in,
  and the file is checked before anything is sent.
  The server recomputes sceneVersion and ignores any sceneVersion value in the file.
  Connected editors are forced to reload. For most automated edits, use patch instead.
`,
    )
    .action(async (sceneId: string, options, command: Command) => {
      const { file } = parseOptions(ContentFileOptionsSchema, options);
      const body = await readFullContent(file);
      const result = await getClient(command).request("PUT", apiPath`/scenes/${sceneId}/content`, {
        body,
      });
      emitOutput(command, result);
    });

  content
    .command("patch")
    .summary("Merge partial content into a scene")
    .description(
      "Patch scene content by merging the supplied elements, files, or appState fields into the current scene.",
    )
    .argument("<sceneId>", "scene ID to patch")
    .requiredOption("--file <file>", "partial scene content JSON file; use - to read stdin")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw scenes content patch <sceneId> --file patch.json
  $ echo '{"appState":{"viewBackgroundColor":"#f8f9fa"}}' | excalidraw scenes content patch <sceneId> --file -

NOTES
  Provide at least one of elements, appState, or files.
  Elements merge by ID using version-based reconciliation: higher version wins, with versionNonce tie-breaking.
  Omitted elements and files are preserved. Send elements with isDeleted: true to soft-delete them.
  From appState, only viewBackgroundColor and lockedMultiSelections are stored. Files are added or replaced by file ID.
  Agents should prefer patch when adding or changing specific content without owning the whole scene.
`,
    )
    .action(async (sceneId: string, options, command: Command) => {
      const { file } = parseOptions(ContentFileOptionsSchema, options);
      const body = JsonObjectSchema.parse(await readJsonFile(file));
      const result = await getClient(command).request("PATCH", apiPath`/scenes/${sceneId}/content`, {
        body,
      });
      emitOutput(command, result);
    });
}
