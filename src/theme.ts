import chalk from "chalk";

/** Excalidraw's violet, for the CLI's name in the help and interactive screens. */
export const brandBadge = (text: string) => chalk.bgHex("#6965db").hex("#ffffff").bold(` ${text} `);

/** What works without an account, and what Excalidraw+ adds, in the help and the login screen. */
export const freeAccent = chalk.green;
export const plusAccent = chalk.hex("#a5a3f5");
