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
import { contractOf, shapeRequestOnceResult } from "./provider-contract.js";
import { requestThroughLocalProxy } from "./proxy-client.js";

/** Registry id configured through `web.config.fetchProvider`. */
export const WEB_FETCH_PROVIDER_ID = "dsh-proxy-switch";

/**
 * @param Base - the runtime `HttpFetchProvider` class.
 * @returns a provider class with the plugin id and a private-channel `requestOnce`.
 */
export function createProxySwitchProvider(Base) {
  // Which shape this base class wants from `requestOnce` is decided once, from the base
  // class itself (see provider-contract.js for the two signals and why they are explicit).
  const { contract, reason } = contractOf(Base);
  return class ProxySwitchFetchProvider extends Base {
    id = WEB_FETCH_PROVIDER_ID;
    /** `response` (0.2.2+) or `response+close` (0.2.1 and earlier). */
    contract = contract;
    contractReason = reason;

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
      const proxied = await requestThroughLocalProxy({
        url,
        headers,
        signal,
        proxyPort: port,
        authToken: this.options.getAuthToken?.(),
        tlsOptions: this.options.tlsOptions,
      });
      return shapeRequestOnceResult(this.contract, proxied);
    }
  };
}
