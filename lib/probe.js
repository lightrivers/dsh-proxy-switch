/**
 * Upstream reachability probe for `dsh-proxy-switch`.
 *
 * A TCP connect is enough: it answers the only question the switch needs (is something
 * listening at the upstream address?) without sending traffic through the proxy, and it
 * cannot be confused by an HTTP error page the proxy itself returns. It deliberately
 * probes on its own timer rather than once per request, so the sidebar can show a state
 * that is current before any request is attempted.
 */
import net from "node:net";
import { dialHostname } from "./net-guard.js";

export const DEFAULT_PROBE_TIMEOUT_MS = 1_500;

/**
 * One TCP-connect probe.
 *
 * @param upstream - parsed upstream URL (`http://host:port`).
 * @param options.timeoutMs - connect timeout.
 * @param options.connectImpl - `net.connect` override for tests.
 * @returns `{ reachable, latencyMs, error }` — never rejects.
 */
export function probeUpstream(upstream, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const connect = options.connectImpl ?? net.connect;
  const host = dialHostname(upstream.hostname);
  const port = upstream.port === "" ? 80 : Number(upstream.port);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ host, port });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve({ latencyMs: Date.now() - startedAt, ...result });
    };
    const timer = setTimeout(() => finish({ reachable: false, error: "timeout" }), timeoutMs);
    socket.once("connect", () => finish({ reachable: true, error: null }));
    socket.once("error", (error) => finish({ reachable: false, error: error?.code ?? "error" }));
    socket.once("timeout", () => finish({ reachable: false, error: "timeout" }));
  });
}

/**
 * A restartable probe loop that reports every result through `onUpdate`.
 *
 * `intervalMs` and the upstream are read through getters so a settings change applies to
 * the next tick without recreating the loop.
 *
 * @param options.getUpstream - returns the parsed upstream URL.
 * @param options.getIntervalMs - returns the current probe interval.
 * @param options.onUpdate - receives `{ reachable, latencyMs, error, checkedAt }`.
 * @param options.probeImpl - probe override for tests.
 * @returns `{ start, stop, runNow }`.
 */
export function createProbeLoop(options) {
  const { getUpstream, getIntervalMs, onUpdate, probeImpl = probeUpstream } = options;
  let timer = null;
  let stopped = true;
  let running = null;

  const runNow = async () => {
    if (running !== null) return running;
    running = (async () => {
      const result = await probeImpl(getUpstream());
      const update = { ...result, checkedAt: Date.now() };
      onUpdate(update);
      return update;
    })().finally(() => {
      running = null;
    });
    return running;
  };

  const schedule = () => {
    if (stopped) return;
    const interval = Math.max(1_000, Number(getIntervalMs()) || 15_000);
    timer = setTimeout(async () => {
      try {
        await runNow();
      } catch {
        /* probe failures are reported through onUpdate / the next tick */
      }
      schedule();
    }, interval);
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      void runNow()
        .then(schedule)
        .catch(() => schedule());
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    runNow,
    /** Re-arm the timer after a settings change without dropping the current tick. */
    reschedule() {
      if (stopped) return;
      if (timer !== null) clearTimeout(timer);
      schedule();
    },
  };
}
