import { createProgram } from "./cli.js";
import { commandPath, helpSections } from "./help.js";
import { packageJson } from "./package.js";

import type { Argument, Command, Option } from "commander";
import type { HelpSection } from "./help.js";

/**
 * The command reference that `pnpm run build` writes to dist/reference.json. The docs at
 * plus.excalidraw.com/docs/cli are generated from it, so bump `schemaVersion` when a change would
 * break a reader.
 */
export type Reference = {
  schemaVersion: 1;
  name: string;
  version: string;
  description: string;
  /** Flags every command accepts. */
  globalOptions: OptionReference[];
  examples: string[];
  /** The top-level help's other sections, such as SETUP and OUTPUT. */
  sections: HelpSection[];
  commands: CommandReference[];
};

export type CommandReference = {
  /** The full command line without options, such as "excalidraw scenes content patch". */
  path: string;
  name: string;
  usage: string;
  summary: string;
  description: string;
  arguments: ArgumentReference[];
  options: OptionReference[];
  examples: string[];
  /** The help's other sections after EXAMPLES, usually just NOTES. */
  sections: HelpSection[];
  commands: CommandReference[];
};

export type ArgumentReference = {
  name: string;
  description: string;
  required: boolean;
  variadic: boolean;
};

export type OptionReference = {
  flags: string;
  description: string;
  required: boolean;
  env?: string;
  default?: string;
  choices?: string[];
};


export function createReference(): Reference {
  const program = createProgram();
  return {
    schemaVersion: 1,
    name: program.name(),
    version: packageJson.version,
    description: program.description(),
    globalOptions: visibleOptions(program),
    ...examplesAndSections(program),
    commands: subcommands(program),
  };
}

function subcommands(command: Command): CommandReference[] {
  return command
    .createHelp()
    .visibleCommands(command)
    .filter((subcommand) => subcommand.name() !== "help")
    .map(describeCommand);
}

function describeCommand(command: Command): CommandReference {
  const { examples, sections } = examplesAndSections(command);
  return {
    path: commandPath(command),
    name: command.name(),
    usage: `${commandPath(command)} ${command.usage()}`,
    summary: command.summary() || command.description(),
    description: command.description(),
    arguments: command.createHelp().visibleArguments(command).map(describeArgument),
    options: visibleOptions(command),
    examples,
    sections,
    commands: subcommands(command),
  };
}

function describeArgument(argument: Argument): ArgumentReference {
  return {
    name: argument.name(),
    description: argument.description,
    required: argument.required,
    variadic: argument.variadic,
  };
}

function visibleOptions(command: Command): OptionReference[] {
  return command
    .createHelp()
    .visibleOptions(command)
    .filter((option) => option.long !== "--help")
    .map(describeOption);
}

function describeOption(option: Option): OptionReference {
  return {
    flags: option.flags,
    description: option.description,
    required: option.mandatory,
    ...(option.envVar && { env: option.envVar }),
    ...(option.defaultValueDescription !== undefined
      ? { default: option.defaultValueDescription }
      : option.defaultValue !== undefined &&
        typeof option.defaultValue !== "boolean" && { default: String(option.defaultValue) }),
    ...(option.argChoices && { choices: option.argChoices }),
  };
}

/** The examples and other sections a command's help adds after its options (see help.ts). */
function examplesAndSections(command: Command): { examples: string[]; sections: HelpSection[] } {
  const sections = helpSections(command);
  const examples = sections.find((section) => section.title === "EXAMPLES");
  return {
    examples: (examples?.lines ?? []).map((line) => line.replace(/^\$ /, "")),
    sections: sections.filter((section) => section !== examples),
  };
}
