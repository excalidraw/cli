import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** The prebuilt @excalidraw/utils browser bundle, which inlines every font as a data URL. */
export async function readUtilsBundle() {
  return readFile(new URL(import.meta.resolve("@excalidraw/utils")), "latin1");
}

export const FONT_DATA_URL = /"data:font\/woff2;base64,([A-Za-z0-9+/=]+)"/g;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
