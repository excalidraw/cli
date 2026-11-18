import chalk from "chalk";
import { Command } from "commander";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getClient } from "../client.js";
import { getOutputOptions } from "../config.js";
import { STDIO_PATH, printOutput, readJsonFile, stripControlCharacters, writeOutputFile } from "../io.js";
import { McpClient, McpError, isAppOnlyTool, toolAccess } from "../mcp.js";
import { emitOutput } from "../output.js";
import { JsonObjectSchema, McpCallOptionsSchema, parseOptions } from "../schemas.js";
import { mcpToolTable } from "../tables.js";

import type { McpContentBlock, McpTool } from "../mcp.js";

/** File extensions for the images tools return. Screenshots are PNG. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};

export function registerMcpCommands(program: Command) {
  const mcp = program
    .command("mcp")
    .summary("Draw with the Excalidraw+ MCP tools: diagrams, slides, charts, screenshots")
    .description(
      "Use the tools of the Excalidraw+ MCP server through the CLI's login, without adding the server to an agent or editor. They draw into workspace scenes: diagrams, charts, tables, slides and sticky notes, with layout checks and screenshots.",
    )
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw mcp instructions
  $ excalidraw mcp tools --output table
  $ excalidraw mcp schema create_mermaid_diagram
  $ excalidraw mcp call create_mermaid_diagram --args '{"newScene":{"name":"Login flow","collectionId":"private"},"definition":"flowchart LR\\n  A[Visit] --> B[Sign in]"}'
  $ excalidraw mcp call take_screenshot --args '{"sceneId":"<sceneId>"}' --out scene.png

NOTES
  Agents: read "excalidraw mcp instructions" once, pick a tool from "excalidraw mcp tools", read its arguments with "excalidraw mcp schema <tool>", then run it with "excalidraw mcp call".
  The tools are the ones an MCP client gets from https://api.excalidraw.com/api/v1/mcp, limited to what the login may do.
  Scenes, collections, users, invites and logs also have their own commands, such as "excalidraw scenes list".
`,
    );

  mcp
    .command("instructions")
    .summary("Print the server's guide to drawing with the tools")
    .description(
      "Print the instructions the MCP server gives agents: which tool to pick for which content, and how to check the result.",
    )
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw mcp instructions

NOTES
  An MCP client shows these to its agent when it connects. Through the CLI, an agent reads them here, once per conversation.
  The text is printed as is. --raw prints the server's whole answer as JSON, with its name and version.
`,
    )
    .action(async (_options, command: Command) => {
      const result = await new McpClient(getClient(command)).initialize();
      if (isRaw(command)) {
        printOutput(result);
        return;
      }
      printOutput(stripControlCharacters(result.instructions ?? "The server gives no instructions."));
    });

  mcp
    .command("tools")
    .summary("List the tools the login may use")
    .description(
      "List each tool with the first sentence of its description and whether it only reads. Tools the login has no permission for are left out.",
    )
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw mcp tools
  $ excalidraw mcp tools --output table

NOTES
  The list is short on purpose. "excalidraw mcp schema <tool>" prints a tool's whole description and its arguments.
  readOnly tools change nothing. destructive tools may change or remove existing content; the others only add.
  --raw prints the tool definitions as the server sent them.
`,
    )
    .action(async (_options, command: Command) => {
      const tools = await new McpClient(getClient(command)).listTools();
      if (isRaw(command)) {
        printOutput({ tools });
        return;
      }
      const listed = tools.filter((tool) => !isAppOnlyTool(tool));
      emitOutput(
        command,
        {
          count: listed.length,
          tools: listed.map((tool) => ({ name: tool.name, summary: summarize(tool.description), ...toolAccess(tool) })),
        },
        mcpToolTable,
      );
    });

  mcp
    .command("schema")
    .summary("Show a tool's description and the arguments it takes")
    .description("Print one or more tools in full: the description, and the JSON Schema of the arguments.")
    .argument("<tool...>", "tool names from \"excalidraw mcp tools\"")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw mcp schema create_diagram
  $ excalidraw mcp schema create_chart create_table

NOTES
  inputSchema is the JSON Schema that --args of "excalidraw mcp call" must match.
  --raw adds what the server sends besides, such as the schema of the tool's result.
`,
    )
    .action(async (names: string[], _options, command: Command) => {
      const tools = await new McpClient(getClient(command)).listTools();
      const found = names.map((name) => {
        const tool = tools.find((candidate) => candidate.name === name);
        if (!tool) {
          throw new Error(`No tool named "${name}". Run "excalidraw mcp tools" for the list.`);
        }
        return tool;
      });
      const described = isRaw(command) ? found : found.map(describeTool);
      printOutput(described.length === 1 ? described[0] : described);
    });

  mcp
    .command("call")
    .summary("Run a tool and print its result")
    .description(
      "Run one tool with JSON arguments. Prints the tool's result as JSON, or as text for tools that return text, and saves the images it returns.",
    )
    .argument("<tool>", "tool name from \"excalidraw mcp tools\"")
    .option("--args <json>", "the tool's arguments as a JSON object; default {}")
    .option("--args-file <file>", "read the arguments from a JSON file; use - to read stdin")
    .option("--out <file>", "where to save the image a tool returns; use - to write it to stdout")
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw mcp call list_scenes
  $ excalidraw mcp call search_scene_content --args '{"sceneId":"<sceneId>","query":"login"}'
  $ excalidraw mcp call create_diagram --args-file diagram.json
  $ generate-args | excalidraw mcp call edit_scene_content --args-file -
  $ excalidraw mcp call take_screenshot --args '{"sceneId":"<sceneId>"}' --out scene.png

NOTES
  Arguments must match the tool's inputSchema, see "excalidraw mcp schema <tool>". Prefer --args-file for large or quoted content: the shell can mangle --args.
  A tool that fails prints its message to stderr and exits with status 1, like any other error.
  Images, such as a screenshot or a write's "screenshot": true, are saved to --out, or to a temporary file only you can read when --out is missing. The path is printed to stderr, so stdout stays the tool's result.
  A tool's warnings, such as a write that succeeded but whose screenshot failed, go to stderr too.
  With --out -, only the image is written to stdout, and the tool's result goes to stderr.
  --raw prints the whole MCP result as JSON, images included as base64, and saves no file.
  A write that fails halfway is not retried. Slow tools may need a longer --request-timeout.
`,
    )
    .action(async (name: string, options, command: Command) => {
      const { args, argsFile, out } = parseOptions(McpCallOptionsSchema, options);
      // Before the call: a write must not run and then fail to print.
      if (out === STDIO_PATH && process.stdout.isTTY) {
        throw new Error("--out - writes image bytes to stdout; pipe or redirect it, or pass a file path.");
      }
      const toolArguments = await readArguments(args, argsFile);
      const result = await new McpClient(getClient(command)).callTool(name, toolArguments).catch((error: unknown) => {
        // JSON-RPC "invalid params", which is how the server answers a tool it doesn't have.
        if (error instanceof McpError && error.code === -32602 && /not found/i.test(error.message)) {
          throw new Error(`${error.message}. Run "excalidraw mcp tools" for the list.`);
        }
        throw error;
      });

      if (isRaw(command)) {
        printOutput(result);
        if (result.isError) {
          process.exitCode = 1;
        }
        return;
      }

      const texts = result.content.flatMap((block) =>
        block.type === "text" && block.text !== undefined ? [block.text] : [],
      );

      if (result.isError) {
        throw new Error(errorMessage(texts.join("\n")) || `The tool "${name}" failed without a message.`);
      }

      // Tools answer with the same JSON as structured content and as text, so that prints once. Text
      // that says something else is a warning, such as a write whose screenshot failed.
      const structured = result.structuredContent;
      const output = structured !== undefined ? structured : texts.length > 0 ? stripControlCharacters(texts.join("\n")) : undefined;
      const warnings = structured === undefined ? [] : texts.filter((text) => !isSameJson(text, structured));

      const images = result.content.filter((block) => block.type === "image" && block.data !== undefined);
      const skipped = result.content.filter((block) => block.type !== "text" && !images.includes(block));
      if (skipped.length > 0) {
        note(`Left out ${skipped.length} result item(s) of type ${[...new Set(skipped.map((block) => block.type))].join(", ")}. Use --raw to print them.`);
      }

      if (out === STDIO_PATH) {
        // stdout is the image's, so the result goes to stderr: what a write returned, such as the ID
        // of the scene it created, must not be lost, least of all when there is no image.
        if (output !== undefined) {
          note(typeof output === "string" ? output : JSON.stringify(output));
        }
        warnings.forEach((warning) => note(describeWarning(warning)));
        if (images.length === 0) {
          throw new Error(`The tool "${name}" ran, but returned no image to write to stdout.`);
        }
        await writeOutputFile(STDIO_PATH, imageBytes(images[0]!));
        return;
      }

      if (output !== undefined) {
        printOutput(output);
      }
      warnings.forEach((warning) => note(describeWarning(warning)));

      if (images.length === 0 && out !== undefined) {
        note(`The tool "${name}" returned no image, so nothing was saved to ${out}.`);
      }
      let temporaryDirectory: string | undefined;
      for (const [index, image] of images.entries()) {
        const extension = IMAGE_EXTENSIONS[image.mimeType ?? ""] ?? ".bin";
        let path: string;
        if (out === undefined) {
          // A directory of this call's own, which only the user can open: the system's temporary
          // directory is shared, and a scene's render is as private as the scene.
          temporaryDirectory ??= await mkdtemp(join(tmpdir(), "excalidraw-cli-"));
          path = join(temporaryDirectory, numbered(name.replace(/[^\w-]/g, "_"), index, extension));
        } else {
          path = resolve(index === 0 ? out : numbered(out.slice(0, out.length - extname(out).length), index, extname(out) || extension));
          await mkdir(dirname(path), { recursive: true });
        }
        await writeFile(path, imageBytes(image), out === undefined ? { mode: 0o600 } : {});
        note(`Saved the image to ${path}`);
      }
    });
}

/** --raw is a global flag: it prints what the server sent instead of the CLI's shorter form. */
function isRaw(command: Command) {
  return getOutputOptions(command.optsWithGlobals()).raw;
}

