import { z } from "zod/v4";

import type { PublicApiClient, RequestOptions } from "./client.js";

/** The API caps page size at 100; --all uses the largest page to minimize round trips. */
const MAX_PAGE_SIZE = 100;

const OffsetPageSchema = z
  .object({
    data: z.array(z.unknown()),
    hasNextPage: z.boolean(),
  })
  .loose();

const LogsPageSchema = z
  .object({
    logs: z.array(z.unknown()),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    availableActions: z.array(z.string()).optional(),
  })
  .loose();

type OffsetQuery = NonNullable<RequestOptions["query"]> & {
  limit?: number;
  offset?: number;
};

/** Walks every offset-paginated page and returns the combined items. */
export async function fetchAllPages(client: PublicApiClient, path: string, query: OffsetQuery) {
  const pageSize = query.limit ?? MAX_PAGE_SIZE;
  const data: unknown[] = [];
  let offset = query.offset ?? 0;

  for (;;) {
    const page = OffsetPageSchema.parse(
      await client.request("GET", path, {
        query: { ...query, limit: pageSize, offset },
        raw: false,
      }),
    );

    data.push(...page.data);

    if (!page.hasNextPage || page.data.length === 0) {
      break;
    }

    offset += page.data.length;
  }

  return { count: data.length, data };
}

type LogsQuery = NonNullable<RequestOptions["query"]> & {
  limit?: number;
  cursor?: string;
};

/** Follows nextCursor until the API reports no more logs. */
export async function fetchAllLogs(client: PublicApiClient, query: LogsQuery) {
  const pageSize = query.limit ?? MAX_PAGE_SIZE;
  const logs: unknown[] = [];
  let cursor = query.cursor;
  let availableActions: string[] = [];

  for (;;) {
    const page = LogsPageSchema.parse(
      await client.request("GET", "/logs", {
        query: { ...query, limit: pageSize, cursor },
        raw: false,
      }),
    );

    logs.push(...page.logs);
    availableActions = page.availableActions ?? availableActions;

    if (!page.hasMore || !page.nextCursor || page.logs.length === 0) {
      break;
    }

    cursor = page.nextCursor;
  }

  return { count: logs.length, logs, availableActions };
}
