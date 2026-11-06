import chalk from "chalk";
import { packageJson } from "./package.js";
import { brandBadge, freeAccent, plusAccent } from "./theme.js";

import type { EventEmitter } from "node:events";
import type { Command, Help, Option } from "commander";

/** A block of the help text a command adds after its options, one entry per line. */
export type HelpSection = { title: string; lines: string[] };

/** Command groups, as passed to commandsGroup(), and how their headings look. */
export const FREE_GROUP = "Free, no account";
export const PLUS_GROUP = "With Excalidraw+";

const sectionsByCommand = new WeakMap<Command, HelpSection[]>();

/**
 * The sections a command adds after its help with `addHelpText("after", ...)`: an upper-case title,
 * then lines indented by two spaces, each one example ("$ ...") or note. Don't wrap them by hand:
 * the help wraps them to the terminal, and the docs list each line as an item. The first call takes
 * the text over from commander, which would otherwise print it unformatted after the help.
 */
export function helpSections(command: Command): HelpSection[] {
  let sections = sectionsByCommand.get(command);
  if (sections) {
    return sections;
  }
  // Commands are event emitters, though commander's types don't say so.
  const events = command as unknown as EventEmitter;
  let text = "";
  for (const listener of events.listeners("afterHelp")) {
    listener({ error: false, command, write: (chunk: string) => (text += chunk) });
  }
  events.removeAllListeners("afterHelp");

  sections = [];
  for (const line of text.split("\n")) {
    if (/^[A-Z][A-Z ]*$/.test(line)) {
      sections.push({ title: line, lines: [] });
    } else if (line.startsWith("  ") && sections.length > 0) {
      sections.at(-1)!.lines.push(line.slice(2).trim());
    } else if (line.trim() !== "") {
      throw new Error(`Unexpected help line for "${commandPath(command)}": ${JSON.stringify(line)}`);
    }
  }
  sectionsByCommand.set(command, sections);
  return sections;
}

export function commandPath(command: Command): string {
  return command.parent ? `${commandPath(command.parent)} ${command.name()}` : command.name();
}

