import { stripVTControlCharacters } from "node:util";
import { createProgram } from "./cli.js";
import { packageJson } from "./package.js";

import type { Argument, Command, Option } from "commander";

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

/** A block of the help text a command adds after its options, one entry per line. */
export type HelpSection = { title: string; lines: string[] };

export function createReference(): Reference {
  const program = createProgram();
  return {
    schemaVersion: 1,
    name: program.name(),
    version: packageJson.version,
    description: program.description(),
    globalOptions: visibleOptions(program),
    ...helpSections(program),
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
  const { examples, sections } = helpSections(command);
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

function commandPath(command: Command): string {
  return command.parent ? `${commandPath(command.parent)} ${command.name()}` : command.name();
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

/**
 * Splits the text a command adds after its help (see `addHelpText`) into its sections. Each section
 * is an upper-case title followed by lines indented by two spaces, and example lines start with "$ ".
 * Every line is one example or note: don't wrap them by hand, the terminal does, and the docs list
 * each line as an item.
 */
function helpSections(command: Command): { examples: string[]; sections: HelpSection[] } {
  let help = "";
  command.configureOutput({ writeOut: (text) => (help += text), getOutHasColors: () => false });
  command.outputHelp();
  const after = stripVTControlCharacters(help.slice(command.helpInformation().length));

  const sections: HelpSection[] = [];
  for (const line of after.split("\n")) {
    if (/^[A-Z][A-Z ]*$/.test(line)) {
      sections.push({ title: line, lines: [] });
    } else if (line.startsWith("  ") && sections.length > 0) {
      sections.at(-1)!.lines.push(line.slice(2).trim());
    } else if (line.trim() !== "") {
      throw new Error(`Unexpected help line for "${commandPath(command)}": ${JSON.stringify(line)}`);
    }
  }

  const examples = sections.find((section) => section.title === "EXAMPLES");
  return {
    examples: (examples?.lines ?? []).map((line) => line.replace(/^\$ /, "")),
    sections: sections.filter((section) => section !== examples),
  };
}
