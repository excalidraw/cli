import { resolve } from "node:path";
import chalk from "chalk";
import { Command, Option } from "commander";
import { apiPath, getClient } from "../client.js";
import { getOutputOptions } from "../config.js";
import { readJsonFile, STDIO_PATH, writeOutputFile } from "../io.js";
import { emitOutput } from "../output.js";
import { RenderOptionsSchema, parseOptions } from "../schemas.js";

import type { RenderOptions } from "../schemas.js";

const STDOUT_NOTES = `  With --out -, stdout contains only PNG bytes, with no JSON summary, even with --raw or --output table.
  Errors and retry notices go to stderr. Pipe stdout to an image consumer or redirect it to a file.`;

const FONT_NOTES = `  Excalidraw's fonts ship with the CLI, except the hand-drawn CJK font. The files a scene's text
  needs are downloaded on first use, checked, and cached; without network access that text
  uses a system font. Set --fonts-url to use your own mirror.`;

function withRenderOptions(command: Command) {
  return command
    .requiredOption("--out <file>", "write PNG to a file (overwrites) or - for binary stdout")
    .option("--frame-id <id>", "render just this frame, clipped to its bounds")
    .option("--padding <pixels>", "padding in scene pixels; ignored for frames; default 20")
    .option("--scale <number>", "resolution multiplier, up to 16; default 1")
    .option("--max-width <pixels>", "maximum PNG width, up to 16384; default 2048")
    .option("--max-height <pixels>", "maximum PNG height, up to 16384; default 2048")
    .option("--theme <theme>", "light or dark; defaults to the scene's export preference")
    .option("--transparent", "export with a transparent background")
    .addOption(
      new Option(
        "--browser-path <path>",
        "path to Chrome, Chromium, Edge, or Firefox; a binary named firefox is driven as Firefox",
      ).env(
        "EXCALIDRAW_BROWSER_PATH",
      ),
    )
    .addOption(
      new Option("--fonts-url <urls>", "comma-separated mirrors for CJK fonts, or none").env(
        "EXCALIDRAW_FONTS_URL",
      ),
    )
    .option("--timeout <ms>", "browser startup and render deadline; default 30000 ms");
}

function parseRenderOptions(options: unknown) {
  const parsed = parseOptions(RenderOptionsSchema, options);
  if (parsed.out === STDIO_PATH && process.stdout.isTTY) {
    throw new Error("--out - writes binary PNG to standard output; pipe it into another command or redirect it to a file.");
  }
  return parsed;
}

/** Writes the PNG, then prints a JSON summary unless the PNG itself went to stdout. */
async function renderToOutput(
  command: Command,
  scene: unknown,
  options: RenderOptions,
  summary: Record<string, unknown> = {},
) {
  const { renderPng } = await import("../render.js");
  const { png, width, height, warning } = await renderPng(scene, options);
  if (warning) {
    process.stderr.write(`${chalk.yellow(warning)}\n`);
  }
  await writeOutputFile(options.out, png);
  if (options.out !== STDIO_PATH) {
    emitOutput(command, {
      ...summary,
      path: resolve(options.out),
      mimeType: "image/png",
      width,
      height,
      frameId: options.frameId ?? null,
    });
  }
}

export function registerRenderCommand(program: Command) {
  withRenderOptions(program.command("render"))
    .summary("Render a local Excalidraw file as PNG")
    .description(
      "Render a scene locally with an installed browser. No account or API key is required.",
    )
    .argument("<file>", "Excalidraw scene JSON file, or - to read stdin")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw render drawing.excalidraw --out drawing.png
  $ excalidraw render drawing.excalidraw --frame-id frame_123 --out frame.png
  $ cat drawing.excalidraw | excalidraw render - --out drawing.png
  $ node generate-scene.js | excalidraw render - --out - > drawing.png

NOTES
  Requires an installed Chrome, Chromium, Edge, or Firefox. Rendering runs locally with embedded images.
  Firefox is used only when none of the others is found; a render then takes about 5 s instead of under 1 s.
${FONT_NOTES}
  The browser uses a temporary profile. External image URLs and live embeds are not loaded.
  Output keeps the scene's aspect ratio and is capped at 64 million pixels.
${STDOUT_NOTES}
`,
    )
    .action(async (file: string, options, command: Command) => {
      const parsed = parseRenderOptions(options);
      getOutputOptions(command.optsWithGlobals());
      await renderToOutput(command, await readJsonFile(file), parsed);
    });
}

export function registerSceneRenderCommand(scenes: Command) {
  withRenderOptions(scenes.command("render"))
    .summary("Render a workspace scene as a local PNG")
    .description(
      "Fetch scene content through the public API, then render it locally with an installed browser.",
    )
    .argument("<sceneId>", "scene ID to render")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw scenes render <sceneId> --out scene.png
  $ excalidraw scenes render <sceneId> --frame-id <frameId> --out frame.png
  $ excalidraw scenes render <sceneId> --out - > scene.png

NOTES
  Requires an API key with permission to read the scene content, and Chrome, Chromium, Edge, or Firefox.
  Rendering uses a temporary browser profile. The API key is never passed to the browser.
${FONT_NOTES}
  Use "excalidraw render <file> --out <file>" to render a local file without an API key.
${STDOUT_NOTES}
`,
    )
    .action(async (sceneId: string, options, command: Command) => {
      const parsed = parseRenderOptions(options);
      const scene = await getClient(command).request(
        "GET",
        apiPath`/scenes/${sceneId}/content`,
        { raw: false },
      );
      await renderToOutput(command, scene, parsed, { sceneId });
    });
}
