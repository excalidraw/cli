import { z } from "zod/v4";
import { ApiError, apiPath } from "./client.js";
import { readJsonFile, STDIO_PATH } from "./io.js";
import { JsonObjectSchema } from "./schemas.js";

import type { PublicApiClient } from "./client.js";

const CreatedSceneSchema = z.object({ metadata: z.object({ id: z.string() }) }).loose();

/**
 * Excalidraw opens exports without these fields, but the API requires them, so they're filled in
 * when missing. Present values are never changed. Like Excalidraw's own exports, `source` names the
 * app that wrote the file.
 */
const EXPORT_DEFAULTS = {
  type: "excalidraw",
  version: 2,
  source: "https://www.npmjs.com/package/@excalidraw/cli",
  appState: {},
  files: {},
};

// The shapes the content endpoints require (https://api.excalidraw.com/docs/json), checked before
// anything is written. Unknown fields pass: the API ignores them, and new ones shouldn't need a CLI update.
const ElementsSchema = z.array(z.record(z.string(), z.unknown()));
const FilesSchema = z.record(
  z.string(),
  z.object({ mimeType: z.string(), id: z.string(), created: z.number(), dataURL: z.string() }).loose(),
);

/** A full Excalidraw export, written with PUT. `elements` has no default: a full replacement without it would empty the scene. */
const FullContentSchema = z
  .object({
    type: z.literal("excalidraw"),
    version: z.number(),
    source: z.string(),
    elements: ElementsSchema,
    appState: z.unknown(),
    files: FilesSchema,
  })
  .loose();

/** Partial content, merged with PATCH. */
const PartialContentSchema = z
  .object({
    elements: ElementsSchema.optional(),
    appState: z.record(z.string(), z.unknown()).optional(),
    files: FilesSchema.optional(),
  })
  .loose()
  .refine(
    (value) => value.elements !== undefined || value.appState !== undefined || value.files !== undefined,
    { message: "Provide at least one of elements, appState, or files." },
  );

const MAX_REPORTED_ISSUES = 10;

/**
 * Creates a scene and, when a content file is given, writes it in the same run.
 * The file is read and validated before the scene is created so a bad file never
 * leaves an empty scene behind.
 */
export async function createScene(
  client: PublicApiClient,
  path: string,
  body: unknown,
  file: string | undefined,
) {
  const content = file === undefined ? undefined : await readInitialContent(file);
  const created = await client.request("POST", path, { body, raw: false });

  if (content !== undefined) {
    await writeInitialSceneContent(client, created, content);
  }

  return created;
}

/** Reads a complete replacement for a scene's content, filling in missing export fields. */
export async function readFullContent(file: string) {
  return checkFullContent(file, await readJsonFile(file), ", so the scene was not changed");
}

/**
 * Reads the content for a new scene. A full Excalidraw export carries type: "excalidraw" and
 * replaces the empty scene with PUT; anything else is treated as a partial patch.
 */
async function readInitialContent(file: string) {
  const content = await readJsonFile(file);
  const consequence = ", so no scene was created";

  if (z.object({ type: z.literal("excalidraw") }).safeParse(content).success) {
    return { method: "PUT", body: checkFullContent(file, content, consequence) };
  }

  return {
    method: "PATCH",
    body: checkContent(file, content, PartialContentSchema, "valid partial scene content", consequence),
  };
}

function checkFullContent(file: string, content: unknown, consequence: string) {
  const object = JsonObjectSchema.safeParse(content);
  const filled = object.success ? { ...EXPORT_DEFAULTS, ...object.data } : content;
  return checkContent(file, filled, FullContentSchema, "a complete Excalidraw export", consequence);
}

/** Returns the content as it is if it matches the schema, or throws an error that lists what's wrong. */
function checkContent(
  file: string,
  content: unknown,
  schema: z.ZodType,
  expected: string,
  consequence: string,
) {
  const result = schema.safeParse(content);

  if (result.success) {
    return content;
  }

  const source = file === STDIO_PATH ? "stdin" : file;
  const issues = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `  - ${path}${issue.message}`;
  });
  if (issues.length > MAX_REPORTED_ISSUES) {
    issues.splice(MAX_REPORTED_ISSUES, Infinity, `  - …and ${issues.length - MAX_REPORTED_ISSUES} more`);
  }
  throw new Error([`${source} is not ${expected}${consequence}:`, ...issues].join("\n"));
}

/**
 * Writes content into a scene that was just created. Full exports replace the
 * empty scene with PUT; partial payloads (elements, appState, files) use PATCH.
 * Failures are re-thrown with the scene ID so the caller can recover the scene.
 */
async function writeInitialSceneContent(
  client: PublicApiClient,
  created: unknown,
  { method, body }: { method: string; body: unknown },
) {
  const sceneId = CreatedSceneSchema.parse(created).metadata.id;

  try {
    await client.request(method, apiPath`/scenes/${sceneId}/content`, { body });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `Scene ${sceneId} was created, but writing its content failed: ${detail}`;

    if (error instanceof ApiError) {
      throw new ApiError(error.status, message, error.body);
    }

    throw new Error(message, { cause: error });
  }

  return sceneId;
}
