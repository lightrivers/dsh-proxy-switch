/**
 * Pure helpers shared by the Host half and its tests.
 *
 * Kept separate from `index.js` so the unit tests can import them without loading
 * `@deepseek-ai/dsh-http-proxy` (which only resolves inside a running Harness).
 */
import { warningParagraph } from "./messages.js";

/**
 * Wrap a launch environment so a proxy policy resolves to this plugin's listener.
 *
 * `ALL_PROXY` is shadowed as unset: an inherited `ALL_PROXY` would answer a scheme the
 * overrides do not cover and route around the switch.
 *
 * `NO_PROXY` is deliberately preserved. The default `web_fetch_only` scope never installs
 * this policy at all; the `global` scope is an explicit takeover of other modules, and
 * clearing NO_PROXY there would hand a child process "original proxy + new bypass list"
 * (the upstream package restores the user's proxy names for children but resolves the
 * bypass list from the installed policy). web_fetch itself does not use this policy, so
 * preserving the list cannot let a web_fetch target escape the switch.
 *
 * @param base - the launch environment snapshot (`get(name) -> { value, source }`).
 * @param proxyUrl - this plugin's loopback listener URL.
 * @returns an object with the same `get(name)` shape the resolver reads.
 */
export function createProxyOverrideEnvironment(base, proxyUrl) {
  const overrides = new Map();
  for (const key of ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY"]) overrides.set(key, proxyUrl);
  for (const key of ["all_proxy", "ALL_PROXY"]) overrides.set(key, null);
  return {
    get(variable) {
      if (overrides.has(variable)) {
        const value = overrides.get(variable);
        return value === null ? void 0 : { value, source: "dsh-proxy-switch" };
      }
      return base.get(variable);
    },
  };
}

/**
 * The destination a `web_fetch` call is about to reach, as `{ host, port }`.
 *
 * Only `http:`/`https:` URLs are registered. Everything else passes through the wrapper
 * untouched, exactly like the fetch provider itself refuses it before any network
 * operation.
 *
 * @param url - the `web_fetch` URL, when the arguments carried one.
 * @returns `{ host, port }` or `undefined`.
 */
export function strictTargetOf(url) {
  if (typeof url !== "string" || url === "") return void 0;
  let target;
  try {
    target = new URL(url);
  } catch {
    return void 0;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return void 0;
  const port = target.port === "" ? (target.protocol === "https:" ? 443 : 80) : Number(target.port);
  return { host: target.hostname, port };
}

/** A `web_fetch` attempt refused before dispatch, with a model-facing explanation. */
export function failureResult(message, code) {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
    error: { message, info: { name: "DshProxySwitchError", code } },
  };
}

/** Append the warning paragraph to a tool result without touching its other blocks. */
export function appendWarning(result, warning, details) {
  const text = warningParagraph(warning, details);
  const content = Array.isArray(result?.content) ? result.content : [];
  return { ...result, content: [...content, { type: "text", text: `\n${text}\n` }] };
}

/** Read `web_fetch`'s target URL from parsed tool arguments. */
export function webFetchUrlOf(args) {
  if (typeof args === "string") {
    // Some callers pass the parsed-arguments JSON as a string rather than an object.
    const trimmed = args.trim();
    if (trimmed.startsWith("{")) {
      try {
        return webFetchUrlOf(JSON.parse(trimmed));
      } catch {
        /* fall through: treat it as a plain URL string */
      }
    }
    return args;
  }
  if (args === null || typeof args !== "object") return void 0;
  const url = args.url ?? args.href ?? args.target;
  return typeof url === "string" ? url : void 0;
}

/**
 * Decide what the `tools/execute` wrapper should do for one `web_fetch` call before dispatch.
 *
 * In `direct` mode the forwarder would refuse a fake-IP destination anyway, but the refusal
 * would arrive as an opaque proxy error inside `dsh-web-fetch-http`. Checking first turns it
 * into a model-readable explanation that names the actual cause. Every other mode, every
 * non-HTTP(S) URL, and every URL this module cannot parse passes through untouched.
 *
 * @param input.mode - the active switch mode.
 * @param input.url - the `web_fetch` target URL when the arguments carried one.
 * @param input.resolve - resolver returning `{ ok: true }` or a refusal with `code`/`message`.
 * @returns `{ action: "pass" }` or `{ action: "refuse", code, message }`.
 */
export async function precheckWebFetch(input) {
  const { mode, url, resolve } = input;
  if (mode !== "direct") return { action: "pass" };
  const target = strictTargetOf(url);
  if (target === void 0) return { action: "pass" };
  const verdict = await resolve(target.host);
  if (!verdict.ok) return { action: "refuse", code: verdict.code, message: verdict.message };
  return { action: "pass" };
}
