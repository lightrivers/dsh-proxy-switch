/**
 * Which `requestOnce` contract the running `HttpFetchProvider` base class expects.
 *
 * The seam changed in `@deepseek-ai/dsh-web-fetch-http` 0.2.2-rc.1:
 *
 * - 0.2.1 and earlier: `requestOnce()` returns `{ response, close }`; the base's
 *   `followAndRead` destructures `const { response } = request` and calls
 *   `await request.close()` before returning.
 * - 0.2.2 and later: `requestOnce()` returns a WHATWG `Response`; the base cancels or
 *   reads `response.body` and never calls a `close`, so resources must be released when
 *   the body is consumed, cancelled, or errors.
 *
 * Returning the wrong shape is not recoverable with a `try`/`catch`: the 0.2.2 base reads
 * `response.headers` immediately and throws a `TypeError` that the caller cannot tell from
 * a fetch failure. The contract is therefore determined up front, from two explicit
 * signals, in this order:
 *
 * 1. **The base class source.** `HttpFetchProvider.prototype.followAndRead` is the code
 *    that consumes the value, so how it calls `requestOnce` is direct evidence. This
 *    works even when two runtime copies are loaded side by side.
 * 2. **The package version**, when the source cannot be inspected. The contract changed
 *    exactly once, in 0.2.2-rc.1, and no 0.2.x release before it had the new shape.
 *
 * With neither signal available the old contract is assumed, because every release before
 * 0.2.2 used it.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** `requestOnce()` must return a WHATWG `Response` (0.2.2 and later). */
export const RESPONSE_CONTRACT = "response";
/** `requestOnce()` must return `{ response, close }` (0.2.1 and earlier). */
export const RESPONSE_CLOSE_CONTRACT = "response+close";

const BASE_PACKAGE = "@deepseek-ai/dsh-web-fetch-http";
/** The first release whose base class consumes a bare `Response`. */
const RESPONSE_CONTRACT_VERSION = Object.freeze([0, 2, 2]);

function sourceOf(fn) {
  try {
    return typeof fn === "function" ? Function.prototype.toString.call(fn) : "";
  } catch {
    return "";
  }
}

/**
 * Classify the contract from the base class's own redirect loop.
 *
 * @param source - `followAndRead` source text, or anything else.
 * @returns a contract name, or `null` when the source shows neither shape.
 */
export function contractFromBaseSource(source) {
  if (typeof source !== "string" || source === "") return null;
  if (/const\s+response\s*=\s*await\s+this\.requestOnce\(/u.test(source)) return RESPONSE_CONTRACT;
  if (/const\s+request\s*=\s*await\s+this\.requestOnce\(/u.test(source) && /request\.close\(\)/u.test(source)) {
    return RESPONSE_CLOSE_CONTRACT;
  }
  return null;
}

/**
 * Classify the contract from a package version.
 *
 * @param version - a semver string such as `0.2.2-rc.1`.
 * @returns a contract name, or `null` for a version outside 0.2.x.
 */
export function contractFromVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(String(version ?? ""));
  if (match === null) return null;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major !== 0 || minor !== 2) return null;
  return patch >= RESPONSE_CONTRACT_VERSION[2] ? RESPONSE_CONTRACT : RESPONSE_CLOSE_CONTRACT;
}

/** Version of the `dsh-web-fetch-http` copy this plugin resolves, or `null`. */
function resolvedBaseVersion() {
  try {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve(BASE_PACKAGE));
    for (let depth = 0; depth < 4; depth += 1) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (manifest?.name === BASE_PACKAGE && typeof manifest.version === "string") return manifest.version;
      } catch {
        /* keep walking towards the package root */
      }
      dir = dirname(dir);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Decide the contract for one base class.
 *
 * @param Base - the `HttpFetchProvider` class this plugin subclasses.
 * @param options.version - version override (tests); defaults to the resolved package.
 * @returns `{ contract, reason }`; `reason` names the signal that decided it.
 */
export function contractOf(Base, options = {}) {
  const fromSource = contractFromBaseSource(sourceOf(Base?.prototype?.followAndRead));
  if (fromSource !== null) return { contract: fromSource, reason: "base-class source" };
  const version = options.version !== void 0 ? options.version : resolvedBaseVersion();
  const fromVersion = contractFromVersion(version);
  if (fromVersion !== null) return { contract: fromVersion, reason: `package version ${version}` };
  return { contract: RESPONSE_CLOSE_CONTRACT, reason: "default (no release before 0.2.2 used another contract)" };
}

/** Wrap a disposer so it runs at most once and never throws. */
function once(fn) {
  let called = false;
  return () => {
    if (called) return Promise.resolve();
    called = true;
    try {
      return Promise.resolve(fn()).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  };
}

/**
 * Return a `Response` whose completion releases the private-channel resources.
 *
 * The 0.2.2 base class only ever touches the body, so the disposer rides on every way the
 * body can end: fully read, cancelled, or errored. A body-less response (204/205/304)
 * releases immediately.
 *
 * @param input.response - the response built by the proxy client.
 * @param input.close - destroys the response, tunnel, and agent.
 */
export function bindCloseToBody({ response, close }) {
  const release = once(close);
  if (response.body === null) {
    void release();
    return response;
  }
  const reader = response.body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          void release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        void release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      void release();
      try {
        await reader.cancel(reason);
      } catch {
        /* the source is already gone */
      }
    },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * Shape one private-channel result for the base class that asked for it.
 *
 * @param contract - a contract name from {@link contractOf}.
 * @param proxied - `{ response, close }` from the proxy client.
 * @returns `{ response, close }` (old contract) or a `Response` (new contract).
 */
export function shapeRequestOnceResult(contract, proxied) {
  return contract === RESPONSE_CONTRACT ? bindCloseToBody(proxied) : proxied;
}
