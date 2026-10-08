// Types for embedded-fonts.mjs, which the render tests share with the build scripts.
export function readUtilsBundle(): Promise<string>;
export const FONT_DATA_URL: RegExp;
export function sha256(bytes: Uint8Array): string;
