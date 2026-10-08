import { readFile, writeFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";

/** Pass this as a file path to read from standard input, or as an output path to write to standard output. */
export const STDIO_PATH = "-";

/** C0 controls except tab and newline, DEL, and C1 controls. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Removes escape sequences and other control characters from text meant for a terminal. Names and
 * error messages can carry text other workspace members chose, which could otherwise clear the
 * screen, fake output, or set the clipboard (OSC 52).
 */
export function stripControlCharacters(text: string) {
  // The first pass drops whole sequences; the second drops the bare controls it leaves behind.
  return stripVTControlCharacters(text).replace(CONTROL_CHARACTERS, "");
}

/**
 * JSON.stringify escapes C0 controls but not DEL or C1 controls such as U+009B (CSI), which some
 * terminals act on. They only occur inside strings, so escaping them keeps every value intact.
 */
function toJson(value: unknown) {
  const json = JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `${json}\n`;
}

export async function readJsonFile(path: string) {
  const text = path === STDIO_PATH ? await readStdin() : await readFile(path, "utf8");
  const label = path === STDIO_PATH ? "stdin" : path;

  try {
    // Windows editors and PowerShell's Out-File start UTF-8 files with a byte order mark, which JSON.parse rejects.
    return JSON.parse(text.replace(/^﻿/, "")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    throw new Error(`Failed to parse JSON from ${label}: ${message}`);
  }
}

async function readStdin() {
  if (process.stdin.isTTY) {
    throw new Error('The "-" input reads JSON from standard input; pipe or redirect a file into the command.');
  }

  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

/** Writes strings and bytes as-is and other values as JSON, to a file or to stdout for "-". */
export async function writeOutputFile(path: string, value: unknown) {
  const data = typeof value === "string" || value instanceof Uint8Array ? value : toJson(value);
  if (path === STDIO_PATH) {
    // Write failures, including a reader that exits early, are handled by the stdout listener in main.ts.
    process.stdout.write(data);
    return;
  }
  await writeFile(path, data);
}

export function printOutput(value: unknown) {
  if (typeof value === "string") {
    process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
    return;
  }

  process.stdout.write(toJson(value));
}
