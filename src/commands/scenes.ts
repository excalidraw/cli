import { Command } from "commander";
import { apiPath, getClient } from "../client.js";
import { readJsonFile, writeOutputFile } from "../io.js";
import { emitOutput } from "../output.js";
import { createScene, readFullContent } from "../scene-content.js";
import { readOnlyLinkTable, sceneTable } from "../tables.js";
import { asListCommand } from "./list.js";
import { registerSceneRenderCommand } from "./render.js";
import {
  ContentFileOptionsSchema,
  ContentGetOptionsSchema,
  JsonObjectSchema,
  ReadOnlyLinkCreateOptionsSchema,
  ReadOnlyLinkUpdateOptionsSchema,
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
      "Turn the scene's shared presentation link on, or off with --off, change its settings, and print the link. Anyone with the link can step through the scene's frames as slides without signing in.",
    )
    .argument("<sceneId>", "scene ID whose frames to share")
    .option("--off", "turn the shared slides link off", false)
    .option("--slide-titles", "show each slide's title, which is its frame's name")
    .option("--no-slide-titles", "hide the slide titles")
    .option("--transitions", "scroll to the next slide with an animation")
    .option("--no-transitions", "switch slides without an animation")
    .option("--animations", "play the reveal animations set up in the presentation editor")
    .option("--no-animations", "show each slide complete, without its reveal animations")
    .option("--downloads", "let viewers download the slides")
    .option("--no-downloads", "stop viewers from downloading the slides")
    .option("--auto-play <seconds>", "move to the next slide after this many seconds, from 1 to 100; 0 turns it off")
    .option("--no-auto-play", "turn auto-play off")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw scenes share-slides <sceneId>
  $ excalidraw scenes share-slides <sceneId> --off
  $ excalidraw scenes share-slides <sceneId> --auto-play 10 --no-downloads
  $ excalidraw scenes share-slides <sceneId> --slide-titles --animations | jq -r .url

NOTES
  Each frame in the scene is one slide. Sharing fails with HTTP 400 when the scene has no frames.
  The link stays the same when sharing is turned off and on again; url is null while it's off.
  A settings flag changes only its own setting, and the output's settings lists all of them. The settings are the ones in the scene's Share presentation dialog.
  The command turns the link on unless you pass --off. With --off, settings are saved only for a scene whose slides were shared before; otherwise settings is null.
  Turning sharing on fails with HTTP 403 when a workspace admin has disabled scene sharing.
`,
    )
    .action(async (sceneId: string, options, command: Command) => {
      const body = parseOptions(SceneShareSlidesOptionsSchema, options);
      const result = await getClient(command).request("PUT", apiPath`/scenes/${sceneId}/shared-slides`, {
        body,
      });
      emitOutput(command, result);
    });

  registerSceneReadOnlyLinksCommands(scenes);

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

/**
 * Adds the flags a read-only link is set up with. Every display option starts off, so `create` gets
 * only the flag that turns each one on, and `update` also the one that turns it back off.
 */
function addReadOnlyLinkOptions(command: Command, { forUpdate }: { forUpdate: boolean }) {
  command
    .option("--name <name>", "the link's name in the scene's Embeddable links list")
    .option("--frame-id <id>", "start on this frame, which then fills the view")
    .option("--element-ids <ids>", "start on these elements, comma-separated, with some space around them")
    .option("--area <x,y,width,height>", "start on this part of the scene, in scene coordinates")
    .option("--theme <theme>", "show the scene in light or dark mode");

  const toggle = (flag: string, on: string, off: string, { startsOn = false } = {}) => {
    if (forUpdate || !startsOn) {
      command.option(`--${flag}`, on);
    }
    if (forUpdate || startsOn) {
      command.option(`--no-${flag}`, off);
    }
  };

  toggle("scene-title", "show the scene's name at the top", "hide the scene's name");
  toggle("menu", "show the menu, which saves the scene to a file or as an image", "hide the menu");
  toggle("theme-toggle", "show a button that switches between light and dark mode", "hide the theme button");
  toggle("frame-outlines", "show the outlines and names of frames", "hide the outlines and names of frames");
  toggle(
    "interaction",
    "let viewers pan and zoom",
    "stop viewers from panning and zooming: they only see the starting area",
    { startsOn: true },
  );

  return command;
}

function registerSceneReadOnlyLinksCommands(scenes: Command) {
  const links = scenes
    .command("readonly-links")
    .summary("Manage a scene's read-only links, which also embed it in other sites")
    .description(
      "List, create, change, and delete a scene's read-only links. Anyone with such a link sees the scene without signing in, and its embedHtml iframe embeds the scene in another site.",
    )
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw scenes readonly-links list <sceneId>
  $ excalidraw scenes readonly-links create <sceneId> --frame-id <frameId>
  $ excalidraw scenes readonly-links update <sceneId> <linkId> --theme dark
  $ excalidraw scenes readonly-links delete <sceneId> <linkId>

NOTES
  A scene can have several read-only links, each with its own starting area and display options. They are the links in the scene's Embeddable links dialog.
  This is not the scene's public link, of which a scene has one: see "excalidraw scenes share".
  Viewers can't change the scene; they see it as it is saved now.
`,
    );

  links
    .command("list")
    .summary("List a scene's read-only links")
    .description("List the scene's read-only links, newest first, each with its URL and embed code.")
    .argument("<sceneId>", "scene ID whose links to list")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw scenes readonly-links list <sceneId>
  $ excalidraw scenes readonly-links list <sceneId> --output table
  $ excalidraw scenes readonly-links list <sceneId> | jq -r '.links[].url'

