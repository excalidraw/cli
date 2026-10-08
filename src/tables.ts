import { column, pick } from "./table.js";

import type { TableSpec } from "./table.js";

const listRows = (key: string) => (value: unknown) => {
  const rows = pick(value, key);
  return Array.isArray(rows) ? rows : [];
};

export const sceneTable: TableSpec = {
  rows: listRows("data"),
  columns: [
    column("id", "metadata.id"),
    column("name", "metadata.name"),
    column("collection", "metadata.collection"),
    column("pinned", "metadata.pinned"),
    column("updated", "metadata.updated"),
  ],
};

export const collectionTable: TableSpec = {
  rows: listRows("data"),
  columns: [column("id", "id"), column("name", "name"), column("created", "created")],
};

export const userTable: TableSpec = {
  rows: listRows("data"),
  columns: [
    column("id", "id"),
    column("name", "name"),
    column("email", "email"),
    column("role", "role"),
    column("last active", "lastActive"),
  ],
};

export const inviteTable: TableSpec = {
  rows: listRows("data"),
  columns: [
    column("id", "id"),
    column("type", "type"),
    column("email", "email"),
    column("role", "role"),
    column("status", "status"),
    {
      header: "uses",
      // Email invites carry no usage limit, so the cell stays empty.
      value: (row) => {
        const maxUses = pick(row, "maxUses");
        return maxUses === undefined || maxUses === null ? null : `${pick(row, "uses") ?? 0}/${maxUses}`;
      },
    },
    column("domains", "restrictedDomains"),
  ],
};

export const logTable: TableSpec = {
  rows: listRows("logs"),
  columns: [
    column("time", "created_at"),
    column("action", "action"),
    column("operation", "operation"),
    { header: "user", value: (row) => pick(row, "user_email") ?? pick(row, "user_id") },
    column("status", "status"),
  ],
};

/** Renders a flat object as two columns: one row per key. */
export const keyValueTable: TableSpec = {
  rows: (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(flatten(value as Record<string, unknown>)).map(([key, item]) => ({ key, item }))
      : [],
  columns: [column("field", "key"), column("value", "item")],
};

function flatten(value: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;

    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      Object.assign(result, flatten(item as Record<string, unknown>, name));
    } else {
      result[name] = item;
    }
  }

  return result;
}
