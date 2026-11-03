import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The parts of src/reference.ts's types these tests read; tests don't import from src/.
type CommandReference = {
  path: string;
  name: string;
  options: { flags: string }[];
  examples: string[];
  commands: CommandReference[];
};

const reference: {
  schemaVersion: number;
  version: string;
  globalOptions: { env?: string }[];
  commands: CommandReference[];
} = JSON.parse(await readFile(new URL("../dist/reference.json", import.meta.url), "utf8"));

function allCommands(commands: CommandReference[]): CommandReference[] {
  return commands.flatMap((command) => [command, ...allCommands(command.commands)]);
}

test("reference.json describes the published version", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(reference.schemaVersion, 1);
  assert.equal(reference.version, packageJson.version);
  assert.ok(reference.globalOptions.some((option) => option.env === "EXCALIDRAW_API_KEY"));
});

test("reference.json lists every command with examples", () => {
  const commands = allCommands(reference.commands);
  assert.ok(commands.some((command) => command.path === "excalidraw scenes content patch"));
  assert.ok(!commands.some((command) => command.name === "help"));
  for (const command of commands) {
    assert.ok(command.examples.length > 0, `${command.path} has no examples`);
    assert.ok(!command.options.some((option) => option.flags.includes("--help")), `${command.path} lists --help`);
  }
});

test("reference.json doesn't contain the build machine's paths", () => {
  assert.ok(!JSON.stringify(reference).includes(process.env.HOME ?? "/home/"));
});
