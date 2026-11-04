/**
 * The plugin's own `WebFetchProvider`.
 *
 * It subclasses the runtime's `HttpFetchProvider` so redirect handling, URL validation,
 * byte/char caps, content-type checks, charset decoding, and timeout/cancel semantics stay
 * exactly the upstream implementation. Only `requestOnce` — the network hop — is replaced:
 * every web_fetch request goes through the plugin's private loopback channel, never the
 * process-wide dispatcher or connection pool.
 *
 * The base class is injected by the Host half (`createProxySwitchProvider`) so a missing
 * or renamed `@deepseek-ai/dsh-web-fetch-http` becomes a visible "takeover failed" state
 * instead of a module-load crash.
 */
import { WebError } from "@deepseek-ai/dsh-web";
import { requestThroughLocalProxy } from "./proxy-client.js";

/** Registry id configured through `web.config.fetchProvider`. */
export const WEB_FETCH_PROVIDER_ID = "dsh-proxy-switch";

/**
 * @param Base - the runtime `HttpFetchProvider` class.
 * @returns a provider class with the plugin id and a private-channel `requestOnce`.
 */
export function createProxySwitchProvider(Base) {
  return class ProxySwitchFetchProvider extends Base {
    id = WEB_FETCH_PROVIDER_ID;

    /**
     * @param limits - the limits of the provider this plugin replaces (`http`), so caps and
     *   user-agent stay identical to the user's configured `web-fetch-http`.
     * @param options.getPort - the private channel's bound loopback port, or null.
     * @param options.getAuthToken - the per-start private-channel token.
     * @param options.tlsOptions - test-only TLS overrides; production passes none.
     */
    constructor(limits, options) {
      super(limits);
      this.options = options;
    }

    /** Usable only while the private channel is bound. */
    available() {
      const port = this.options.getPort();
      return Number.isInteger(port) && port > 0;
    }

    async requestOnce(url, signal) {
      const port = this.options.getPort();
      if (!Number.isInteger(port) || port <= 0) {
        throw new WebError("dsh-proxy-switch: the web_fetch channel is not listening", "WEB_PROVIDER_UNAVAILABLE");
      }
      const headers = {
        "user-agent": this.limits.userAgent,
        accept: "text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8",
      };
      return requestThroughLocalProxy({
        url,
        headers,
        signal,
        proxyPort: port,
        authToken: this.options.getAuthToken?.(),
        tlsOptions: this.options.tlsOptions,
      });
    }
  };
}
