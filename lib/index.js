/**
 * `dsh-proxy-switch` — a switchable web_fetch outbound path.
 *
 * v0.3 architecture: the default `web_fetch_only` scope does **not** install a global
 * proxy policy, does **not** rewrite `process.env`, and does **not** share a dispatcher or
 * connection pool with model calls, MCP, search, or child processes. It registers its own
 * `WebFetchProvider` into `ctx.web` and points `web.config.fetchProvider` at it. That
 * provider talks to a private loopback forwarder (`webFetchForwarder`) which owns the
 * forward/direct decision and the SSRF check.
 *
 * `scope = global` is the explicit takeover option: it additionally binds
 * `globalForwarder` on `listenPort` and installs the process-wide policy, so other modules
 * also follow the switch. `NO_PROXY` is preserved in that policy; web_fetch is already
 * isolated in its own provider, so it still follows the switch.
 *
 * v0.4 adds `mode = auto` (the route follows the upstream probe) and upstream
 * auto-detection (`upstreamSource = auto`, see `detect.js`). Both only change which
 * route the forwarders pick and which upstream they dial; the forwarders, the SSRF check,
 * and the provider are unchanged.
 *
 * The plugin only works for a web_fetch swap when `@deepseek-ai/dsh-web-fetch-http`
 * resolves to the same runtime package the Host uses; it is declared in `peerDependencies`
 * for that reason.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { installProxyFromEnvironment, proxyRouteFor } from "@deepseek-ai/dsh-http-proxy";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";

import { detectUpstream } from "./detect.js";
import { createForwarder } from "./forwarder.js";
import { createProxySwitchProvider, WEB_FETCH_PROVIDER_ID } from "./fetch-provider.js";
import {
  appendWarning,
  createProxyOverrideEnvironment,
  failureResult,
  precheckWebFetch,
  webFetchUrlOf,
} from "./host-utils.js";
import { effectiveModeOf, warningFor } from "./messages.js";
import { resolveDirectTarget } from "./net-guard.js";
import { createProbeLoop } from "./probe.js";
import {
  DEFAULT_STATE,
  DEFAULT_UPSTREAM,
  isLoopbackPort,
  loadState,
  maskUpstream,
  parseUpstream,
  saveState,
  MAX_PROBE_INTERVAL_MS,
  MIN_PROBE_INTERVAL_MS,
  MODES,
  SCOPES,
  SCOPE_GLOBAL,
  SCOPE_WEB_FETCH_ONLY,
  UPSTREAM_SOURCES,
} from "./state.js";

export const name = "dsh-proxy-switch";
export const inject = ["tools"];

export {
  appendWarning,
  createProxyOverrideEnvironment,
  failureResult,
  precheckWebFetch,
  webFetchUrlOf,
  WEB_FETCH_PROVIDER_ID,
};

const PLUGIN_VERSION = "0.4.0";
const WEB_PREFIX = "/dsh-proxy-switch";
/** The built-in provider this plugin replaces; the desktop bundle pins it explicitly. */
const ORIGINAL_FETCH_PROVIDER_ID = "http";
const MAX_BODY_BYTES = 8 * 1024;
/** While the upstream stays unreachable, re-run detection at most this often. */
const REDETECT_INTERVAL_MS = 30_000;
/** A fake-IP refusal is stronger evidence, but repeated fetches must not rescan each time. */
const FAKE_IP_REDETECT_INTERVAL_MS = 10_000;
/** An explicit `POST /detect` is still user-triggered work: one scan per two seconds. */
const EXPLICIT_DETECT_COOLDOWN_MS = 2_000;
/** In `auto`, a web_fetch re-probes first when the last probe is older than this. */
const AUTO_FRESHNESS_MS = 1_000;
/** How long one fake-IP refusal keeps the `AUTO_PROXY_NOT_FOUND` warning alive. */
const FAKE_IP_MEMORY_MS = 120_000;
/** The direct-mode precheck shares the request budget instead of waiting on DNS forever. */
const PRECHECK_TIMEOUT_MS = 10_000;
/** Fixed text for a malformed body: a JSON parse message can quote the input (a password). */
const BAD_JSON_MESSAGE = "请求体不是合法 JSON。 The request body is not valid JSON.";
const DISPOSED_MESSAGE = "插件已停用，请求已取消。 The plugin is disposed; the request was cancelled.";
/** Header the UI sends on a mutation; browsers cannot attach it cross-site without a preflight. */
const CLIENT_HEADER = "x-dsh-proxy-switch-request";

/**
 * The newest plugin instance.
 *
 * `apply` may run again while a previous instance is still draining (disable → enable).
 * An old instance's late detection or command must never write state, bind a listener, or
 * install a policy for the instance that replaced it.
 */
let liveInstance = null;

/** Mirrors `dsh-web-fetch-http`'s defaults when the original provider is not registered yet. */
const DEFAULT_FETCH_LIMITS = Object.freeze({
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 30_000,
  maxRedirects: 5,
  userAgent: "deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)",
});

