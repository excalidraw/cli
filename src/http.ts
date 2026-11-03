const PROXY_VARIABLES = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"];

let proxied: Promise<typeof fetch> | undefined;

/**
 * fetch() that goes through the proxy HTTPS_PROXY or HTTP_PROXY names, skipping the hosts NO_PROXY
 * lists, as curl does. Node's own fetch() ignores these variables unless NODE_USE_ENV_PROXY is set,
 * so behind a proxy, requests curl can make would fail. undici, which implements Node's fetch(),
 * is only loaded when a proxy is set.
 */
export function httpFetch(input: URL | string, init?: RequestInit): Promise<Response> {
  const useProxy =
    PROXY_VARIABLES.some((name) => process.env[name]?.trim()) && !process.env.NODE_USE_ENV_PROXY;
  if (!useProxy) {
    return fetch(input, init);
  }
  proxied ??= import("undici").then((module) => {
    // undici is CommonJS: in a split bundle, its exports are only the default export's properties.
    const { EnvHttpProxyAgent, fetch: undiciFetch } =
      "default" in module ? (module.default as typeof module) : module;
    const dispatcher = new EnvHttpProxyAgent();
    return ((url: URL | string, options?: RequestInit) =>
      undiciFetch(url, { ...(options as object), dispatcher })) as unknown as typeof fetch;
  });
  return proxied.then((proxyFetch) => proxyFetch(input, init));
}