/** Notes go to stderr, so stdout stays the tool's result. */
function note(message: string) {
  process.stderr.write(`${chalk.dim(stripControlCharacters(message))}\n`);
}

async function readArguments(args: string | undefined, argsFile: string | undefined) {
  if (argsFile !== undefined) {
    return parseArguments(await readJsonFile(argsFile), argsFile === STDIO_PATH ? "stdin" : argsFile);
  }
  if (args === undefined) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    throw new Error(`Failed to parse --args as JSON: ${message}. For large or quoted content, use --args-file.`);
  }
  return parseArguments(parsed, "--args");
}

function parseArguments(value: unknown, source: string) {
  const result = JsonObjectSchema.safeParse(value);
  if (!result.success || Array.isArray(value)) {
    throw new Error(`The tool arguments in ${source} must be a JSON object, such as {"sceneId":"..."}.`);
  }
  return result.data;
}

/** Some tools report a failure as JSON, {"error": "Scene not found"}: print the message alone. */
function errorMessage(text: string) {
  try {
    const parsed: unknown = JSON.parse(text);
    const message = parsed !== null && typeof parsed === "object" ? (parsed as { error?: unknown }).error : undefined;
    return typeof message === "string" && Object.keys(parsed as object).length === 1 ? message : text;
  } catch {
    return text;
  }
}