/** cosmokit's cross-copy volatile-ref write protocol; asserting a string needs no snapshot. */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

/**
 * Test/control handles keyed by the plugin context.
 *
 * Cordis treats a plugin's return value as an effect: returning a plain object makes the
 * real Host fail with `TypeError: Invalid effect`. The controls are therefore stored in a
 * WeakMap instead of returned; the host integration test reads them through
 * {@link controlsOf}.
 */
const controlsByContext = new WeakMap();

export function controlsOf(context) {
  return controlsByContext.get(context);
}

function resolveDshHome() {
  const explicit = process.env.DSH_HOME;
  if (explicit !== void 0 && explicit !== "") return explicit;
  return join(homedir(), ".dsh");
}

function loopbackOrigin(port) {
  return `http://127.0.0.1:${port}`;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    // Node quotes a slice of the input in its syntax error; that slice can contain the
    // upstream password, so only a fixed category leaves this function.
    throw new Error(BAD_JSON_MESSAGE);
  }
}

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body, "utf8"),
    "cache-control": "no-store",
  });
  res.end(body);
}

function isLoopbackPeer(req) {
  const address = req.socket?.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Read the upstream URL, falling back to the built-in default when the state is corrupt. */
function upstreamOf(state) {
  const parsed = parseUpstream(state.upstream);
  return parsed.ok ? parsed.url : new URL(DEFAULT_UPSTREAM);
}

function upstreamHasCredentials(state) {
  const parsed = parseUpstream(state.upstream);
  if (!parsed.ok) return false;
  return parsed.url.username !== "" || parsed.url.password !== "";
}

/** Write one value into a cosmokit volatile reference (the documented config-ref protocol). */
function writeConfigRef(ref, value) {
  const write = ref?.[VOLATILE_WRITE];
  if (typeof write !== "function") throw new Error("web.config.fetchProvider is not a volatile reference");
  write.call(ref, value);
}

/**
 * Register one Cordis effect and make an invalid return value name itself.
 *
 * Cordis throws a bare `TypeError: Invalid effect` when an effect callback returns
 * something that is not a function, null/undefined, a thenable, or an iterator. That
 * message says nothing about which registration failed; wrapping the call preserves the
 * label in the plugin-manager diagnostic.
 */
function effectLabeled(context, label, factory) {
  try {
    return context.effect(factory, label);
  } catch (error) {
    throw new Error(`effect "${label}" failed: ${error?.message ?? error}`, { cause: error });
  }
}

export async function apply(ctx, config = {}) {
  // Claim this context as the live instance. A previous instance whose teardown is still
  // draining notices the mismatch on its next async boundary and stops acting.
  const instanceToken = {};
  liveInstance = instanceToken;
  let disposed = false;
  const isLive = () => !disposed && liveInstance === instanceToken;

  const precheckTimeoutMs =
    Number.isFinite(config?.precheckTimeoutMs) && config.precheckTimeoutMs > 0 ? config.precheckTimeoutMs : PRECHECK_TIMEOUT_MS;

  const dshHome = resolveDshHome();
  const loaded = await loadState(dshHome, config ?? {});
  let current = loaded.state;
  const notes = [...loaded.notes];
  if (loaded.loadError !== void 0) notes.push(`state.json 读取失败：${loaded.loadError}`);

  const probeResult = {
    reachable: null,
    latencyMs: null,
    error: null,
    checkedAt: null,
    /** The upstream this result belongs to; a result for another address is discarded. */
    upstream: null,
    /** A real request answered 407: the stored upstream needs a username and password. */
    needsAuth: false,
  };
  const stats = {
    requests: 0,
    failures: 0,
    rejections: 0,
    webFetchRequests: 0,
    globalRequests: 0,
    lastRequestAt: null,
    lastHost: null,
  };
  const policyDiagnostics = [];
  const providerControl = { id: WEB_FETCH_PROVIDER_ID, status: "pending", error: null };
  let listenError = null;
  let policyInstalled = false;
  let policySelfCheck = null;
  let restorePolicy = null;
  let lastError = null;

  const launchEnvironment = launchEnvironmentOf(ctx);
  const detection = { status: "idle", source: null, reader: null, needsAuth: false, checkedAt: null, tried: [] };
  let detectRunning = null;
  let lastDetectAt = 0;
  let lastFakeIpAt = 0;
  let lastExplicitDetectAt = 0;

  /**
   * The route a request takes right now; `auto` follows the probe.
   *
   * A probe result is only trusted for the upstream it was measured against: switching the
   * address must not inherit the old address's "reachable" until the new one is probed.
   */
  const upstreamKey = () => upstreamOf(current).href;
  const freshReachable = () => (probeResult.upstream === upstreamKey() ? probeResult.reachable : null);
  const effectiveMode = () => effectiveModeOf(current.mode, freshReachable());

  const onResult = (entry) => {
    stats.requests += 1;
    stats.lastRequestAt = Date.now();
    stats.lastHost = entry.host ?? null;
    if (entry.engine === "web_fetch") stats.webFetchRequests += 1;
    else stats.globalRequests += 1;
    if (!(entry.status >= 200 && entry.status < 400)) stats.failures += 1;
    if (entry.status === 403 || entry.status === 400) stats.rejections += 1;
    // A real request that reached the upstream and got 407 is stronger evidence than the
    // TCP probe: record that the stored address needs credentials so the UI can say so.
    if (entry.status === 407) probeResult.needsAuth = true;
    else if (entry.status >= 200 && entry.status < 400) probeResult.needsAuth = false;
    ctx.logger?.debug?.("[dsh-proxy-switch] %s/%s %s -> %s", entry.engine, entry.mode, entry.host, entry.status);
  };

  const notifyUpstreamFailure = () => {
    if (!isLive()) return;
    probe.runNow().catch(() => {
      /* the probe loop reports through onUpdate */
    });
  };

  const webFetchForwarder = createForwarder({
    getMode: effectiveMode,
    getUpstream: () => upstreamOf(current),
    engine: "web_fetch",
    isolateConnections: true,
    rejectNonPublicIpLiteral: true,
    onUpstreamFailure: notifyUpstreamFailure,
    logger: ctx.logger,
    onResult,
    ...(config?.resolveTarget !== void 0 ? { resolveTarget: config.resolveTarget } : {}),
  });

  const globalForwarder = createForwarder({
    getMode: effectiveMode,
    getUpstream: () => upstreamOf(current),
    engine: "global",
    isolateConnections: false,
    rejectNonPublicIpLiteral: false,
    onUpstreamFailure: notifyUpstreamFailure,
    logger: ctx.logger,
    onResult,
    ...(config?.resolveTarget !== void 0 ? { resolveTarget: config.resolveTarget } : {}),
  });

  const probe = createProbeLoop({
    getUpstream: () => upstreamOf(current),
    getIntervalMs: () => current.probeIntervalMs,
    ...(config?.probeImpl !== void 0 ? { probeImpl: config.probeImpl } : {}),
    onUpdate(update) {
      // A probe that was already dialling when the plugin stopped must not publish a result.
      if (!isLive()) return;
      probeResult.reachable = update.reachable;
      probeResult.latencyMs = update.latencyMs;
      probeResult.error = update.error;
      probeResult.checkedAt = update.checkedAt;
      probeResult.upstream = update.upstream ?? null;
      if (update.reachable === false) scheduleDetection(REDETECT_INTERVAL_MS);
    },
  });

  const fakeIpSeen = () => current.mode === "auto" && effectiveMode() === "direct" && Date.now() - lastFakeIpAt < FAKE_IP_MEMORY_MS;
  const currentWarning = () =>
    warningFor({ mode: current.mode, scope: current.scope, reachable: freshReachable(), fakeIpSeen: fakeIpSeen() });
  const warningDetails = () => ({
    mode: current.mode === "auto" ? `auto → ${effectiveMode()}` : current.mode,
    scope: current.scope,
    upstream: maskUpstream(current.upstream),
  });

  const snapshot = () => ({
    plugin: name,
    version: PLUGIN_VERSION,
    mode: current.mode,
    effectiveMode: effectiveMode(),
    scope: current.scope,
    listenPort: current.listenPort,
    listening: globalForwarder.port !== null,
    webFetchPort: webFetchForwarder.port,
    webFetchListening: webFetchForwarder.port !== null,
    listenError,
    upstream: maskUpstream(current.upstream),
    upstreamHasCredentials: upstreamHasCredentials(current),
    upstreamSource: current.upstreamSource,
    detection: { ...detection, tried: detection.tried.map((entry) => ({ ...entry, url: maskUpstream(entry.url) })) },
    probeIntervalMs: current.probeIntervalMs,
    policyInstalled,
    policySelfCheck,
    policyDiagnostics,
    provider: { ...providerControl },
    // Expose the reachability that applies to the stored upstream; a result measured
    // against a previous address is not shown as the current one.
    probe: { ...probeResult, reachable: freshReachable() },
    warning: currentWarning(),
    lastSwitchAt: current.lastSwitchAt,
    lastError,
    notes,
    stats: { ...stats },
    pid: process.pid,
  });

  const verifyPolicy = (port) => {
    const expected = loopbackOrigin(port);
    try {
      const route = proxyRouteFor(new URL("https://example.com/"));
      return {
        ok: route.proxied === true && route.proxy === expected,
        expected,
        proxied: route.proxied === true,
        route: route.proxied === true ? route.proxy : "direct",
        checkedAt: Date.now(),
      };
    } catch (error) {
      return { ok: false, expected, proxied: false, route: null, error: String(error?.message ?? error), checkedAt: Date.now() };
    }
  };

  const installPolicy = async (port) => {
    const environment = createProxyOverrideEnvironment(launchEnvironment, loopbackOrigin(port));
    policyDiagnostics.length = 0;
    const restore = await installProxyFromEnvironment(environment, (message) => policyDiagnostics.push(message));
    restorePolicy = restore;
    policyInstalled = true;
    policySelfCheck = verifyPolicy(port);
    if (policySelfCheck.ok !== true) {
      lastError =
        `全局代理策略未生效：proxyRouteFor 未返回本插件监听地址（期望 ${policySelfCheck.expected}，实际 ${policySelfCheck.route ?? "direct"}）。` +
        `这通常意味着 @deepseek-ai/dsh-http-proxy 被解析成了第二份模块副本——检查 package.json 是否把它写在 peerDependencies 而不是 dependencies。`;
      ctx.logger?.error?.("[dsh-proxy-switch] %s", lastError);
    }
  };

  /**
   * Restore the launch policy.
   *
   * `installProxyFromEnvironment` restores the dispatcher, the policy record, and the
   * environment synchronously and only then awaits `agent.close()`. That final await is
   * deliberately NOT awaited here: a settings change can be triggered by a request that is
   * itself in flight on that agent, and `agent.close()` waits for active requests, which
   * would deadlock the request that asked for the change.
   */
  const disposePolicy = async () => {
    const restore = restorePolicy;
    restorePolicy = null;
    policyInstalled = false;
    policySelfCheck = null;
    if (restore === null) return;
    try {
      const pending = restore();
      void Promise.resolve(pending).catch((error) => {
        ctx.logger?.warn?.("[dsh-proxy-switch] closing the previous proxy agent failed: %s", error?.message ?? error);
      });
    } catch (error) {
      ctx.logger?.warn?.("[dsh-proxy-switch] restoring the launch policy failed: %s", error?.message ?? error);
    }
  };

  /** Bind/replace the global channel and install its policy; no-op for web_fetch_only. */
  const applyRuntime = async (state) => {
    if (!isLive()) throw new Error(DISPOSED_MESSAGE);
    if (state.scope === "global") {
      await disposePolicy();
      const bound = await globalForwarder.listen(state.listenPort);
      if (!bound.ok) {
        listenError = bound.error;
        throw new Error(`无法监听 127.0.0.1:${state.listenPort}（${bound.error}）。 Cannot bind 127.0.0.1:${state.listenPort} (${bound.error}).`);
      }
      if (!isLive()) {
        // The plugin was disposed while the listener was binding: release what this call
        // created instead of leaving a channel behind that teardown already ran past.
        await globalForwarder.close().catch(() => {});
        throw new Error(DISPOSED_MESSAGE);
      }
      listenError = null;
      await installPolicy(state.listenPort);
      return;
    }
    await disposePolicy();
    await globalForwarder.close();
    listenError = null;
  };

  const clearErrorIfHealthy = () => {
    if (providerControl.status === "error") return;
    if (current.scope === SCOPE_GLOBAL && !(policyInstalled && policySelfCheck?.ok === true)) return;
    lastError = null;
  };

  /**
   * Resolve a direct-mode precheck target inside one bounded budget (F14).
   *
   * The DNS layer takes no signal, so the budget never cancels the lookup itself; it stops
   * waiting for it and answers with a refusal, which is what the caller needs. `dispose`
   * aborts every in-flight precheck as well. A late answer after abort is discarded because
   * only the first settled verdict is returned.
   */
  const activePrechecks = new Set();
  const resolveForPrecheck = (host) => {
    const controller = new AbortController();
    activePrechecks.add(controller);
    let timer = null;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (verdict) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        activePrechecks.delete(controller);
        resolve(verdict);
      };
      controller.signal.addEventListener(
        "abort",
        () =>
          finish({
            ok: false,
            code: "PROXY_SWITCH_DNS_TIMEOUT",
            message:
              `直连预检解析 ${host} 超时（${precheckTimeoutMs} 毫秒）或已被取消。` +
              ` The direct-mode precheck for ${host} timed out or was cancelled.`,
          }),
        { once: true },
      );
      timer = setTimeout(() => controller.abort(), precheckTimeoutMs);
      timer.unref?.();
      let pending;
      try {
        pending = (config?.resolveTarget ?? resolveDirectTarget)(host, { signal: controller.signal });
      } catch (error) {
        finish({
          ok: false,
          code: "PROXY_SWITCH_DNS_ERROR",
          message: `直连预检无法解析 ${host}：${error?.code ?? "error"}。 Direct-mode precheck could not resolve ${host}.`,
        });
        return;
      }
      Promise.resolve(pending).then(finish, (error) =>
        finish({
          ok: false,
          code: "PROXY_SWITCH_DNS_ERROR",
          message: `直连预检无法解析 ${host}：${error?.code ?? error?.message ?? "error"}。 Direct-mode precheck could not resolve ${host}.`,
        }),
      );
    });
  };

  // 1. The private web_fetch channel always exists; it is independent of the global policy.
  const webFetchBound = await webFetchForwarder.listen(0);
  if (!webFetchBound.ok) {
    lastError = `无法启动 web_fetch 通道（${webFetchBound.error}）。 The web_fetch channel could not bind (${webFetchBound.error}).`;
    ctx.logger?.error?.("[dsh-proxy-switch] %s", lastError);
  }

  // 2. The global takeover only exists in the explicit `global` scope.
  try {
    await applyRuntime(current);
  } catch (error) {
    lastError = String(error?.message ?? error);
    ctx.logger?.error?.("[dsh-proxy-switch] %s", lastError);
  }

  probe.start();

  /**
   * Serialize every state-mutating command. Two concurrent requests previously copied the
   * same old `current`, applied different fields, and the later save overwrote the earlier
   * one while both returned 200. The queue makes each command read the latest committed
   * state inside the critical section.
   */
  let commandQueue = Promise.resolve();
  const enqueue = (task) => {
    const guarded = () => {
      // Checked inside the critical section: a request whose body arrived before the
      // plugin was disposed may still be queued behind another command.
      if (!isLive()) return Promise.reject(new Error(DISPOSED_MESSAGE));
      return task();
    };
    const run = commandQueue.then(guarded, guarded);
    commandQueue = run.catch(() => {});
    return run;
  };

  /**
   * Find the upstream again and adopt it when `upstreamSource` is `auto`.
   *
   * Runs outside the command queue and only enqueues the final write, so a caller that is
   * itself a queued command can trigger it without waiting on itself. One run at a time;
   * a manual upstream is never touched (re-checked inside the queued write too, because
   * the user may switch to manual while detection is in flight).
   */
  function runDetection() {
    if (!isLive()) return Promise.resolve(snapshot());
    if (current.upstreamSource !== "auto") return Promise.resolve(snapshot());
    if (detectRunning !== null) return detectRunning;
    detection.status = "running";
    detectRunning = (async () => {
      try {
        const result = await (config?.detectUpstream ?? detectUpstream)({
          getEnv: (variable) => launchEnvironment?.get?.(variable)?.value ?? process.env[variable],
          excludePorts: [current.listenPort, webFetchForwarder.port, globalForwarder.port],
        });
        // Detection can outlive the plugin (or the instance that started it).
        if (!isLive()) return snapshot();
        lastDetectAt = Date.now();
        detection.tried = result.tried;
        detection.checkedAt = lastDetectAt;
        if (result.found === null) {
          detection.status = "none";
          detection.source = null;
          detection.reader = null;
          detection.needsAuth = false;
          return snapshot();
        }
        detection.status = "found";
        detection.source = result.found.source;
        detection.reader = result.found.reader ?? null;
        detection.needsAuth = result.found.needsAuth === true;
        if (result.found.url !== current.upstream) {
          await enqueue(async () => {
            if (current.upstreamSource !== "auto" || !parseUpstream(result.found.url).ok) return;
            const next = { ...current, upstream: result.found.url };
            await saveState(dshHome, next);
            current = next;
            // The stored reachability belonged to the previous address.
            Object.assign(probeResult, { reachable: null, latencyMs: null, error: null, checkedAt: null, upstream: null });
            ctx.logger?.info?.("[dsh-proxy-switch] upstream detected: %s (%s)", maskUpstream(next.upstream), detection.source);
          });
          if (!isLive()) return snapshot();
        }
        await probe.runNow().catch(() => {});
        return snapshot();
      } catch (error) {
        if (isLive()) {
          detection.status = "none";
          ctx.logger?.warn?.("[dsh-proxy-switch] upstream detection failed: %s", error?.message ?? error);
        }
        return snapshot();
      } finally {
        detectRunning = null;
      }
    })();
    return detectRunning;
  }

  /** Fire-and-forget detection, skipped when the last run is newer than `minIntervalMs`. */
  function scheduleDetection(minIntervalMs = 0) {
    if (!isLive()) return;
    if (Date.now() - lastDetectAt < minIntervalMs) return;
    void runDetection().catch(() => {});
  }

  const setMode = async (mode) => {
    const result = await enqueue(async () => {
      if (!MODES.includes(mode)) {
        throw new Error(`mode must be one of ${MODES.join(", ")}, received ${JSON.stringify(mode)}`);
      }
      // Persist first: if the disk write fails, keep the in-memory state on the old mode
      // instead of reporting a switch the next restart will not see.
      const next = { ...current, mode, lastSwitchAt: Date.now() };
      await saveState(dshHome, next);
      current = next;
      clearErrorIfHealthy();
      ctx.logger?.info?.("[dsh-proxy-switch] mode -> %s (scope %s)", mode, current.scope);
      return snapshot();
    });
    // A switch is the moment the user cares whether the proxy is where we think it is.
    scheduleDetection();
    return result;
  };

  const updateSettings = async (patch) => {
    const result = await enqueue(async () => {
      const next = { ...current };
      if (patch.scope !== void 0) {
        if (!SCOPES.includes(patch.scope)) {
          throw new Error(`scope 必须是 ${SCOPES.join(" 或 ")}，收到 ${JSON.stringify(patch.scope)}。 scope must be ${SCOPES.join(" or ")}.`);
        }
        next.scope = patch.scope;
      }
      if (patch.upstream !== void 0) {
        const parsed = parseUpstream(patch.upstream);
        if (!parsed.ok) throw new Error(parsed.error);
        next.upstream = String(patch.upstream).trim();
        // A typed address is a decision: detection must not overwrite it.
        next.upstreamSource = "manual";
      }
      if (patch.upstreamSource !== void 0) {
        if (!UPSTREAM_SOURCES.includes(patch.upstreamSource)) {
          throw new Error(`upstreamSource must be one of ${UPSTREAM_SOURCES.join(", ")}, received ${JSON.stringify(patch.upstreamSource)}`);
        }
        next.upstreamSource = patch.upstreamSource;
      }
      if (patch.probeIntervalMs !== void 0) {
        const interval = Number(patch.probeIntervalMs);
        if (!Number.isFinite(interval) || interval < MIN_PROBE_INTERVAL_MS || interval > MAX_PROBE_INTERVAL_MS) {
          throw new Error(`探测间隔必须在 ${MIN_PROBE_INTERVAL_MS}–${MAX_PROBE_INTERVAL_MS} 毫秒之间。 probeIntervalMs must be ${MIN_PROBE_INTERVAL_MS}–${MAX_PROBE_INTERVAL_MS}.`);
        }
        next.probeIntervalMs = Math.round(interval);
      }
      if (patch.listenPort !== void 0) {
        const port = Number(patch.listenPort);
        if (!isLoopbackPort(port)) throw new Error("监听端口必须是 1024–65535 之间的整数。 listenPort must be an integer within 1024–65535.");
        next.listenPort = port;
      }

      const scopeChanged = next.scope !== current.scope;
      const runtimeChanged = scopeChanged || next.listenPort !== current.listenPort;

      if (runtimeChanged) {
        try {
          await applyRuntime(next);
        } catch (error) {
          await applyRuntime(current).catch((rollbackError) => {
            lastError = `${lastError ?? ""} 回滚也失败：${rollbackError?.message ?? rollbackError}`;
          });
          throw error;
        }
      }

      try {
        await saveState(dshHome, next);
      } catch (error) {
        if (runtimeChanged) {
          await applyRuntime(current).catch((rollbackError) => {
            lastError = `state.json 写入失败，且回滚失败：${rollbackError?.message ?? rollbackError}`;
          });
        }
        throw error;
      }

      current = next;
      if (patch.upstream !== void 0) {
        // Do not let the previous address's probe answer for the new one; the probe below
        // reports the new address's own result.
        Object.assign(probeResult, { reachable: null, latencyMs: null, error: null, checkedAt: null, upstream: null, needsAuth: false });
      }
      if (patch.probeIntervalMs !== void 0) probe.reschedule();
      if (patch.upstream !== void 0) {
        probe.runNow().catch(() => {
          /* the probe loop reports through onUpdate */
        });
      }
      clearErrorIfHealthy();
      return snapshot();
    });
    if (patch.upstreamSource === "auto") scheduleDetection();
    return result;
  };

  // Detection runs in the background: the probe already watches the stored upstream, and
  // a found address replaces it within a couple of seconds.
  scheduleDetection();

  // 3. Swap the web_fetch provider without touching any other module's transport.
  ctx.inject(["web"], async (webCtx) => {
    const webService = webCtx.web;
    const ref = webService.config?.fetchProvider;
    const configured = (ref?.get?.() ?? process.env.DSH_WEB_FETCH_PROVIDER) || void 0;
    // The desktop bundle pins `fetchProvider: "http"`. Overriding that built-in provider is
    // the plugin's purpose; a different explicit provider id is respected instead.
    if (configured !== void 0 && configured !== WEB_FETCH_PROVIDER_ID && configured !== ORIGINAL_FETCH_PROVIDER_ID) {
      providerControl.status = "blocked";
      providerControl.error =
        `web_fetch provider 已被显式配置为 "${configured}"，插件不覆盖。` +
        ` The web_fetch provider is explicitly configured as "${configured}"; this plugin will not override it.`;
      lastError = providerControl.error;
      ctx.logger?.warn?.("[dsh-proxy-switch] %s", providerControl.error);
      return;
    }
    if (webService.fetchProviders.has(WEB_FETCH_PROVIDER_ID)) {
      providerControl.status = "error";
      providerControl.error = `provider "${WEB_FETCH_PROVIDER_ID}" 已注册；插件无法重复接管。 A provider with this id is already registered.`;
      lastError = providerControl.error;
      ctx.logger?.error?.("[dsh-proxy-switch] %s", providerControl.error);
      return;
    }
    const limits = webService.fetchProviders.get("http")?.limits ?? DEFAULT_FETCH_LIMITS;
    let Base;
    try {
      ({ HttpFetchProvider: Base } = await import("@deepseek-ai/dsh-web-fetch-http"));
    } catch (error) {
      providerControl.status = "error";
      providerControl.error = `无法加载 @deepseek-ai/dsh-web-fetch-http：${error?.message ?? error}`;
      lastError = providerControl.error;
      ctx.logger?.error?.("[dsh-proxy-switch] %s", providerControl.error);
      return;
    }
    const Provider = createProxySwitchProvider(Base);
    const provider = new Provider(limits, {
      getPort: () => webFetchForwarder.port,
      tlsOptions: config?.tlsOptions,
    });
    const previous = ref?.get?.();

    effectLabeled(webCtx, "dsh-proxy-switch: web_fetch provider", () => {
      let disposeProvider = null;
      try {
        disposeProvider = webService.registerFetchProvider(provider);
        writeConfigRef(ref, WEB_FETCH_PROVIDER_ID);
        providerControl.status = "active";
        providerControl.error = null;
      } catch (error) {
        providerControl.status = "error";
        providerControl.error = `无法接管 web_fetch provider：${error?.message ?? error}`;
        lastError = providerControl.error;
        ctx.logger?.error?.("[dsh-proxy-switch] %s", providerControl.error);
        try {
          disposeProvider?.();
        } catch {
          /* nothing was registered */
        }
        return () => {};
      }
      return () => {
        providerControl.status = "disposed";
        try {
          writeConfigRef(ref, previous);
        } catch (error) {
          ctx.logger?.warn?.("[dsh-proxy-switch] restoring fetchProvider failed: %s", error?.message ?? error);
        }
        try {
          disposeProvider?.();
        } catch (error) {
          ctx.logger?.warn?.("[dsh-proxy-switch] unregistering the web_fetch provider failed: %s", error?.message ?? error);
        }
      };
    });
  });

  // 4. Expose the state machine to the sidebar over the Web carrier.
  ctx.inject(["webServer"], (webCtx) => {
    const webServer = webCtx.webServer;
    const guard = (req) => {
      if (!isLoopbackPeer(req)) return { ok: false, status: 403, error: "loopback only" };
      if (!isLive()) return { ok: false, status: 503, error: DISPOSED_MESSAGE };
      const origin = webServer.getOrigin();
      let expectedHost = "";
      try {
        expectedHost = new URL(origin).host.toLowerCase();
      } catch {
        return { ok: false, status: 503, error: "the web server origin is unavailable" };
      }
      // A DNS-rebinding page keeps its own name in `Host` while the socket reaches
      // loopback; requiring the Host this server actually serves closes that path even
      // for a same-origin GET without `Origin`.
      const host = String(req.headers.host ?? "").toLowerCase();
      if (expectedHost === "" || host !== expectedHost) return { ok: false, status: 403, error: "host mismatch" };
      const site = req.headers["sec-fetch-site"];
      if (typeof site === "string" && site !== "same-origin" && site !== "none") {
        return { ok: false, status: 403, error: "cross-site request refused" };
      }
      const sent = req.headers.origin;
      if (sent !== void 0 && sent !== origin) return { ok: false, status: 403, error: "cross-origin request refused" };
      // A browser cannot attach a custom header to a cross-site request without a CORS
      // preflight, which this route never grants; a local non-browser client can, and is
      // the same user (the loopback boundary).
      if (req.method !== "GET" && req.method !== "HEAD" && req.headers[CLIENT_HEADER] !== "1") {
        return { ok: false, status: 403, error: "missing client header" };
      }
      return { ok: true, origin };
    };

    const handler = async (req, res) => {
      const checked = guard(req);
      if (!checked.ok) {
        sendJson(res, checked.status, { ok: false, error: checked.error });
        return;
      }
      try {
        const pathname = new URL(req.url, checked.origin).pathname;
        if (req.method === "GET" && (pathname === `${WEB_PREFIX}/state` || pathname === `${WEB_PREFIX}/state/`)) {
          sendJson(res, 200, snapshot());
          return;
        }
        if (req.method === "POST" && pathname === `${WEB_PREFIX}/mode`) {
          if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
            sendJson(res, 415, { ok: false, error: "application/json required" });
            return;
          }
          const body = await readJsonBody(req);
          if (!isLive()) {
            sendJson(res, 503, { ok: false, error: DISPOSED_MESSAGE });
            return;
          }
          sendJson(res, 200, { ok: true, state: await setMode(body?.mode) });
          return;
        }
        if (req.method === "POST" && pathname === `${WEB_PREFIX}/settings`) {
          if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
            sendJson(res, 415, { ok: false, error: "application/json required" });
            return;
          }
          const body = await readJsonBody(req);
          if (!isLive()) {
            sendJson(res, 503, { ok: false, error: DISPOSED_MESSAGE });
            return;
          }
          sendJson(res, 200, { ok: true, state: await updateSettings(body ?? {}) });
          return;
        }
        if (req.method === "POST" && pathname === `${WEB_PREFIX}/probe`) {
          await probe.runNow();
          sendJson(res, 200, { ok: true, state: snapshot() });
          return;
        }
        if (req.method === "POST" && pathname === `${WEB_PREFIX}/detect`) {
          // A5: an explicit detection is a full scan; a burst of requests must not start one
          // each. The cooldown is deliberately separate from the automatic re-detect limits.
          const now = Date.now();
          if (now - lastExplicitDetectAt < EXPLICIT_DETECT_COOLDOWN_MS) {
            sendJson(res, 429, { ok: false, error: "detection is rate limited; retry shortly" });
            return;
          }
          lastExplicitDetectAt = now;
          await runDetection();
          sendJson(res, 200, { ok: true, state: snapshot() });
          return;
        }
        sendJson(res, 404, { ok: false, error: "not found" });
      } catch (error) {
        lastError = String(error?.message ?? error);
        sendJson(res, 400, { ok: false, error: lastError });
      }
    };

    effectLabeled(
      webCtx,
      "dsh-proxy-switch: state route",
      () => webServer.register({ kind: "prefix", path: WEB_PREFIX, handler }),
    );
  });

  // 4. Give the model a readable refusal/warning around the provider result.
  effectLabeled(
    ctx,
    "dsh-proxy-switch: web_fetch warning",
    () =>
      ctx.on("tools/execute", async (exec, next) => {
        const isFetch = exec?.name === "web_fetch" || String(exec?.name ?? "").endsWith(".web_fetch");
        if (!isFetch) return next();
        // If the provider is not ours, the plugin does not control this call; do not
        // attribute our mode/warning text to a request that uses a different transport.
        if (providerControl.status !== "active") return next();
        const url = webFetchUrlOf(exec.arguments);
        // `auto` decides per request from the probe; a stale probe could still say
        // "forward" a few seconds after the proxy client quit. A loopback TCP connect is
        // cheap, so refresh it first.
        if (current.mode === "auto" && (probeResult.checkedAt === null || Date.now() - probeResult.checkedAt > AUTO_FRESHNESS_MS)) {
          await probe.runNow().catch(() => {});
        }
        const route = effectiveMode();
        if (route === "direct") {
          const check = await precheckWebFetch({ mode: route, url, resolve: resolveForPrecheck });
          if (check.action === "refuse") {
            stats.rejections += 1;
            if (check.code === "PROXY_SWITCH_FAKE_IP" && current.mode === "auto") {
              // A fake-IP answer proves a TUN client is running; look for its port again.
              lastFakeIpAt = Date.now();
              scheduleDetection(FAKE_IP_REDETECT_INTERVAL_MS);
            }
            const refusal = failureResult(check.message, check.code);
            const refusalWarning = currentWarning();
            return refusalWarning === null
              ? refusal
              : appendWarning(refusal, refusalWarning, warningDetails());
          }
        }
        const result = await next();
        const warning = currentWarning();
        if (warning === null) return result;
        return appendWarning(result, warning, warningDetails());
      }),
  );

  // 5. Return the process to the launch policy when this plugin is disposed.
  effectLabeled(
    ctx,
    "dsh-proxy-switch: teardown",
    () => async () => {
      // Order matters: mark the instance dead first, so anything that was waiting on an
      // async boundary (a paused request body, a detection run, a DNS precheck) can no
      // longer bind a listener, install a policy, or write state.
      disposed = true;
      if (liveInstance === instanceToken) liveInstance = null;
      for (const controller of activePrechecks) controller.abort();
      activePrechecks.clear();
      probe.stop();
      try {
        await disposePolicy();
      } finally {
        await Promise.allSettled([globalForwarder.close(), webFetchForwarder.close()]);
      }
    },
  );

  // A programmatic control surface for host-level tests and future integrations. It is
  // stored outside the plugin return value: Cordis interprets a returned plain object as
  // an effect and fails activation with `TypeError: Invalid effect`.
  const controls = { setMode, updateSettings, snapshot, probeNow: () => probe.runNow(), detectNow: runDetection };
  controlsByContext.set(ctx, controls);

  ctx.logger?.info?.(
    "[dsh-proxy-switch] ready: mode=%s scope=%s listen=%s web_fetch=%s upstream=%s provider=%s",
    current.mode,
    current.scope,
    globalForwarder.port ?? "(not bound)",
    webFetchForwarder.port ?? "(not bound)",
    maskUpstream(current.upstream),
    providerControl.status,
  );
}

/** Exported for tests and for a future settings UI that needs the canonical defaults. */
export { DEFAULT_STATE, SCOPE_GLOBAL, SCOPE_WEB_FETCH_ONLY };
