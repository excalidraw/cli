import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod/v4";

/**
 * Parses a command's options. Issues name the flag the user typed (--max-width), not the option's
 * property (maxWidth). Use plain parse() for anything else, such as scene content.
 */
export function parseOptions<T extends z.ZodType>(schema: T, options: unknown): z.output<T> {
  const result = schema.safeParse(options);

  if (!result.success) {
    throw new z.ZodError(
      result.error.issues.map((issue) => {
        const [key, ...rest] = issue.path;
        return typeof key === "string" ? { ...issue, path: [toFlag(key), ...rest] } : issue;
      }),
    );
  }

  return result.data;
}

function toFlag(property: string) {
  return `--${property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/** Treats a blank flag or environment variable as unset, so the default applies. */
export const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export const PaginationOptionsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  all: z.boolean().default(false),
});

export const SceneListOptionsSchema = PaginationOptionsSchema.extend({
  collectionId: z.string().min(1).optional(),
});

export const CollectionSceneCreateOptionsSchema = z.object({
  name: z.string().min(1),
  pinned: z.boolean().default(false),
  file: z.string().min(1).optional(),
});

// POST /scenes requires collectionId. Personal keys may pass "private".
export const SceneCreateOptionsSchema = CollectionSceneCreateOptionsSchema.extend({
  collectionId: z.string().min(1),
});

export const SceneUpdateOptionsSchema = z
  .object({
    name: z.string().min(1).optional(),
    collectionId: z.string().min(1).optional(),
    pinned: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: "Provide at least one of --name, --collection-id, or --pinned.",
  });

export const SceneShareOptionsSchema = z.object({
  access: z.enum(["view", "edit", "none"]),
});

export const SceneShareSlidesOptionsSchema = z.object({
  off: z.boolean().default(false),
});

export const ContentFileOptionsSchema = z.object({
  file: z.string().min(1),
});

export const ContentGetOptionsSchema = z.object({
  out: z.string().min(1).optional(),
});

export const ImageFormatSchema = z.enum(["png", "svg"]);

const ImageOptionsSchema = z.object({
  out: z.string().min(1),
  padding: z.coerce.number().int().min(0).max(1000).default(20),
  scale: z.coerce.number().positive().max(16).default(1),
  maxWidth: z.coerce.number().int().min(1).max(16384).default(16384),
  maxHeight: z.coerce.number().int().min(1).max(16384).default(16384),
  theme: z.enum(["light", "dark"]).optional(),
  transparent: z.boolean().default(false),
  browserPath: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),
  timeout: z.coerce.number().int().min(1).max(600000).default(30000),
  // Comma-separated mirrors of the font release's dist/prod/ folder: http(s) URLs, local folders or
  // file: URLs, or "none" to disable downloads. Folders become file: URLs.
  fontsUrl: z.preprocess(
    (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined),
    z
      .string()
      .transform((value, context) => {
        if (value.toLowerCase() === "none") {
          return [];
        }
        const urls: string[] = [];
        for (const entry of value.split(",").map((part) => part.trim())) {
          const problem = mirrorProblem(entry);
          if (problem) {
            context.issues.push({ code: "custom", message: problem, input: value });
            return z.NEVER;
          }
          // A scheme, but not a Windows drive letter such as C:\fonts.
          const url = /^[a-z][a-z0-9+.-]+:/i.test(entry) ? entry : pathToFileURL(resolve(entry)).href;
          urls.push(url.replace(/\/?$/, "/"));
        }
        return urls;
      })
      .optional(),
  ),
});

export type ImageOptions = z.infer<typeof ImageOptionsSchema>;

/** Why an entry of --fonts-url can't be a mirror, if it can't. Catches typos that would silently become folders. */
function mirrorProblem(entry: string) {
  if (entry === "") {
    return "expected http(s) URLs or folders separated by commas, but one entry is empty";
  }
  if (entry.toLowerCase() === "none") {
    return "none turns font downloads off, so it can't be combined with mirrors";
  }
  if (/^[a-z][a-z0-9+.-]+:/i.test(entry)) {
    return URL.canParse(entry) && /^(https?|file):$/.test(new URL(entry).protocol)
      ? undefined
      : `${entry} is not an http(s) or file: URL`;
  }
  return statSync(resolve(entry), { throwIfNoEntry: false })?.isDirectory()
    ? undefined
    : `${entry} is not a folder; mirror URLs start with https://`;
}

