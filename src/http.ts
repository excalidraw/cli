import chalk from "chalk";

/** Variables that configure a proxy for curl, undici or Node. The render browser gets none of them. */
export const PROXY_VARIABLE = /^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i;

const PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:"]);

let proxied: Promise<typeof fetch> | undefined;

/**
 * fetch() that goes through the proxy HTTPS_PROXY or HTTP_PROXY names, skipping the hosts NO_PROXY
 * lists, as curl does. Node's own fetch() ignores these variables unless NODE_USE_ENV_PROXY is set,
 * so behind a proxy, requests curl can make would fail. undici, which implements Node's fetch(),
 * is only loaded when a proxy is set.
 */
export function httpFetch(input: URL | string, init?: RequestInit): Promise<Response> {
  const httpsProxy = proxySetting("https_proxy", "HTTPS_PROXY");
  const httpProxy = proxySetting("http_proxy", "HTTP_PROXY");
  if (!httpsProxy && !httpProxy) {
    return fetch(input, init);
  }
  proxied ??= proxiedFetch(httpsProxy, httpProxy);
  return proxied.then((proxyFetch) => proxyFetch(input, init));
}

type ProxySetting = { name: string; url: string };

/** The first of the variables that is set. Like curl, a proxy without a scheme is an HTTP proxy. */
function proxySetting(...names: string[]): ProxySetting | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return { name, url: /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}` };
    }
  }
  return undefined;
}

/**
 * A proxy the CLI can't use, such as socks4://, is skipped with a warning rather than failing every
 * request: before the CLI read these variables, it connected directly.
 */
function usable(setting: ProxySetting | undefined) {
  if (!setting) {
    return undefined;
  }
  const protocol = URL.canParse(setting.url) ? new URL(setting.url).protocol : undefined;
  if (protocol && PROXY_PROTOCOLS.has(protocol)) {
    return setting.url;
  }
  // The value can hold a password, so only its scheme is quoted.
  const kind = protocol ? `a ${protocol.slice(0, -1)} proxy` : "not a valid URL";
  warn(`Ignoring ${setting.name}: it is ${kind}. Use an http://, https:// or socks5:// proxy URL. Connecting directly instead.`);
  return undefined;
}

async function proxiedFetch(httpsSetting?: ProxySetting, httpSetting?: ProxySetting): Promise<typeof fetch> {
  const httpsProxy = usable(httpsSetting);
  const httpProxy = usable(httpSetting);
  if (!httpsProxy && !httpProxy) {
    return fetch;
  }
  const module = await import("undici");
  // undici is CommonJS: in a split bundle, its exports are only the default export's properties.
  const { EnvHttpProxyAgent, fetch: undiciFetch } = "default" in module ? (module.default as typeof module) : module;
  let dispatcher: InstanceType<typeof EnvHttpProxyAgent>;
  try {
    // An empty string, unlike undefined, stops undici from reading the variable itself. HTTPS
    // requests go through the HTTP proxy when only that one is set. NO_PROXY is read by undici.
    dispatcher = new EnvHttpProxyAgent({ httpsProxy: httpsProxy ?? "", httpProxy: httpProxy ?? "" });
  } catch (error) {
    warn(`Ignoring the proxy settings (${error instanceof Error ? error.message : String(error)}). Connecting directly instead.`);
    return fetch;
  }
  return ((url: URL | string, options?: RequestInit) =>
    undiciFetch(url, { ...(options as object), dispatcher })) as unknown as typeof fetch;
}

/** Printed once: the proxied fetch() is set up on the first request. */
function warn(message: string) {
  process.stderr.write(`${chalk.yellow(message)}\n`);
}
