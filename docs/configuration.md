# Configuration

These flags can also be set with environment variables.

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--api-key` | `EXCALIDRAW_API_KEY` | key saved by `login` |
| `--api-url` | `EXCALIDRAW_API_URL` | `https://api.excalidraw.com` |
| `-o, --output` | `EXCALIDRAW_OUTPUT` | `json` |
| `--retries` | `EXCALIDRAW_RETRIES` | `3` |
| `--request-timeout` | `EXCALIDRAW_REQUEST_TIMEOUT` | `60000` ms |
| `--browser-path` | `EXCALIDRAW_BROWSER_PATH` | detected |
| `--fonts-url` | `EXCALIDRAW_FONTS_URL` | Excalidraw's CDN, npmmirror, jsDelivr |

For a self-hosted or staging instance, set `--api-url` to the origin, without `/api/v1`.

Requests go through the proxy `HTTPS_PROXY` or `HTTP_PROXY` names, except to hosts `NO_PROXY` lists.

## API keys

There are two kinds of API key. Workspace keys act for the whole workspace. They can't see private scenes, so `scenes create` needs a real collection ID. Personal keys start with `uk-` and act as one user, with that user's role. They can pass `private` as the collection ID to use the owner's private collection. Run `excalidraw whoami` to see which kind you're using.

`excalidraw login` asks how to log in (an API key for now; logging in with the browser through OAuth is coming soon), checks the key against the API and saves it. Choosing "Not now" leaves everything as it was. A key the API rejects isn't saved. Commands use the saved key when neither `--api-key` nor `EXCALIDRAW_API_KEY` is set; `whoami` reports which one is in use as `credentialSource` (`flag`, `env` or `login`).

Keys are saved per API origin, so a staging key is only sent to staging: `excalidraw login --api-url https://staging.example.com` saves one next to your production key. They live in `~/.config/excalidraw-cli/credentials.json` (`$XDG_CONFIG_HOME` if set, `%APPDATA%` on Windows), readable only by you. `excalidraw logout` removes the key for the origin; to revoke the key itself, delete it in Excalidraw+.

The full API reference lives at [plus.excalidraw.com/docs/api](https://plus.excalidraw.com/docs/api).
