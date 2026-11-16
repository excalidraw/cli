# Configuration

These flags can also be set with environment variables.

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--api-key` | `EXCALIDRAW_API_KEY` | login saved by `login` |
| `--api-url` | `EXCALIDRAW_API_URL` | `https://api.excalidraw.com` |
| `-o, --output` | `EXCALIDRAW_OUTPUT` | `json` |
| `--retries` | `EXCALIDRAW_RETRIES` | `3` |
| `--request-timeout` | `EXCALIDRAW_REQUEST_TIMEOUT` | `60000` ms |
| `--browser-path` | `EXCALIDRAW_BROWSER_PATH` | detected |
| `--fonts-url` | `EXCALIDRAW_FONTS_URL` | Excalidraw's CDN, npmmirror, jsDelivr |

For a self-hosted or staging instance, set `--api-url` to the origin, without `/api/v1`.

Requests go through the proxy `HTTPS_PROXY` or `HTTP_PROXY` names, except to hosts `NO_PROXY` lists.

## Logging in

`excalidraw login` asks how to log in: with the browser, or by pasting an API key. Choosing "Not now" leaves everything as it was. `excalidraw login --web` logs in with the browser without asking, and `excalidraw login --api-key <key>` saves a key without asking. A login the API rejects isn't saved. Commands use the saved login when neither `--api-key` nor `EXCALIDRAW_API_KEY` is set; `whoami` reports which one is in use as `credentialSource` (`flag`, `env` or `login`).

Logging in with the browser opens Excalidraw+, where you sign in, pick a workspace and allow the CLI. The CLI then acts as you in that workspace, with your role, like a personal API key, and `whoami` reports its `keyType` as `oauth`. It refreshes its access token by itself and stays logged in until you log out or disconnect "Excalidraw CLI" in Excalidraw+ under **Settings → Connected apps**. If a workspace admin turns off **Allow AI connectors**, the browser login stops working in that workspace; use an API key there. The browser sends the login back to the CLI on `127.0.0.1`, so it has to run on the same computer: over SSH, log in with an API key instead. `BROWSER` picks the browser command.

## API keys

There are two kinds of API key. Workspace keys act for the whole workspace. They can't see private scenes, so `scenes create` needs a real collection ID. Personal keys start with `uk-` and act as one user, with that user's role. They can pass `private` as the collection ID to use the owner's private collection. Run `excalidraw whoami` to see which kind you're using.

## Saved logins

Logins are saved per API origin, so a staging login is only sent to staging: `excalidraw login --api-url https://staging.example.com` saves one next to your production login. They live in `~/.config/excalidraw-cli/credentials.json` (`$XDG_CONFIG_HOME` if set, `%APPDATA%` on Windows), readable only by you. `excalidraw logout` removes the login for the origin and revokes a browser login; to revoke an API key itself, delete it in Excalidraw+.

The full API reference lives at [plus.excalidraw.com/docs/api](https://plus.excalidraw.com/docs/api).
