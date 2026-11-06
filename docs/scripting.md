# Scripting and agents

- Commands print JSON, except `login` and `logout`, which print a confirmation. `-o table` prints list commands, `whoami` and `update` as a table.
- Set `EXCALIDRAW_API_KEY` rather than running `login`, which asks for the key in a terminal. `excalidraw login --api-key <key>` saves a key without asking.
- Lists return 5 items by default (50 for logs), up to 100 with `--limit`. `--all` fetches every page and prints `{ count, data }`. `logs list` reads the log in order with `--cursor`, or jumps to a page with `--page`; its `--all` follows the cursor to the end and can't be combined with `--page`.
- `--raw` prints the API's response text as received, and shows API errors in full.
- `-` as a file path reads from stdin for inputs (`render -`, `--file -`) and writes to stdout for `--out`.
- Rate-limited and failed read requests are retried, see `--retries` and `--request-timeout`. Retry notices go to stderr, so stdout stays parseable.
- Any error exits with status 1.
- API requests send `User-Agent: excalidraw-cli/<version> node/<version> <platform>-<arch>`, so the API can tell CLI usage apart from other API clients.
- The update check only runs when stdout and stderr are both a terminal, and never in CI (`CI` set), so it doesn't touch piped output or slow down scripts.