export const RenderOptionsSchema = ImageOptionsSchema.extend({
  format: ImageFormatSchema.optional(),
  frameId: z.string().min(1).optional(),
  allFrames: z.boolean().default(false),
})
  .refine((value) => !(value.allFrames && value.frameId !== undefined), {
    message: "Use either --frame-id or --all-frames, not both.",
  })
  .refine((value) => !(value.allFrames && value.out === "-"), {
    message: "--all-frames writes one file per frame; pass a directory to --out.",
  });

export type RenderOptions = z.infer<typeof RenderOptionsSchema>;

export const MermaidOptionsSchema = ImageOptionsSchema.extend({
  format: z.enum(["excalidraw", ...ImageFormatSchema.options]).optional(),
  elbow: z.boolean().default(false),
  fontSize: z.coerce.number().int().min(8).max(200).optional(),
});

export const JsonObjectSchema = z.record(z.string(), z.unknown());

export const CollectionCreateOptionsSchema = z.object({
  name: z.string().min(1),
});

export const CollectionUpdateOptionsSchema = z.object({
  name: z.string().min(1),
});

/** A picture URL, or "none" to remove the picture (sends null). */
const PictureSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim().toLowerCase() === "none" ? null : value),
  z.url().nullable(),
);

export const WorkspaceUpdateOptionsSchema = z
  .object({
    name: z.string().min(1).optional(),
    picture: PictureSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.picture !== undefined, {
    message: "Provide at least one of --name or --picture.",
  });

export const RoleSchema = z.enum(["member", "admin"]);

export const WorkspaceUserUpdateOptionsSchema = z
  .object({
    name: z.string().min(1).optional(),
    picture: PictureSchema.optional(),
    role: RoleSchema.optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: "Provide at least one of --name, --picture, or --role.",
  });

export const InviteCreateOptionsSchema = z.object({
  email: z.email(),
  role: RoleSchema,
});

// The API accepts a positive integer or the literal "unlimited".
export const MaxUsesSchema = z.union([
  z.literal("unlimited"),
  z.coerce.number().int().min(1),
]);

const splitDomains = (value: unknown) =>
  typeof value === "string"
    ? value
        .split(",")
        .map((domain) => domain.trim())
        .filter((domain) => domain.length > 0)
    : value;

/** Comma-separated list such as "example.com,example.org". */
export const RestrictedDomainsSchema = z.preprocess(
  splitDomains,
  z.array(z.string().min(1)).min(1, "Provide at least one domain, for example --restricted-domains example.com"),
);

/** Same as RestrictedDomainsSchema, but "none" clears the restriction (sends null). */
export const RestrictedDomainsUpdateSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim().toLowerCase() === "none" ? null : splitDomains(value)),
  z.array(z.string().min(1)).min(1).nullable(),
);

export const InviteLinkCreateOptionsSchema = z.object({
  role: RoleSchema,
  // Always sent so the link's limit is explicit instead of left to the server.
  maxUses: MaxUsesSchema.default(1),
  restrictedDomains: RestrictedDomainsSchema.optional(),
});

export const InviteUpdateOptionsSchema = z
  .object({
    email: z.email().optional(),
    role: RoleSchema.optional(),
    maxUses: MaxUsesSchema.optional(),
    restrictedDomains: RestrictedDomainsUpdateSchema.optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: "Provide at least one of --email, --role, --max-uses, or --restricted-domains.",
  });

// Logs paginate by cursor or page number; the API has no offset for them.
export const LogsListOptionsSchema = PaginationOptionsSchema.omit({ offset: true }).extend({
  cursor: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).optional(),
  user: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  operation: z.enum(["create", "read", "update", "delete"]).optional(),
  dateFrom: z.string().min(1).optional(),
  dateTo: z.string().min(1).optional(),
})
  .refine((value) => !(value.all && value.page !== undefined), {
    message: "--all follows cursor pagination and cannot be combined with --page.",
  })
  .refine((value) => !(value.cursor !== undefined && value.page !== undefined), {
    message: "Use either --cursor or --page, not both.",
  });
