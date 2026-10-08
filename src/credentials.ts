import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod/v4";

// OAuth tokens will be another member of this union.
const CredentialSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("api-key"), apiKey: z.string().min(1) }),
]);

export type Credential = z.infer<typeof CredentialSchema>;

/**
 * Bumped only for changes that older versions of the CLI can't read or rewrite safely: they refuse a
 * newer file rather than misread or overwrite it. Additive changes keep the version, because a rewrite
 * keeps fields it doesn't know and an unknown credential type asks for an upgrade.
 */
const FILE_VERSION = 1;

const CredentialsFileSchema = z
  .object({
    version: z.literal(FILE_VERSION),
    // Keyed by API origin.
    origins: z.record(z.string(), z.unknown()),
  })
  .loose();

type CredentialsFile = z.infer<typeof CredentialsFileSchema>;

/**
 * Where `excalidraw login` saves credentials. macOS uses ~/.config too, like gh: it's where terminal
 * users look for a CLI's settings.
 */
export function credentialsPath() {
  const base = process.env.XDG_CONFIG_HOME
    ? process.env.XDG_CONFIG_HOME
    : process.platform === "win32"
      ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : join(homedir(), ".config");
  return join(base, "excalidraw-cli", "credentials.json");
}

/**
 * Credentials are saved per API origin, the host requests go to, so a key is only ever sent to the
 * origin it was saved for, even when --api-url points somewhere else.
 */
export function readCredential(apiUrl: string): Credential | undefined {
  const origin = new URL(apiUrl).origin;
  const { origins } = readCredentialsFile();

  if (!Object.hasOwn(origins, origin)) {
    return undefined;
  }

  const result = CredentialSchema.safeParse(origins[origin]);

  if (!result.success) {
    // Most likely a credential type that a newer version of the CLI saved.
    throw new Error(
      `Can't use the credentials saved for ${origin} in ${credentialsPath()}. If a newer version of the CLI saved them, upgrade it; otherwise run "excalidraw login" to replace them.`,
    );
  }

  return result.data;
}

export async function saveCredential(apiUrl: string, credential: Credential) {
  // Logging in again is how to recover from a damaged file, so it starts a new one.
  const file = readCredentialsFile({ replaceInvalid: true });
  file.origins[new URL(apiUrl).origin] = credential;
  await writeCredentialsFile(file);
}

/** Returns whether there was a credential to remove. */
export async function removeCredential(apiUrl: string) {
  const file = readCredentialsFile();
  const origin = new URL(apiUrl).origin;

  if (!Object.hasOwn(file.origins, origin)) {
    return false;
  }

  delete file.origins[origin];
  await writeCredentialsFile(file);
  return true;
}

function readCredentialsFile({ replaceInvalid = false } = {}): CredentialsFile {
  const path = credentialsPath();
  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: FILE_VERSION, origins: {} };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  // Checked before the layout, which a newer version may have changed.
  const version = parsed !== null && typeof parsed === "object" ? (parsed as { version?: unknown }).version : undefined;
  if (typeof version === "number" && version > FILE_VERSION) {
    throw new Error(`${path} was saved by a newer version of the excalidraw CLI. Upgrade the CLI to use it.`);
  }

  const result = CredentialsFileSchema.safeParse(parsed);

  if (!result.success) {
    if (replaceInvalid) {
      return { version: FILE_VERSION, origins: {} };
    }
    throw new Error(`Can't read the saved credentials in ${path}. Run "excalidraw login" again.`);
  }

  return result.data;
}

async function writeCredentialsFile(file: CredentialsFile) {
  const path = credentialsPath();

  try {
    if (Object.keys(file.origins).length === 0) {
      await retryWhileLocked(() => rm(path, { force: true }));
      return;
    }

    // The file holds API keys, so only the user may read it. Windows ignores the modes; the
    // profile directory is private there already.
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Written next to the file and renamed over it, so an interrupted write can't truncate it.
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    try {
      await retryWhileLocked(() => rename(temporary, path));
    } finally {
      // Already gone after the rename. If the rename failed, it's a copy of the keys to clean up.
      await rm(temporary, { force: true });
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
    const hint = isLocked(error) ? " Another program, such as antivirus or a backup tool, may have it open; try again." : "";
    throw new Error(`Could not update ${path} (${code}).${hint}`, { cause: error });
  }
}

const LOCK_ATTEMPTS = 5;

/**
 * Windows can't replace or delete a file that another program has open, such as antivirus scanning
 * it right after a write. Those locks are usually brief, so wait for them: 1 s in total.
 */
async function retryWhileLocked(action: () => Promise<void>) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (!isLocked(error) || attempt === LOCK_ATTEMPTS) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

function isLocked(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
}
