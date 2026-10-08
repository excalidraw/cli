import { stripControlCharacters } from "./io.js";

const MAX_CELL_WIDTH = 48;
const COLUMN_GAP = "  ";

export type Column = {
  header: string;
  value: (row: unknown) => unknown;
};

/** Describes how to render one command's JSON output as a table. */
export type TableSpec = {
  rows: (value: unknown) => unknown[];
  columns: Column[];
};

export function formatTable(rows: unknown[], columns: Column[]) {
  if (rows.length === 0) {
    return "No results.";
  }

  const cells = rows.map((row) => columns.map((column) => formatCell(column.value(row))));
  // A loop, not Math.max(...cells): spreading every row as an argument overflows the stack on long lists.
  const widths = columns.map((column) => column.header.length);
  for (const line of cells) {
    for (const [index, cell] of line.entries()) {
      widths[index] = Math.max(widths[index]!, displayWidth(cell));
    }
  }

  // Padding counts terminal columns, so CJK and emoji names keep the columns aligned.
  const renderLine = (values: string[]) =>
    values
      .map((value, index) =>
        index === values.length - 1 ? value : value + " ".repeat(widths[index]! - displayWidth(value)),
      )
      .join(COLUMN_GAP)
      .trimEnd();

  return [
    renderLine(columns.map((column) => column.header.toUpperCase())),
    ...cells.map(renderLine),
  ].join("\n");
}

export function formatCell(value: unknown): string {
  let text: string;

  if (value === null || value === undefined || value === "") {
    text = "-";
  } else if (typeof value === "boolean") {
    text = value ? "yes" : "no";
  } else if (Array.isArray(value)) {
    text = value.length === 0 ? "-" : value.map((item) => formatCell(item)).join(", ");
  } else if (typeof value === "object") {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }

  text = stripControlCharacters(text.replace(/\s+/g, " "));

  return truncate(text, MAX_CELL_WIDTH);
}

/** Cuts text to `limit` terminal columns, ending in "…", without splitting a character. */
function truncate(text: string, limit: number) {
  if (displayWidth(text) <= limit) {
    return text;
  }
  let kept = "";
  let width = 0;
  for (const character of characters(text)) {
    if (width + character.width > limit - 1) {
      break;
    }
    kept += character.segment;
    width += character.width;
  }
  return `${kept}…`;
}

/** The number of terminal columns text takes. */
function displayWidth(text: string) {
  // Printable ASCII, the common case, takes one column per character.
  if (/^[\x20-\x7e]*$/.test(text)) {
    return text.length;
  }
  return characters(text).reduce((sum, character) => sum + character.width, 0);
}

const graphemes = new Intl.Segmenter();

// Wide and fullwidth East Asian blocks: Hangul Jamo, CJK radicals and punctuation, kana, CJK
// ideographs, Yi, Hangul syllables, compatibility ideographs and forms, fullwidth forms, and the
// supplementary ideograph planes.
const WIDE =
  /^[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3FFFD}]/u;

/**
 * Splits text into the characters a terminal draws (grapheme clusters, so an emoji sequence stays
 * whole), with their widths: 2 for wide East Asian characters and emoji, 0 for invisible ones.
 */
function characters(text: string) {
  return Array.from(graphemes.segment(text), ({ segment }) => ({
    segment,
    width: /^\p{Default_Ignorable_Code_Point}+$/u.test(segment)
      ? 0
      : /\p{Emoji_Presentation}|️/u.test(segment) || WIDE.test(segment)
        ? 2
        : 1,
  }));
}

/** Reads a dotted path such as "metadata.id" from an unknown value. */
export function pick(value: unknown, path: string): unknown {
  let current: unknown = value;

  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

export function column(header: string, path: string): Column {
  return { header, value: (row) => pick(row, path) };
}
