import { z } from "zod/v4";
import { readCredential } from "./credentials.js";
import { emptyToUndefined } from "./schemas.js";

import type { Command } from "commander";
import type { $ZodIssue } from "zod/v4/core";

const DEFAULT_API_URL = "https://api.excalidraw.com";
const API_PREFIX_PATTERN = /\/api\/v1\/*$/i;
export const DEFAULT_RETRIES = 3;
const MAX_RETRIES = 10;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_REQUEST_TIMEOUT_MS = 600_000;


export const OutputFormatSchema = z.enum(["json", "table"]);

export type OutputFormat = z.infer<typeof OutputFormatSchema>;

const OutputOptionsSchema = z.object({
  raw: z.boolean().default(false),
  output: z.preprocess(emptyToUndefined, OutputFormatSchema.default("json")),
});

const ConfigSchema = OutputOptionsSchema.extend({
  apiUrl: z.preprocess(emptyToUndefined, z.url().default(DEFAULT_API_URL)),
  // Blank means unset, so the key saved by `excalidraw login` applies.
  apiKey: z.preprocess(emptyToUndefined, z.string().trim().optional()),
  retries: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(MAX_RETRIES).default(DEFAULT_RETRIES),
  ),
  requestTimeout: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_REQUEST_TIMEOUT_MS)
      .default(DEFAULT_REQUEST_TIMEOUT_MS),
  ),
});

export type GlobalOptions = z.infer<typeof ConfigSchema>;

/** Where the credential came from: --api-key, EXCALIDRAW_API_KEY, or what `excalidraw login` saved. */
export type CredentialSource = "flag" | "env" | "login";

export type RuntimeConfig = GlobalOptions & { apiKey: string; credentialSource: CredentialSource };

export type OutputOptions = z.infer<typeof OutputOptionsSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join("\n"));
    this.name = "ConfigError";
  }
}

/** Parses the global flags. `apiKey` is set only when --api-key or EXCALIDRAW_API_KEY is. */
export function parseGlobalOptions(command: Command): GlobalOptions {
  const result = ConfigSchema.safeParse(command.optsWithGlobals());

  if (!result.success) {
    throw new ConfigError(result.error.issues.map(formatConfigIssue));
  }

  const parsed = result.data;

  return {
    ...parsed,
    apiUrl: normalizeApiUrl(parsed.apiUrl),
  };
}

/** Resolves the global flags and the API key: --api-key, then EXCALIDRAW_API_KEY, then the key saved for the API origin. */
export function resolveConfig(command: Command): RuntimeConfig {
  const options = parseGlobalOptions(command);

  if (options.apiKey) {
    // commander merges the flag and its environment variable into one option, and records which one it used.
    const credentialSource = command.getOptionValueSourceWithGlobals("apiKey") === "env" ? "env" : "flag";
    return { ...options, apiKey: options.apiKey, credentialSource };
  }

  const saved = readCredential(options.apiUrl);

  if (!saved) {
    throw new ConfigError([
      `Missing API key for ${options.apiUrl}. Run "excalidraw login", pass --api-key <key>, or set EXCALIDRAW_API_KEY.`,
    ]);
  }

  return { ...options, apiKey: saved.apiKey, credentialSource: "login" };
}

/**
 * Strips a trailing slash or a pasted "/api/v1" suffix from the origin. This only
 * affects the origin string the CLI displays (e.g. in whoami): requests are built
 * from an absolute /api/v1 path, which replaces any base path on the URL.
 */
export function normalizeApiUrl(apiUrl: string) {
  return apiUrl.replace(API_PREFIX_PATTERN, "").replace(/\/+$/, "");
}

export function getOutputOptions(options: unknown): OutputOptions {
  const result = OutputOptionsSchema.safeParse(options);

  if (!result.success) {
    throw new ConfigError(result.error.issues.map(formatConfigIssue));
  }

  return result.data;
}

function formatConfigIssue(issue: $ZodIssue) {
  const field = issue.path[0];

  if (field === "apiUrl") {
    return "Invalid API URL. Pass --api-url <url> or set EXCALIDRAW_API_URL.";
  }

  if (field === "output") {
    return "Invalid output format. Pass --output json or --output table.";
  }

  if (field === "retries") {
    return `Invalid retry count. Pass --retries <n> with a whole number from 0 to ${MAX_RETRIES}.`;
  }

  if (field === "requestTimeout") {
    return `Invalid request timeout. Pass --request-timeout <ms> with a whole number from 1 to ${MAX_REQUEST_TIMEOUT_MS}.`;
  }

  const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`;
}