NOTES
  Use this to find link IDs before updating or deleting links.
  The output is { links }, all of them at once: this list has no pages.
`,
    )
    .action(async (sceneId: string, _options, command: Command) => {
      const result = await getClient(command).request("GET", apiPath`/scenes/${sceneId}/readonly-links`);
      emitOutput(command, result, readOnlyLinkTable);
    });

  addReadOnlyLinkOptions(
    links
      .command("create")
      .summary("Create a read-only link to a scene")
      .description(
        "Create a read-only link and print it with its URL and embed code. It starts on a frame, some elements or an area, or by default on all of the scene's content.",
      )
      .argument("<sceneId>", "scene ID to link to"),
    { forUpdate: false },
  )
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw scenes readonly-links create <sceneId>
  $ excalidraw scenes readonly-links create <sceneId> --name "Docs embed" --frame-id <frameId>
  $ excalidraw scenes readonly-links create <sceneId> --element-ids <elementId>,<elementId> --theme dark
  $ excalidraw scenes readonly-links create <sceneId> --area 0,0,800,600 --no-interaction
  $ excalidraw scenes readonly-links create <sceneId> --scene-title --theme-toggle | jq -r .embedHtml

NOTES
  Use only one of --frame-id, --element-ids, or --area. Find frame and element IDs with "excalidraw scenes content get".
  Unless flags say otherwise, the link shows the scene in light mode, lets viewers pan and zoom, and shows no title, menu, theme button or frame outlines.
  The output's url opens the read-only page, and embedHtml is an iframe for another site.
  The link's preview image, which link previews on social media show, is a render of where it starts.
  Creating a link fails with HTTP 403 when a workspace admin has disabled scene sharing.
`,
    )
    .action(async (sceneId: string, options, command: Command) => {
      const body = parseOptions(ReadOnlyLinkCreateOptionsSchema, options);
      const result = await getClient(command).request("POST", apiPath`/scenes/${sceneId}/readonly-links`, {
        body,
      });
      emitOutput(command, result);
    });

  addReadOnlyLinkOptions(
    links
      .command("update")
      .summary("Change a read-only link, or turn it off and on")
      .description(
        "Change a read-only link's name, where it starts, or its display options, or turn it off and on with --status.",
      )
      .argument("<sceneId>", "scene ID the link belongs to")
      .argument("<linkId>", "read-only link ID to change"),
    { forUpdate: true },
  )
    .option("--status <status>", "inactive turns the link off, active turns it on again")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw scenes readonly-links update <sceneId> <linkId> --name "Docs embed"
  $ excalidraw scenes readonly-links update <sceneId> <linkId> --frame-id <frameId>
  $ excalidraw scenes readonly-links update <sceneId> <linkId> --theme dark --no-menu
  $ excalidraw scenes readonly-links update <sceneId> <linkId> --status inactive

NOTES
  Provide at least one option. Options you leave out stay unchanged.
  Use only one of --frame-id, --element-ids, or --area. A new start also renders a new preview image.
  An inactive link shows nothing until it is active again, and keeps its URL.
`,
    )
    .action(async (sceneId: string, linkId: string, options, command: Command) => {
      const body = parseOptions(ReadOnlyLinkUpdateOptionsSchema, options);
      const result = await getClient(command).request(
        "PATCH",
        apiPath`/scenes/${sceneId}/readonly-links/${linkId}`,
        { body },
      );
      emitOutput(command, result);
    });

  links
    .command("delete")
    .summary("Delete a read-only link for good")
    .description("Delete a read-only link. Its URL and every embed of it stop working for good.")
    .argument("<sceneId>", "scene ID the link belongs to")
    .argument("<linkId>", "read-only link ID to delete")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw scenes readonly-links delete <sceneId> <linkId>

NOTES
  This can't be undone. To turn a link off for a while, use "excalidraw scenes readonly-links update" with --status inactive.
`,
    )
    .action(async (sceneId: string, linkId: string, _options, command: Command) => {
      const result = await getClient(command).request(
        "DELETE",
        apiPath`/scenes/${sceneId}/readonly-links/${linkId}`,
      );
      emitOutput(command, result);
    });
}
