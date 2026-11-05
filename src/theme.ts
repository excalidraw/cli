import chalk from "chalk";

export const helpTheme = {
  title: chalk.bold,
  usage: chalk.cyan,
  command: chalk.cyan,
  subcommand: chalk.cyan,
  option: chalk.yellow,
  argument: chalk.magenta,
  description: chalk.dim,
};

/** Excalidraw's violet, for the CLI's name in interactive screens. */
export const brandBadge = (text: string) => chalk.bgHex("#6965db").hex("#ffffff").bold(` ${text} `);
