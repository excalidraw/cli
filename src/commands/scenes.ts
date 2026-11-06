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
  SceneShareOptionsSchema,
  SceneShareSlidesOptionsSchema,
  SceneUpdateOptionsSchema,
  parseOptions,
} from "../schemas.js";

export function registerScenesCommands(program: Command) {
  const scenes = program
    .command("scenes")
    .summary("List, create, update, share, delete, and edit workspace scenes")
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
  --file takes a full Excalidraw export or a partial payload with elements, appState or files, and is checked before the scene is created. Without it the scene starts empty.
  Workspace API keys need a real collection ID; personal (uk-) keys may pass "private" for the owner's private collection.
  More: https://plus.excalidraw.com/docs/cli/scene-content
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

  scenes
    .command("share")
    .summary("Turn a scene's public link on or off")
    .description(
      "Set what anyone with the scene's public link may do, and print the link. This is the link from the scene's Share dialog.",
    )
    .argument("<sceneId>", "scene ID to share")
    .requiredOption("--access <access>", "view, edit, or none to turn the link off")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw scenes share <sceneId> --access view
  $ excalidraw scenes share <sceneId> --access edit
  $ excalidraw scenes share <sceneId> --access none
  $ excalidraw scenes share <sceneId> --access view | jq -r .url

NOTES
  Anyone with the link can open the scene without signing in. With view or edit, they can also read and write comments.
  The output is the link's access and its URL; url is null once the link is off.
  Turning the link on fails with HTTP 403 when a workspace admin has disabled scene sharing.
`,
    )
    .action(async (sceneId: string, options, command: Command) => {
      const body = parseOptions(SceneShareOptionsSchema, options);
      const result = await getClient(command).request("PUT", apiPath`/scenes/${sceneId}/link-sharing`, {
        body,
      });
      emitOutput(command, result);
    });

  scenes
    .command("share-slides")
    .summary("Share a scene's frames as a presentation")
    .description(
      "Turn the scene's shared presentation link on, or off with --off, and print the link. Anyone with the link can step through the scene's frames as slides without signing in.",
    )
    .argument("<sceneId>", "scene ID whose frames to share")
    .option("--off", "turn the shared slides link off", false)
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw scenes share-slides <sceneId>
  $ excalidraw scenes share-slides <sceneId> --off

NOTES
  Each frame in the scene is one slide. Sharing fails with HTTP 400 when the scene has no frames.
  The link stays the same when sharing is turned off and on again; url is null while it's off.
  Turning sharing on fails with HTTP 403 when a workspace admin has disabled scene sharing.
`,
    )
    .action(async (sceneId: string, options, command: Command) => {
      const { off } = parseOptions(SceneShareSlidesOptionsSchema, options);
      const result = await getClient(command).request("PUT", apiPath`/scenes/${sceneId}/shared-slides`, {
        body: { enabled: !off },
      });
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
  The file only needs elements; missing fields are filled in, and the file is checked before anything is sent.
  Connected editors are forced to reload. For most automated edits, use patch instead.
  More: https://plus.excalidraw.com/docs/cli/scene-content
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
  Send at least one of elements, appState or files. Elements and files you leave out are kept.
  Elements merge by ID, and the higher version wins: to change an element, send it with its version increased. Send it with isDeleted: true to remove it.
  Files are added or replaced by ID. From appState, only viewBackgroundColor and lockedMultiSelections are stored.
  More: https://plus.excalidraw.com/docs/cli/scene-content
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
