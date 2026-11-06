import { mkdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import chalk from "chalk";
import { Command, Option } from "commander";
import { apiPath, getClient } from "../client.js";
import { getOutputOptions } from "../config.js";
import { readJsonFile, readTextFile, STDIO_PATH, writeOutputFile } from "../io.js";
import { emitOutput } from "../output.js";
import { MermaidOptionsSchema, RenderOptionsSchema, parseOptions } from "../schemas.js";

import type { RenderedImage, RenderFormat } from "../render.js";
import type { RenderOptions } from "../schemas.js";

const MIME_TYPES = {
  png: "image/png",
  svg: "image/svg+xml",
  excalidraw: "application/vnd.excalidraw+json",
} as const;

// The most important notes. The rest are in docs/rendering.md and docs/mermaid.md.
const FORMAT_NOTE = `  The format follows the --out extension, .png or .svg, unless --format is set. SVGs embed their fonts and have no size limit.`;

const FRAMES_NOTE = `  --all-frames writes each frame to the --out directory as its own file, numbered in presentation order, such as 01-intro.png.`;

const STDOUT_NOTE = `  With --out -, stdout gets only the image, without the JSON summary. Errors and retry notices go to stderr.`;

const RENDERING_DOCS = `  Fonts, proxies, browsers and size limits: https://plus.excalidraw.com/docs/cli/rendering`;

function withBrowserOptions(command: Command) {
  return command
    .addOption(
      new Option(
        "--browser-path <path>",
        "path to Chrome, Chromium, Edge, or Firefox; a binary named firefox is driven as Firefox",
      ).env(
        "EXCALIDRAW_BROWSER_PATH",
      ),
    )
    .addOption(
      new Option("--fonts-url <urls>", "comma-separated mirror URLs or local folders for CJK fonts, or none").env(
        "EXCALIDRAW_FONTS_URL",
      ),
    )
    .option("--timeout <ms>", "browser startup and render deadline; default 30000 ms");
}

function withImageOptions(command: Command) {
  return command
    .option("--padding <pixels>", "padding in scene pixels; ignored for frames; default 20")
    .option("--scale <number>", "resolution multiplier, up to 16; default 1")
    .option("--max-width <pixels>", "maximum PNG width, up to 16384; default 16384")
    .option("--max-height <pixels>", "maximum PNG height, up to 16384; default 16384")
    .option("--theme <theme>", "light or dark; defaults to the scene's export preference")
    .option("--transparent", "export with a transparent background");
}

function withRenderOptions(command: Command) {
  return withBrowserOptions(
    withImageOptions(
      command
        .requiredOption(
          "--out <file>",
          "write the image to a file (overwrites), - for stdout, or a directory with --all-frames",
        )
        .option("--format <format>", "png or svg; defaults to the --out extension, else png")
        .option("--frame-id <id>", "render just this frame, clipped to its bounds")
        .option("--all-frames", "render each frame to its own file in the --out directory"),
    ),
  );
}

/** The format --format names, else the one the --out extension names, else `fallback`. */
function outputFormat<F extends string>(out: string, format: F | undefined, known: readonly F[], fallback: F) {
  const extension = extname(out).slice(1).toLowerCase();
  const implied = known.find((candidate) => candidate === extension);
  if (format && implied && format !== implied) {
    throw new Error(`--format ${format} doesn't match --out ${out}.`);
  }
  return format ?? implied ?? fallback;
}

function checkStdout(out: string, format: string) {
  if (out === STDIO_PATH && format === "png" && process.stdout.isTTY) {
    throw new Error("--out - writes binary PNG to standard output; pipe it into another command or redirect it to a file.");
  }
}

function parseRenderOptions(options: unknown) {
  const parsed = parseOptions(RenderOptionsSchema, options);
  // A directory such as "slides.svg/" names no format; only --format does.
  const format = parsed.allFrames
    ? (parsed.format ?? "png")
    : outputFormat<RenderFormat>(parsed.out, parsed.format, ["png", "svg"], "png");
  checkStdout(parsed.out, format);
  return { ...parsed, format };
}

function warn(warning: string | undefined) {
  if (warning) {
    process.stderr.write(`${chalk.yellow(warning)}\n`);
  }
}

/** A file name for the frame: its position, then its name, or its ID for frames without one. */
function frameFileName(image: RenderedImage, index: number, count: number, format: RenderFormat) {
  const number = String(index + 1).padStart(Math.max(2, String(count).length), "0");
  const name = typeof image.frame?.name === "string" ? image.frame.name : "";
  const slug = (name || image.frame?.id || "frame")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `${number}${slug ? `-${slug}` : ""}.${format}`;
}

/** Writes the image or images, then prints a JSON summary unless the image itself went to stdout. */
async function renderToOutput(
  command: Command,
  scene: unknown,
  options: RenderOptions & { format: RenderFormat },
  summary: Record<string, unknown> = {},
) {
  const { renderScene } = await import("../render.js");
  const mimeType = MIME_TYPES[options.format];

  if (options.allFrames) {
    const directory = resolve(options.out);
    // Each frame is written as soon as it's drawn, so a large deck never sits in memory. The
    // directory is made then too, after the scene and its frames passed validation.
    const frames: Record<string, unknown>[] = [];
    const warnings = new Set<string>();
    const { warning } = await renderScene(scene, options, async (image, index, count) => {
      if (image.warning) {
        warnings.add(image.warning);
      }
      if (index === 0) {
        await mkdir(directory, { recursive: true });
      }
      const path = join(directory, frameFileName(image, index, count, options.format));
      await writeOutputFile(path, image.data);
      frames.push({
        frameId: image.frame?.id ?? null,
        name: typeof image.frame?.name === "string" ? image.frame.name : null,
        path,
        width: image.width,
        height: image.height,
      });
    });
    warnings.forEach(warn);
    warn(warning);
    emitOutput(command, { ...summary, mimeType, frames });
    return;
  }

  let rendered: RenderedImage | undefined;
  const { warning } = await renderScene(scene, options, async (image) => {
    rendered = image;
  });
  const image = rendered!;
  warn(image.warning);
  warn(warning);
  await writeOutputFile(options.out, image.data);
  if (options.out !== STDIO_PATH) {
    emitOutput(command, {
      ...summary,
      path: resolve(options.out),
      mimeType,
      width: image.width,
      height: image.height,
      frameId: options.frameId ?? null,
    });
  }
}

export function registerRenderCommand(program: Command) {
  withRenderOptions(program.command("render"))
    .summary("Render a local Excalidraw file as PNG or SVG")
    .description(
      "Render a scene locally with an installed browser. No account or API key is required.",
    )
    .argument("<file>", "Excalidraw scene JSON file, or - to read stdin")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw render drawing.excalidraw --out drawing.png
  $ excalidraw render drawing.excalidraw --out drawing.svg
  $ excalidraw render drawing.excalidraw --frame-id frame_123 --out frame.png
  $ excalidraw render deck.excalidraw --all-frames --out slides/
  $ cat drawing.excalidraw | excalidraw render - --out drawing.png
  $ node generate-scene.js | excalidraw render - --out - > drawing.png

NOTES
  Uses an installed Chrome, Chromium, Edge or Firefox. Nothing is uploaded.
${FORMAT_NOTE}
${FRAMES_NOTE}
${STDOUT_NOTE}
${RENDERING_DOCS}
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
    .summary("Render a workspace scene as a local PNG or SVG")
    .description(
      "Fetch scene content through the public API, then render it locally with an installed browser.",
    )
    .argument("<sceneId>", "scene ID to render")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw scenes render <sceneId> --out scene.png
  $ excalidraw scenes render <sceneId> --out scene.svg --theme dark
  $ excalidraw scenes render <sceneId> --frame-id <frameId> --out frame.png
  $ excalidraw scenes render <sceneId> --all-frames --out slides/
  $ excalidraw scenes render <sceneId> --out - > scene.png

NOTES
  Needs an API key that can read the scene, and an installed Chrome, Chromium, Edge or Firefox. The key never reaches the browser.
${FORMAT_NOTE}
${FRAMES_NOTE}
${STDOUT_NOTE}
${RENDERING_DOCS}
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

export function registerMermaidCommand(program: Command) {
  withBrowserOptions(
    withImageOptions(
      program
        .command("mermaid")
        .summary("Convert a Mermaid diagram into an Excalidraw scene, PNG or SVG")
        .description(
          "Convert a Mermaid definition into editable Excalidraw elements, as the editor's Mermaid import does, and save it as a scene file or render it. Runs locally with an installed browser; no account or API key is required.",
        )
        .argument("<file>", "Mermaid definition file, or - to read stdin")
        .requiredOption("--out <file>", "write the result to a file (overwrites), or - for stdout")
        .option("--format <format>", "excalidraw, png, or svg; defaults to the --out extension, else excalidraw")
        .option("--elbow", "draw flowchart edges and state transitions as elbow arrows")
        .option("--font-size <pixels>", "font size of the diagram's text; default 20"),
    ),
  )
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw mermaid flow.mmd --out flow.excalidraw
  $ excalidraw mermaid flow.mmd --out flow.png --scale 2
  $ excalidraw mermaid flow.mmd --out flow.svg --elbow
  $ echo "graph LR; A-->B" | excalidraw mermaid - --out - > flow.excalidraw
  $ excalidraw mermaid flow.mmd --out flow.excalidraw && excalidraw scenes create --name "Flow" --collection-id <collectionId> --file flow.excalidraw

NOTES
  Flowcharts (including swimlane-beta), sequence, class, ER and state diagrams, Gantt charts, quadrant charts and timelines become editable shapes. Other types, such as pie charts, become one image.
  The format follows the --out extension (.excalidraw, .json, .png, .svg) unless --format is set. Other extensions get an Excalidraw scene.
  Uses an installed Chrome, Chromium, Edge or Firefox, also for scenes: it measures the text so shapes fit their labels.
  More: https://plus.excalidraw.com/docs/cli/mermaid
`,
    )
    .action(async (file: string, options, command: Command) => {
      const parsed = parseOptions(MermaidOptionsSchema, options);
      getOutputOptions(command.optsWithGlobals());
      const extension = extname(parsed.out).slice(1).toLowerCase();
      const format = outputFormat(
        parsed.out,
        parsed.format ?? (extension === "json" ? "excalidraw" : undefined),
        ["excalidraw", "png", "svg"] as const,
        "excalidraw",
      );
      checkStdout(parsed.out, format);
      const definition = await readTextFile(file);
      if (definition.trim() === "") {
        throw new Error("The Mermaid definition is empty.");
      }

      const { convertMermaid } = await import("../render.js");
      const { result, warning } = await convertMermaid(
        definition,
        parsed,
        format === "excalidraw" ? undefined : { format, options: parsed },
      );
      warn(result.image?.warning);
      warn(warning);

      const summary = { path: resolve(parsed.out), mimeType: MIME_TYPES[format] };
      if (result.image) {
        await writeOutputFile(parsed.out, result.image.data);
        if (parsed.out !== STDIO_PATH) {
          emitOutput(command, { ...summary, width: result.image.width, height: result.image.height });
        }
        return;
      }
      await writeOutputFile(parsed.out, result.scene);
      if (parsed.out !== STDIO_PATH) {
        emitOutput(command, { ...summary, elements: result.scene.elements.length });
      }
    });
}
