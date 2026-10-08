import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { stripVTControlCharacters } from "node:util";

type ExecError = Error & {
  code?: number | string;
  stdout: string;
  stderr: string;
};

// The CLI's own settings, except the browser path the render tests may need, and the color switches commander and chalk read.
const CLI_SETTING = /^EXCALIDRAW_(?!BROWSER_PATH$)/;
const COLOR_SWITCHES = new Set(["NO_COLOR", "FORCE_COLOR", "CLICOLOR_FORCE"]);

/**
 * The developer's environment without the variables that change what the CLI does or prints, plus `env`.
 * Node's own warnings depend on the Node version and NODE_OPTIONS, not the CLI, so they're silenced for stderr assertions.
 */
export function cliEnv(env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(([name]) => !CLI_SETTING.test(name) && !COLOR_SWITCHES.has(name));
  return { ...Object.fromEntries(inherited), NODE_NO_WARNINGS: "1", ...env };
}

export function assertExecError(error: unknown): asserts error is ExecError {
  assert.ok(error instanceof Error);
  assert.ok("stdout" in error && typeof error.stdout === "string");
  assert.ok("stderr" in error && typeof error.stderr === "string");
}

/**
 * Runs the CLI with stdout attached to a file descriptor (e.g. /dev/full to make every write fail),
 * or to a pipe whose reader is already gone.
 */
export async function runWithStdout(
  args: string[],
  stdout: number | "closed",
  { input, env }: { input?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const child = spawn(process.execPath, args, {
    env,
    stdio: ["pipe", stdout === "closed" ? "pipe" : stdout, "pipe"],
  });
  assert.ok(child.stdin && child.stderr);
  // Like `| head` exiting before the command writes: its first write fails with EPIPE.
  if (stdout === "closed") {
    child.stdout?.destroy();
  }
  child.stdin.end(input);
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [code] = await once(child, "close");
  return { code, stderr: stripVTControlCharacters(stderr) };
}