/** The first sentence of a description, for the tool list. */
function summarize(description: string | undefined) {
  const text = (description ?? "").trim().replace(/\s+/g, " ");
  // A period inside a word or an abbreviation, as in "1.5" or "e.g.", doesn't end a sentence.
  const end = /(?<!\b(?:e\.g|i\.e|etc|vs))[.!?](?= )/.exec(text);
  return end ? text.slice(0, end.index + 1) : text;
}

/** What an agent needs to call a tool. --raw prints the rest. */
function describeTool(tool: McpTool) {
  return {
    name: tool.name,
    description: tool.description ?? "",
    ...toolAccess(tool),
    inputSchema: tool.inputSchema ?? { type: "object" },
  };
}

function imageBytes(image: McpContentBlock) {
  return Buffer.from(image.data ?? "", "base64");
}

/** The first image keeps the name; the ones after it get -2, -3 and so on. */
function numbered(name: string, index: number, extension: string) {
  return `${name}${index > 0 ? `-${index + 1}` : ""}${extension}`;
}

/** True for the text copy of the structured content, whatever its key order or spacing. */
function isSameJson(text: string, value: unknown) {
  try {
    return isDeepStrictEqual(JSON.parse(text), value);
  } catch {
    return false;
  }
}

/** Warnings come as JSON, {"screenshotError": "No screenshot: ..."}: print them as "name: message". */
function describeWarning(text: string) {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed);
      if (entries.length > 0 && entries.every(([, value]) => typeof value === "string")) {
        return entries.map(([key, value]) => `${key}: ${value}`).join("\n");
      }
    }
  } catch {
    // Plain text.
  }
  return text;
}