/** The help for every command, laid out like the login screen. */
export function formatHelp(command: Command, helper: Help): string {
  // Wide terminals get the width of a comfortable read, not every column.
  const width = Math.min(helper.helpWidth ?? 80, 100);
  const out: string[] = [""];
  const wrap = (text: string, indent: number) =>
    helper
      .boxWrap(text, width - indent)
      .split("\n")
      .map((line) => " ".repeat(indent) + line)
      .join("\n");
  const section = (title: string, lines: string[]) => {
    if (lines.length > 0) {
      out.push(`  ${title}`, ...lines, "");
    }
  };

  const path = commandPath(command);
  out.push(
    command.parent
      ? `  ${brandBadge("✎ Excalidraw CLI")} ${chalk.bold(path.replace(/^\S+ /, ""))}`
      : `  ${brandBadge("✎ Excalidraw CLI")} ${chalk.dim(`v${packageJson.version} · excalidraw.com`)}`,
    "",
  );
  if (command.description()) {
    out.push(wrap(command.description(), 2), "");
  }
  const commands = helper.visibleCommands(command).filter((subcommand) => subcommand.name() !== "help");
  const usage = commands.length > 0 ? "<command> [options]" : command.usage();
  section(chalk.bold("Usage"), [`    ${chalk.dim("$")} ${path} ${usage}`]);

  // Terms and descriptions in two columns. Pass all of a help's terms to align several lists.
  const items = (entries: [string, string][], alignWith = entries.map(([term]) => term)) => {
    const termWidth = Math.min(Math.max(...alignWith.map((term) => helper.displayWidth(term))), 26);
    const descriptionWidth = width - 4 - termWidth - 3;
    return entries.map(([term, description]) => {
      const termLength = helper.displayWidth(term);
      if (termLength > termWidth || descriptionWidth < 24) {
        return `    ${term}\n${wrap(description, 4 + termWidth + 3)}`;
      }
      const [first, ...rest] = helper.boxWrap(description, descriptionWidth).split("\n");
      return [
        `    ${term}${" ".repeat(termWidth - termLength + 3)}${first}`,
        ...rest.map((line) => " ".repeat(4 + termWidth + 3) + line),
      ].join("\n");
    });
  };

  section(
    chalk.bold("Arguments"),
    items(
      helper
        .visibleArguments(command)
        .map((argument) => [chalk.magenta(helper.argumentTerm(argument)), argument.description]),
    ),
  );

  const groups = new Map<string, Command[]>();
  for (const subcommand of commands) {
    const group = subcommand.helpGroup() || "Commands";
    groups.set(group, [...(groups.get(group) ?? []), subcommand]);
  }
  for (const [group, subcommands] of groups) {
    section(
      groupTitle(group),
      items(
        subcommands.map((subcommand) => [chalk.cyan(commandTerm(subcommand)), subcommand.summary() || subcommand.description()]),
        commands.map(commandTerm),
      ),
    );
  }

  const options = helper.visibleOptions(command).filter((option) => option.long !== "--help");
  section(
    chalk.bold(command.parent ? "Options" : "Global options"),
    items(options.map((option) => [chalk.yellow(option.flags), optionDescription(option)])),
  );

  for (const { title, lines } of helpSections(command)) {
    const name = title.charAt(0) + title.slice(1).toLowerCase();
    if (title === "EXAMPLES") {
      section(
        chalk.bold(name),
        lines.flatMap((line, index) =>
          line.startsWith("$ ")
            ? [`    ${chalk.dim("$")} ${line.slice(2)}`]
            : // A label for the examples after it, such as "No account needed:".
              [...(index > 0 ? [""] : []), `    ${labelStyle(line)(line)}`],
        ),
      );
    } else {
      section(
        chalk.bold(name),
        lines.map((line) => `    ${chalk.dim("•")}${wrap(line, 6).slice(5)}`),
      );
    }
  }

  out.push(
    chalk.dim(
      commands.length > 0
        ? `  Run "${path} <command> --help" for a command's options and examples.`
        : `  Global options, such as --api-key and --output, work here too: see "excalidraw --help".`,
    ),
    "",
  );
  return out.join("\n");
}

/** The subcommand and its arguments, without "[options]": its own help lists those. */
function commandTerm(command: Command) {
  const args = command.registeredArguments.map((argument) =>
    argument.required ? `<${argument.name()}>` : `[${argument.name()}]`,
  );
  return [command.name(), ...args].join(" ");
}

/** The description, then its default and environment variable, dimmed. */
function optionDescription(option: Option) {
  // Many descriptions end with their default, such as "resolution multiplier; default 1".
  const [, description = option.description, inlineDefault] = /^(.*?);\s*default (.+)$/.exec(option.description) ?? [];
  const extras = [
    inlineDefault && `default ${inlineDefault}`,
    option.defaultValueDescription !== undefined ||
    (option.defaultValue !== undefined && typeof option.defaultValue !== "boolean")
      ? `default ${option.defaultValueDescription ?? String(option.defaultValue)}`
      : undefined,
    option.envVar && `env ${option.envVar}`,
  ].filter(Boolean);
  return extras.length > 0 ? `${description} ${chalk.dim(`(${extras.join(", ")})`)}` : description;
}

function groupTitle(group: string) {
  if (group === FREE_GROUP) {
    return freeAccent.bold(group);
  }
  if (group === PLUS_GROUP) {
    return `${plusAccent.bold(group)} ${chalk.dim('· needs an API key, run "excalidraw login"')}`;
  }
  return chalk.bold(group);
}

function labelStyle(label: string) {
  if (/no account/i.test(label)) {
    return freeAccent;
  }
  return /excalidraw\+/i.test(label) ? plusAccent : chalk.bold;
}
