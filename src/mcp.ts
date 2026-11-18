import { z } from "zod/v4";
import { packageJson } from "./package.js";

import type { PublicApiClient } from "./client.js";

/** The MCP revision the CLI asks for. The server answers `initialize` with one it supports. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * Streamable HTTP: a server may answer a request with JSON or with an event stream, and a client
 * must accept both.
 */
const MCP_ACCEPT = "application/json, text/event-stream";

const ToolSchema = z
  .object({
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    inputSchema: z.unknown().optional(),
    outputSchema: z.unknown().optional(),
    annotations: z
      .object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() })
      .loose()
      .optional(),
    _meta: z
      .object({ ui: z.object({ visibility: z.array(z.string()).optional() }).loose().optional() })
      .loose()
      .optional(),
  })
  .loose();

export type McpTool = z.infer<typeof ToolSchema>;

const ToolListSchema = z.object({ tools: z.array(ToolSchema), nextCursor: z.string().optional() }).loose();

const ContentBlockSchema = z
  .object({
    type: z.string(),
    /** Set on text blocks. */
    text: z.string().optional(),
    /** Set on image and audio blocks: base64. */
    data: z.string().optional(),
    mimeType: z.string().optional(),
  })
  .loose();

export type McpContentBlock = z.infer<typeof ContentBlockSchema>;

const ToolResultSchema = z
  .object({
    content: z.array(ContentBlockSchema).default([]),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional(),
  })
  .loose();

export type McpToolResult = z.infer<typeof ToolResultSchema>;

const InitializeResultSchema = z
  .object({
    protocolVersion: z.string(),
    serverInfo: z.object({ name: z.string(), version: z.string().optional() }).loose().optional(),
    instructions: z.string().optional(),
  })
  .loose();

const ResponseSchema = z
  .object({
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    result: z.unknown().optional(),
    error: z.object({ code: z.number().optional(), message: z.string() }).loose().optional(),
  })
  .loose();

/** A JSON-RPC error: the server turned the request down, for instance an unknown tool. */
export class McpError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
  ) {
    super(message);
    this.name = "McpError";
  }
}

/**
 * Calls the Excalidraw+ MCP server at /api/v1/mcp with the CLI's login, over the API client: its
 * retries, deadline, proxy and login refresh apply.
 *
 * The server keeps no session: every request stands alone, so the CLI sends `tools/list` and
 * `tools/call` without an `initialize` round trip before them.
 */
export class McpClient {
  private nextId = 1;

  constructor(private readonly api: PublicApiClient) {}

  /** What the server says about itself, with the instructions it gives agents. */
  async initialize() {
    const result = await this.send(
      "initialize",
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "excalidraw-cli", version: packageJson.version } },
      { repeatable: true, negotiated: false },
    );
    return InitializeResultSchema.parse(result);
  }

  /** Every tool the login may use, following the list's pages. */
  async listTools() {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = ToolListSchema.parse(
        await this.send("tools/list", cursor === undefined ? {} : { cursor }, { repeatable: true }),
      );
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return tools;
  }

  /** A tool's own failure comes back as a result with `isError`, not as a thrown error. */
  async callTool(name: string, args: Record<string, unknown>) {
    // Not repeatable: most tools write, and one that half-ran must not run twice.
    return ToolResultSchema.parse(await this.send("tools/call", { name, arguments: args }));
  }

  private async send(
    method: string,
    params: Record<string, unknown>,
    { repeatable = false, negotiated = true }: { repeatable?: boolean; negotiated?: boolean } = {},
  ) {
    const id = this.nextId++;
    const text = await this.api.request("POST", "/mcp", {
      body: { jsonrpc: "2.0", id, method, params },
      raw: true,
      repeatable,
      headers: {
        Accept: MCP_ACCEPT,
        // Sent once a version is agreed on, which for a server without sessions is from the start.
        ...(negotiated && { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION }),
      },
    });
    const response = findResponse(String(text), id);

    if (response.error) {
      throw new McpError(response.error.message, response.error.code);
    }
    return response.result;
  }
}

/** The answer to request `id` in a response body: one JSON message, or an event stream of them. */
function findResponse(text: string, id: number) {
  for (const message of parseMessages(text)) {
    const response = ResponseSchema.safeParse(message);
    // An error for a request the server could not read carries no id.
    if (response.success && (response.data.id === id || (response.data.id == null && response.data.error))) {
      return response.data;
    }
  }
  throw new Error("The MCP server's response has no answer to the request. Use --raw to print it.");
}

function parseMessages(text: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // An event stream: events end with a blank line, and an event's data lines join with newlines.
    return text
      .split(/\r?\n\r?\n/)
      .map((event) =>
        event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n"),
      )
      .filter((data) => data !== "")
      .flatMap((data) => {
        try {
          return [JSON.parse(data) as unknown];
        } catch {
          return [];
        }
      });
  }
}

/** True for a tool that only the server's own views call, which an agent has no use for. */
export function isAppOnlyTool(tool: McpTool) {
  const visibility = tool._meta?.ui?.visibility;
  return visibility !== undefined && !visibility.includes("model");
}

/** The MCP defaults: a tool without hints may write, and may change or remove what exists. */
export function toolAccess(tool: McpTool) {
  const readOnly = tool.annotations?.readOnlyHint ?? false;
  return { readOnly, destructive: !readOnly && (tool.annotations?.destructiveHint ?? true) };
}
