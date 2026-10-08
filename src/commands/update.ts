import { spawn } from "node:child_process";
import { once } from "node:events";
import chalk from "chalk";
import { Command } from "commander";
import { emitOutput } from "../output.js";
import { packageDirectory, packageJson } from "../package.js";
import { keyValueTable } from "../tables.js";
import { detectInstallation, fetchLatestVersion, installCommand, isNewerVersion } from "../update.js";

import type { StdioOptions } from "node:child_process";

const CHECK_TIMEOUT_MS = 30_000;

export function registerUpdateCommand(program: Command) {
  program
    .command("update")
    .summary("Update the CLI to the latest version")
    .description(
      "Look up the latest version on npm and install it with the package manager that installed the CLI: npm, pnpm, yarn, bun or Volta.",
    )
    .option("--check", "only report whether a newer version is available", false)
    .addHelpText(
      "after",
      `
EXAMPLES
  $ excalidraw update
  $ excalidraw update --check

NOTES
  The package manager's output goes to stderr, so stdout carries only the JSON result.
  A CLI run through npx, pnpm dlx or bunx, or installed as a project dependency, isn't updated:
  the command says what to run instead.
  When a newer version is out, commands run in a terminal say so, at most once a day. Set
  EXCALIDRAW_NO_UPDATE_NOTIFIER=1 to turn that off. The check uses npm_config_registry if set.
`,
    )
    .action(async (options: { check: boolean }, command: Command) => {
      const currentVersion = packageJson.version;
      const latestVersion = await fetchLatestVersion(AbortSignal.timeout(CHECK_TIMEOUT_MS)).catch((error: unknown) => {
        throw new Error(`Could not look up the latest version: ${describeError(error)}.`, { cause: error });
      });
      const updateAvailable = isNewerVersion(latestVersion, currentVersion);

      if (options.check) {
        emitOutput(command, { currentVersion, latestVersion, updateAvailable }, keyValueTable);
        return;
      }

      if (!updateAvailable) {
        emitOutput(command, { currentVersion, latestVersion, updated: false, command: null }, keyValueTable);
        return;
      }

      const installation = detectInstallation();

      if (installation.type === "temporary") {
        throw new Error(
          `This excalidraw was started by ${installation.runner}, which can reuse a version it downloaded before. Run "${installation.runner} ${packageJson.name}@latest" to use ${latestVersion}.`,
        );
      }

      if (installation.type === "other") {
        throw new Error(
          `Could not tell how excalidraw was installed: it runs from ${packageDirectory}. If it's a project dependency, update ${packageJson.name} in that project. If you installed it globally, install it again with the same package manager, e.g. "npm install -g ${packageJson.name}@latest".`,
        );
      }

      const args = installCommand(installation.packageManager, latestVersion);
      console.error(chalk.dim(`Updating excalidraw ${currentVersion} → ${latestVersion}: ${args.join(" ")}`));
      await runInstall(args);

      // The install may have replaced this CLI's files, so nothing from here on may load a chunk lazily.
      emitOutput(command, { currentVersion, latestVersion, updated: true, command: args.join(" ") }, keyValueTable);
    });
}

async function runInstall(args: string[]) {
  const commandLine = args.join(" ");
  // The child's stdout goes to stderr (fd 2), so stdout carries only the JSON result.
  const stdio: StdioOptions = ["inherit", 2, "inherit"];
  const child =
    process.platform === "win32"
      ? // npm, pnpm and yarn are .cmd scripts on Windows, which only a shell runs. The command line holds
        // no user input, and the version passed VERSION_PATTERN.
        spawn(commandLine, { shell: true, stdio })
      : spawn(args[0], args.slice(1), { stdio });

  let code: number | null;
  let signal: NodeJS.Signals | null;

  try {
    [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  } catch (error) {
    throw new Error(`Could not run ${args[0]}: ${describeError(error)}. Run "${commandLine}" yourself to update.`, {
      cause: error,
    });
  }

  if (code !== 0) {
    const reason = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
    throw new Error(`"${commandLine}" ${reason}. Its output above says why.`);
  }
}

function describeError(error: unknown) {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `no answer within ${CHECK_TIMEOUT_MS / 1000} s`;
  }
  // fetch() fails with "fetch failed" and keeps the reason, such as a DNS error, in `cause`.
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  return cause instanceof Error ? cause.message : String(cause);
}
