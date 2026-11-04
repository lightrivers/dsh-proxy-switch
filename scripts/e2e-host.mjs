/**
 * Host-level integration check for `dsh-proxy-switch` v0.3.
 *
 * This runs the real Host half inside a real Cordis `Context`, with the real
 * `@deepseek-ai/dsh-web` registry, the real `dsh-web-fetch-http` provider, and the real
 * `@deepseek-ai/dsh-http-proxy` policy package. It is still not the Electron app; see
 * README §11 for that boundary.
 *
 * Coverage:
 *  - default web_fetch_only: provider takeover, no global policy/env change, forward,
 *    direct, fake-IP refusal, teardown restore;
 *  - R1: a warm HTTPS tunnel from the `http` provider must not be reused by a later
 *    direct web_fetch;
 *  - R3: a child `curl` with an original proxy + NO_PROXY keeps its bypass;
 *  - R6: concurrent mode/scope and listenPort/upstream updates both survive;
 *  - R7: a corrupt state file never echoes its credential;
 *  - R8: an IPv6 loopback upstream is probed and used;
 *  - F (v0.4): auto mode follows the probe, detection adopts an upstream, a typed upstream
 *    is never overwritten, and a fake-IP refusal in auto names the missing port.
 *
 * Usage:
 *   DSH_RUNTIME_MODULES=/path/to/runtime/dsh/node_modules node scripts/e2e-host.mjs
 *
 * The runtime package closure must contain `@deepseek-ai/cordis`, `dsh-web`,
 * `dsh-web-fetch-http`, `dsh-http-proxy`, `dsh-launch-environment`, `undici`,
 * `ipaddr.js`, and their dependencies. Without `DSH_RUNTIME_MODULES` the script skips.
 *
 * The R1 TLS check deliberately disables certificate verification **in this test process
 * only** (`NODE_TLS_REJECT_UNAUTHORIZED=0`); the certificate is generated locally.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer as createNetServer } from "node:net";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);
const RUNTIME = process.env.DSH_RUNTIME_MODULES ?? "";

let failures = 0;
function check(label, condition, detail = "") {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

function start(server, host = "127.0.0.1") {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

function stop(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function freePort() {
  const server = createHttpServer();
  const port = await start(server);
  await stop(server);
  return port;
}

function basicEnv(values) {
  return {
    get(name) {
      return values[name] !== void 0 ? { value: values[name], source: "test" } : void 0;
    },
    getFrom(name, sources) {
      return sources.includes("process") ? values[name] : void 0;
    },
  };
}

/** A fake upstream HTTP proxy; CONNECT tunnels are bridged to `bridgePort`. */
function createUpstream(bridgePort = null) {
  const seen = [];
  const server = createHttpServer((request, response) => {
    seen.push({ kind: "http", url: request.url });
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`UPSTREAM:${request.url}`);
  });
  server.on("connect", (request, socket) => {
    seen.push({ kind: "connect", authority: request.url });
    if (bridgePort === null) {
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.destroy();
      return;
    }
    const target = connect({ host: "127.0.0.1", port: bridgePort });
    target.on("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.pipe(target);
      target.pipe(socket);
    });
    target.on("error", () => socket.destroy());
    socket.on("error", () => target.destroy());
  });
  return { server, seen };
}

function httpTarget(body) {
  return createHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`${body}:${request.url}`);
  });
}

function httpsTarget(cert, key, body) {
  return createHttpsServer({ cert, key }, (request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`${body}:${request.url}`);
  });
}

function wait(ms = 80) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createRuntime() {
  const { Context } = await import(pathToFileURL(join(RUNTIME, "@deepseek-ai/cordis/lib/index.js")).href);
  const WebRuntime = (await import(pathToFileURL(join(RUNTIME, "@deepseek-ai/dsh-web/lib/index.js")).href)).default;
  const { apply: webFetchApply, Config } = await import(
    pathToFileURL(join(RUNTIME, "@deepseek-ai/dsh-web-fetch-http/lib/index.js")).href
  );
  const { installProxyFromEnvironment } = await import(
    pathToFileURL(join(RUNTIME, "@deepseek-ai/dsh-http-proxy/lib/index.js")).href
  );
  return { Context, WebRuntime, webFetchApply, Config, installProxyFromEnvironment };
}

async function makePluginCopy() {
  const root = await mkdtemp(join(tmpdir(), "dsh-proxy-switch-host-"));
  const pluginDir = join(root, "plugin");
  await cp(join(PLUGIN_DIR, "lib"), join(pluginDir, "lib"), { recursive: true });
  await cp(join(PLUGIN_DIR, "package.json"), join(pluginDir, "package.json"));
  await mkdir(join(pluginDir, "node_modules", "@deepseek-ai"), { recursive: true });
  for (const name of ["dsh-http-proxy", "dsh-launch-environment", "dsh-web", "dsh-web-fetch-http"]) {
    await symlink(join(RUNTIME, "@deepseek-ai", name), join(pluginDir, "node_modules", "@deepseek-ai", name), "dir");
  }
  return { root, pluginDir };
}

/**
 * Build a real Cordis context with the real web registry and `http` provider. The
 * plugin is loaded as a child fiber so its effects can be disposed independently.
 */
async function createContext(runtime, pluginModule, config, options = {}) {
  const { Context, WebRuntime, webFetchApply, Config } = runtime;
  const ctx = new Context();
  const launchEnvironment = options.launchEnvironment ?? basicEnv({});
  ctx.provide("launchEnvironment", launchEnvironment);
  const state = { handler: null };
  const webServer = {
    getOrigin: () => options.origin ?? "http://127.0.0.1:1",
    register: ({ handler }) => {
      state.handler = handler;
      return () => {
        state.handler = null;
      };
    },
  };
  ctx.provide("webServer", webServer);
  ctx.plugin(WebRuntime, {});
  await wait(30);
  webFetchApply(ctx, Config({}));
  if (options.initialFetchProvider !== void 0) {
    // The desktop bundle pins `fetchProvider: "http"`; the plugin must override that
    // built-in provider while still respecting a different explicit provider id.
    ctx.web.config.fetchProvider[Symbol.for("cosmokit.volatile.write")](options.initialFetchProvider);
  }

  let controls = null;
  const capture = {
    name: "dsh-proxy-switch-test",
    apply: async (child, cfg) => {
      await pluginModule.apply(child, cfg);
      controls = pluginModule.controlsOf(child);
    },
  };
  const fiber = ctx.plugin(capture, config);
  await wait(options.waitMs ?? 120);
  assert.ok(controls, "the plugin apply must return controls");
  return { ctx, fiber, controls, state };
}

async function main() {
  if (RUNTIME === "") {
    console.log("SKIP  set DSH_RUNTIME_MODULES to the DSH runtime package directory.");
    process.exit(0);
  }
  try {
    await stat(join(RUNTIME, "@deepseek-ai/cordis/lib/index.js"));
    await stat(join(RUNTIME, "@deepseek-ai/dsh-web-fetch-http/lib/index.js"));
  } catch {
    console.log(`SKIP  runtime closure not found at ${RUNTIME}; set DSH_RUNTIME_MODULES.`);
    process.exit(0);
  }

  const runtime = await createRuntime();
  const { root, pluginDir } = await makePluginCopy();
  process.env.DSH_HOME = join(root, "home-a");
  const pluginModule = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);

  // ---------- Phase A: default web_fetch_only ----------
  {
    const upstream = createUpstream();
    const upstreamPort = await start(upstream.server);
    const target = httpTarget("TARGET");
    const targetPort = await start(target);
    const listenPort = await freePort();
    const beforeEnv = { http: process.env.http_proxy, no: process.env.no_proxy };
    const { ctx, fiber, controls } = await createContext(runtime, pluginModule, {
      mode: "forward",
      scope: "web_fetch_only",
      listenPort,
      upstream: `http://127.0.0.1:${upstreamPort}`,
      probeIntervalMs: 3000,
      resolveTarget: async (host) =>
        host === "198.18.0.5"
          ? { ok: false, code: "PROXY_SWITCH_FAKE_IP", message: "直连模式拒绝 fake-IP 198.18.0.5。 Direct mode refused fake-IP 198.18.0.5." }
          : { ok: true, address: "127.0.0.1", addresses: [{ address: "127.0.0.1", family: 4 }] },
    }, { initialFetchProvider: "http" });
    let current = controls.snapshot();
    check("A provider active", current.provider.status === "active", JSON.stringify(current.provider));
    check("A overrides the bundle's http default", ctx.web.config.fetchProvider.get() === "dsh-proxy-switch");
    check("A no global policy in web_fetch_only", current.policyInstalled === false && current.listening === false);
    check("A private web_fetch channel bound", Number.isInteger(current.webFetchPort), String(current.webFetchPort));
    check("A fetchProvider points at the plugin", ctx.web.config.fetchProvider.get() === "dsh-proxy-switch");
    check("A process proxy env untouched", process.env.http_proxy === beforeEnv.http && process.env.no_proxy === beforeEnv.no);

    const forwarded = await ctx.web.fetch({ url: `http://8.8.8.8:${targetPort}/fwd` });
    check("A forward: web_fetch reaches the upstream", forwarded.statusCode === 200 && /UPSTREAM:/.test(forwarded.body.content));
    check("A forward: upstream saw the absolute URI", upstream.seen.some((entry) => entry.url === `http://8.8.8.8:${targetPort}/fwd`));

    await controls.setMode("direct");
    const hitsBefore = upstream.seen.length;
    const direct = await ctx.web.fetch({ url: `http://8.8.8.8:${targetPort}/direct` });
    check("A direct: web_fetch reaches the target", direct.statusCode === 200 && /TARGET:/.test(direct.body.content));
    check("A direct: upstream was not used", upstream.seen.length === hitsBefore);

    const refused = await ctx.waterfall(
      "tools/execute",
      { name: "web_fetch", arguments: { url: "http://198.18.0.5/" } },
      async () => ({ content: [{ type: "text", text: "NEXT" }] }),
    );
    check("A direct: fake-IP is refused with a code", refused.isError === true && refused.error?.info?.code === "PROXY_SWITCH_FAKE_IP");
    check("A direct: refusal carries the warning block", refused.content.length === 2 && /\[dsh-proxy-switch\]/.test(refused.content[1].text));

    for (const url of ["http://198.18.0.5/", "https://198.18.0.5/"]) {
      try {
        await ctx.web.fetch({ url });
        check(`A provider maps ${url.startsWith("https") ? "CONNECT" : "HTTP"} refusal`, false, "expected a WebError");
      } catch (error) {
        check(
          `A provider maps ${url.startsWith("https") ? "CONNECT" : "HTTP"} refusal`,
          error?.code === "PROXY_SWITCH_FAKE_IP" && /fake-IP/.test(String(error?.message)),
          `${error?.code}: ${String(error?.message).slice(0, 50)}`,
        );
      }
    }

    const plain = await fetch(`http://127.0.0.1:${targetPort}/plain`);
    check("A other modules are not routed by the plugin", plain.status === 200 && /TARGET:\/plain/.test(await plain.text()));
    check("A proxyRouteFor for an arbitrary URL stays direct", (await import(pathToFileURL(join(RUNTIME, "@deepseek-ai/dsh-http-proxy/lib/index.js")).href)).proxyRouteFor(new URL("https://example.com/")).proxied === false);

    await fiber.dispose();
    await wait(60);
    check("A teardown restores fetchProvider", ctx.web.config.fetchProvider.get() === "http");
    check("A teardown unregisters the provider", !ctx.web.fetchProviders.has("dsh-proxy-switch"));
    await stop(target);
    await stop(upstream.server);
  }

  // ---------- Phase P: proxy-client transport hardening (F6/F7) ----------
  {
    const { requestThroughLocalProxy } = await import(pathToFileURL(join(pluginDir, "lib", "proxy-client.js")).href);

    /** A raw loopback "forwarder": hand every connection to `onSocket`, track live ones. */
    async function startRawForwarder(onSocket) {
      const live = new Set();
      const server = createNetServer((socket) => {
        live.add(socket);
        socket.on("close", () => live.delete(socket));
        socket.on("error", () => {});
        onSocket(socket);
      });
      const port = await start(server);
      return {
        port,
        live,
        stop: async () => {
          for (const socket of live) socket.destroy();
          await stop(server);
        },
      };
    }
    const rejectionOf = (promise) =>
      promise.then(
        (value) => ({ rejected: false, value }),
        (error) => ({ rejected: true, error }),
      );
    async function waitFor(predicate, timeoutMs = 1_500) {
      const startedAt = Date.now();
      while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) return false;
        await wait(20);
      }
      return true;
    }

    // F6: a status outside the Web `Response` range must become a structured WebError.
    const badStatus = await startRawForwarder((socket) => {
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString("latin1");
        if (!buffered.includes("\r\n\r\n")) return;
        socket.end("HTTP/1.1 600 Unexpected\r\nContent-Length: 2\r\nConnection: close\r\n\r\nno");
      });
    });
    const overRange = await rejectionOf(
      requestThroughLocalProxy({ url: new URL("http://8.8.8.8/x"), headers: {}, proxyPort: badStatus.port }),
    );
    check(
      "F6 an out-of-range HTTP status becomes a structured error",
      overRange.rejected && overRange.error?.code === "PROXY_SWITCH_UPSTREAM_BAD_RESPONSE" && overRange.error?.name === "WebError",
      overRange.rejected ? `${overRange.error?.name}: ${overRange.error?.code}` : "resolved",
    );
    check("F6 the callback did not throw into the host process", true);
    await waitFor(() => badStatus.live.size === 0);
    check("F6 the upstream socket is closed after the refusal", badStatus.live.size === 0, String(badStatus.live.size));
    await badStatus.stop();

    // A CONNECT that succeeds but never speaks TLS: abort and deadline must both work.
    const tlsHang = await startRawForwarder((socket) => {
      let buffered = "";
      let replied = false;
      socket.on("data", (chunk) => {
        buffered += chunk.toString("latin1");
        if (replied || !buffered.includes("\r\n\r\n")) return;
        replied = true;
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      });
    });
    const httpsInput = (extra) => ({
      url: new URL("https://8.8.8.8/x"),
      headers: {},
      proxyPort: tlsHang.port,
      ...extra,
    });

    const abortController = new AbortController();
    const abortStartedAt = Date.now();
    const abortPending = rejectionOf(requestThroughLocalProxy(httpsInput({ signal: abortController.signal })));
    setTimeout(() => abortController.abort(), 80);
    const aborted = await abortPending;
    check(
      "F7 abort during the TLS handshake rejects promptly",
      aborted.rejected && aborted.error?.code === "WEB_ABORTED" && Date.now() - abortStartedAt < 1_500,
      aborted.rejected ? `${aborted.error?.code} after ${Date.now() - abortStartedAt}ms` : "resolved",
    );
    await waitFor(() => tlsHang.live.size === 0);
    check("F7 abort closes both sockets", tlsHang.live.size === 0, String(tlsHang.live.size));

    const deadlineController = new AbortController();
    const deadlineStartedAt = Date.now();
    const deadlinePending = rejectionOf(requestThroughLocalProxy(httpsInput({ signal: deadlineController.signal })));
    setTimeout(() => deadlineController.abort({ name: "TimeoutReason", code: "WEB_FETCH_TIMEOUT" }), 80);
    const deadlined = await deadlinePending;
    check(
      "F7 a deadline during the TLS handshake maps to WEB_FETCH_TIMEOUT",
      deadlined.rejected && deadlined.error?.code === "WEB_FETCH_TIMEOUT" && Date.now() - deadlineStartedAt < 1_500,
      deadlined.rejected ? `${deadlined.error?.code} after ${Date.now() - deadlineStartedAt}ms` : "resolved",
    );

    const preAborted = new AbortController();
    preAborted.abort();
    const preAbortedResult = await rejectionOf(requestThroughLocalProxy(httpsInput({ signal: preAborted.signal })));
    check(
      "F7 an already-aborted signal rejects before dialing",
      preAbortedResult.rejected && preAbortedResult.error?.code === "WEB_ABORTED",
      preAbortedResult.rejected ? String(preAbortedResult.error?.code) : "resolved",
    );

    const handshakeStartedAt = Date.now();
    const handshakeTimeout = await rejectionOf(requestThroughLocalProxy(httpsInput({ tlsHandshakeTimeoutMs: 150 })));
    check(
      "F7 a silent TLS handshake times out on its own budget",
      handshakeTimeout.rejected &&
        handshakeTimeout.error?.code === "PROXY_SWITCH_UPSTREAM_TIMEOUT" &&
        Date.now() - handshakeStartedAt < 2_000,
      handshakeTimeout.rejected ? `${handshakeTimeout.error?.code} after ${Date.now() - handshakeStartedAt}ms` : "resolved",
    );
    await waitFor(() => tlsHang.live.size === 0);
    check("F7 the timeout closes the silent socket", tlsHang.live.size === 0, String(tlsHang.live.size));
    await tlsHang.stop();

    // Sanity: a normal 200 response still converts and streams.
    const healthy = await startRawForwarder((socket) => {
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString("latin1");
        if (!buffered.includes("\r\n\r\n")) return;
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
      });
    });
    const good = await requestThroughLocalProxy({ url: new URL("http://8.8.8.8/ok"), headers: {}, proxyPort: healthy.port });
    check("P a normal HTTP response still streams", (await good.response.text()) === "ok");
    await good.close();
    await healthy.stop();
  }

  // ---------- Phase B: R1 warm HTTPS tunnel ----------
  {
    const certDir = join(root, "cert");
    await mkdir(certDir, { recursive: true });
    const keyPath = join(certDir, "key.pem");
    const certPath = join(certDir, "cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "2",
      "-subj", "/CN=8.8.8.8", "-addext", "subjectAltName=IP:8.8.8.8",
    ], { stdio: "ignore" });
    const cert = await readFile(certPath);
    const key = await readFile(keyPath);
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    const directTls = httpsTarget(cert, key, "DIRECT-ORIGIN");
    const directTlsPort = await start(directTls);
    const upstreamTls = httpsTarget(cert, key, "UPSTREAM-ORIGIN");
    const upstreamTlsPort = await start(upstreamTls);
    const upstream = createUpstream(upstreamTlsPort);
    const upstreamPort = await start(upstream.server);

    const listenPort = await freePort();
    process.env.DSH_HOME = join(root, "home-b");
    const { ctx, fiber, controls } = await createContext(runtime, pluginModule, {
      mode: "direct",
      scope: "web_fetch_only",
      listenPort,
      upstream: `http://127.0.0.1:${upstreamPort}`,
      probeIntervalMs: 3000,
      tlsOptions: { ca: cert, rejectUnauthorized: true },
      resolveTarget: async () => ({ ok: true, address: "127.0.0.1", addresses: [{ address: "127.0.0.1", family: 4 }] }),
    }, { launchEnvironment: basicEnv({}), initialFetchProvider: "http" });

    // Establish an external global policy, exactly like a user's original `.env`, and
    // warm the shared `http` provider's HTTPS tunnel.
    const restorePolicy = await runtime.installProxyFromEnvironment(
      basicEnv({ http_proxy: `http://127.0.0.1:${upstreamPort}`, https_proxy: `http://127.0.0.1:${upstreamPort}` }),
      () => {},
    );
    // Warm the ORIGINAL `http` provider's shared pool. The plugin has already taken over
    // the default selection; point it back to `http` for this one request, then restore.
    const volatileWrite = Symbol.for("cosmokit.volatile.write");
    ctx.web.config.fetchProvider[volatileWrite]("http");
    const warm = await ctx.web.fetch({ url: `https://8.8.8.8:${directTlsPort}/warm` });
    ctx.web.config.fetchProvider[volatileWrite]("dsh-proxy-switch");
    check("B warm-up uses the shared upstream tunnel", warm.statusCode === 200 && /UPSTREAM-ORIGIN:\/warm/.test(warm.body.content));
    const connectsBefore = upstream.seen.filter((entry) => entry.kind === "connect").length;

    // The plugin's own apply already happened above; ensure the provider took over before
    // the R1 call. (It is configured to direct + web_fetch_only.)
    check("B provider active before R1", controls.snapshot().provider.status === "active");
    const r1 = await ctx.web.fetch({ url: `https://8.8.8.8:${directTlsPort}/r1` });
    const connectsAfter = upstream.seen.filter((entry) => entry.kind === "connect").length;
    check("B R1: the new web_fetch uses the direct origin", r1.statusCode === 200 && /DIRECT-ORIGIN:\/r1/.test(r1.body.content));
    check("B R1: it does not borrow the warm upstream tunnel", connectsAfter === connectsBefore, `${connectsBefore} -> ${connectsAfter}`);
    check("B R1: the private channel counted the request", controls.snapshot().stats.webFetchRequests >= 1);

    // The original provider's warm tunnel must still be intact: the switch must not have
    // closed or re-routed another module's connection.
    ctx.web.config.fetchProvider[volatileWrite]("http");
    const after = await ctx.web.fetch({ url: `https://8.8.8.8:${directTlsPort}/after` });
    ctx.web.config.fetchProvider[volatileWrite]("dsh-proxy-switch");
    const connectsAfterOther = upstream.seen.filter((entry) => entry.kind === "connect").length;
    check("B the original provider's tunnel still works", after.statusCode === 200 && /UPSTREAM-ORIGIN:\/after/.test(after.body.content));
    check("B the original tunnel was reused, not cut", connectsAfterOther === connectsBefore, `${connectsBefore} -> ${connectsAfterOther}`);

    await fiber.dispose();
    await restorePolicy();
    await stop(directTls);
    await stop(upstreamTls);
    await stop(upstream.server);
  }

  // ---------- Phase C: R6/R7/R8 + state API ----------
  {
    const upstream = createUpstream();
    const upstreamPort = await start(upstream.server);
    const target = httpTarget("TARGET");
    const targetPort = await start(target);
    const stateServer = createHttpServer((request, response) => {
      if (state.handler === null) {
        response.writeHead(503).end();
        return;
      }
      void state.handler(request, response);
    });
    const statePort = await start(stateServer);
    const origin = `http://127.0.0.1:${statePort}`;
    process.env.DSH_HOME = join(root, "home-c");

    const { ctx, fiber, controls, state } = await createContext(runtime, pluginModule, {
      mode: "forward",
      scope: "web_fetch_only",
      listenPort: await freePort(),
      upstream: `http://127.0.0.1:${upstreamPort}`,
      probeIntervalMs: 3000,
      resolveTarget: async () => ({ ok: true, address: "127.0.0.1", addresses: [{ address: "127.0.0.1", family: 4 }] }),
    }, { origin, waitMs: 180 });

    const post = async (path, body) => {
      const response = await fetch(`${origin}/dsh-proxy-switch${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-dsh-proxy-switch-request": "1" },
        body: JSON.stringify(body ?? {}),
      });
      return { status: response.status, body: await response.json() };
    };

    const [modeResponse, scopeResponse] = await Promise.all([
      post("/mode", { mode: "direct" }),
      post("/settings", { scope: "global" }),
    ]);
    check("C concurrent mode+scope both return 200", modeResponse.status === 200 && scopeResponse.status === 200);
    let snapshot = controls.snapshot();
    check("C concurrent updates do not lose each other", snapshot.mode === "direct" && snapshot.scope === "global", `${snapshot.mode}/${snapshot.scope}`);
    const disk = JSON.parse(await readFile(join(root, "home-c", "storages", "dsh-proxy-switch", "state.json"), "utf8"));
    check("C disk agrees with memory", disk.mode === "direct" && disk.scope === "global", `${disk.mode}/${disk.scope}`);

    const newPort = await freePort();
    const [portResponse, upstreamResponse] = await Promise.all([
      post("/settings", { listenPort: newPort }),
      post("/settings", { upstream: `http://127.0.0.1:${upstreamPort}` }),
    ]);
    check("C concurrent port+upstream both return 200", portResponse.status === 200 && upstreamResponse.status === 200);
    snapshot = controls.snapshot();
    check("C port/upstream updates both survive", snapshot.listenPort === newPort && snapshot.upstream === `http://127.0.0.1:${upstreamPort}`);

    await post("/settings", { scope: "web_fetch_only" });

    // R8: IPv6 loopback upstream.
    let ipv6Skipped = false;
    let ipv6Server;
    try {
      ipv6Server = createUpstream();
      await start(ipv6Server.server, "::1");
    } catch {
      ipv6Skipped = true;
      ipv6Server = null;
    }
    if (!ipv6Skipped) {
      const ipv6Port = ipv6Server.server.address().port;
      await controls.setMode("forward");
      await controls.updateSettings({ upstream: `http://[::1]:${ipv6Port}`, scope: "web_fetch_only" });
      await controls.probeNow();
      const ipv6Fetch = await ctx.web.fetch({ url: `http://8.8.8.8:${targetPort}/ipv6` });
      check("R8 IPv6 upstream is probed", controls.snapshot().probe.reachable === true, String(controls.snapshot().probe.error));
      check("R8 IPv6 upstream actually transports", ipv6Fetch.statusCode === 200 && /UPSTREAM:/.test(ipv6Fetch.body.content));
      await stop(ipv6Server.server);
    } else {
      console.log("SKIP  R8: this machine has no usable ::1 listener.");
    }

    await fiber.dispose();
    await stop(target);
    await stop(upstream.server);
    await stop(stateServer);
  }

  // ---------- Phase D: R3 child env and R7 corrupt state ----------
  {
    const target = httpTarget("DIRECT-PRIVATE");
    const targetPort = await start(target);
    const upstream = createUpstream();
    const upstreamPort = await start(upstream.server);
    const previousNoProxy = process.env.no_proxy;
    process.env.no_proxy = ".internal.test";
    process.env.http_proxy = `http://127.0.0.1:${upstreamPort}`;
    process.env.DSH_HOME = join(root, "home-d");
    const { ctx, fiber, controls } = await createContext(runtime, pluginModule, {
      mode: "forward",
      scope: "web_fetch_only",
      listenPort: await freePort(),
      upstream: `http://127.0.0.1:${upstreamPort}`,
      probeIntervalMs: 3000,
    }, {
      launchEnvironment: basicEnv({
        http_proxy: `http://127.0.0.1:${upstreamPort}`,
        https_proxy: `http://127.0.0.1:${upstreamPort}`,
        no_proxy: ".internal.test",
      }),
    });
    check("D child proxy env is unchanged by web_fetch_only", process.env.no_proxy === ".internal.test" && process.env.http_proxy === `http://127.0.0.1:${upstreamPort}`);
    const curl = await execFileAsync("curl", [
      "-sS", "--max-time", "5",
      "--resolve", `api.internal.test:${targetPort}:127.0.0.1`,
      `http://api.internal.test:${targetPort}/private`,
    ], { encoding: "utf8", env: { ...process.env } });
    check("R3 curl honors the original NO_PROXY", /DIRECT-PRIVATE/.test(curl.stdout), curl.stdout.trim());
    check("R3 original upstream received nothing", upstream.seen.length === 0, String(upstream.seen.length));

    await controls.updateSettings({ scope: "global" });
    await wait(80);
    const policyNoProxy = String(process.env.no_proxy ?? process.env.NO_PROXY ?? "");
    check(
      "R3 global mode preserves NO_PROXY",
      policyNoProxy.split(/[,\s]+/u).includes(".internal.test"),
      policyNoProxy,
    );
    const curlGlobal = await execFileAsync("curl", [
      "-sS", "--max-time", "5",
      "--resolve", `api.internal.test:${targetPort}:127.0.0.1`,
      `http://api.internal.test:${targetPort}/private`,
    ], { encoding: "utf8", env: { ...process.env } });
    check("R3 global curl still bypasses the upstream", /DIRECT-PRIVATE/.test(curlGlobal.stdout), curlGlobal.stdout.trim());
    check("R3 global upstream received nothing", upstream.seen.length === 0, String(upstream.seen.length));
    await controls.updateSettings({ scope: "web_fetch_only" });

    if (previousNoProxy === void 0) delete process.env.no_proxy;
    else process.env.no_proxy = previousNoProxy;
    delete process.env.http_proxy;
    await fiber.dispose();
    await stop(target);
    await stop(upstream.server);
  }

  {
    const home = join(root, "home-e");
    const dir = join(home, "storages", "dsh-proxy-switch");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "state.json"), JSON.stringify({
      mode: "forward",
      scope: "web_fetch_only",
      listenPort: 17801,
      upstream: "http://user:REVIEW-SECRET/part@proxy:1082",
      probeIntervalMs: 3000,
      lastSwitchAt: null,
    }), { encoding: "utf8", mode: 0o600 });
    process.env.DSH_HOME = home;
    const { controls, fiber } = await createContext(runtime, pluginModule, {
      scope: "web_fetch_only",
      listenPort: 17801,
      upstream: "http://127.0.0.1:1082",
      probeIntervalMs: 3000,
      detectUpstream: async () => ({ found: null, tried: [] }),
    });
    const snapshot = controls.snapshot();
    const text = JSON.stringify(snapshot);
    check("R7 corrupt state note does not echo the secret", !text.includes("REVIEW-SECRET"), snapshot.notes.join(" | "));
    check("R7 corrupt upstream falls back to the configured default", snapshot.upstream === "http://127.0.0.1:1082");
    await fiber.dispose();
  }

  // ---------- Phase F: v0.4 auto mode + upstream detection ----------
  {
    const upstream = createUpstream();
    const upstreamPort = await start(upstream.server);
    const target = httpTarget("TARGET");
    const targetPort = await start(target);
    const detectedUrl = `http://127.0.0.1:${upstreamPort}`;
    let detectCalls = 0;
    process.env.DSH_HOME = join(root, "home-f");
    const { ctx, fiber, controls } = await createContext(runtime, pluginModule, {
      scope: "web_fetch_only",
      listenPort: await freePort(),
      probeIntervalMs: 3000,
      // No upstream in the config: a fresh install starts auto/auto and must detect.
      detectUpstream: async ({ excludePorts }) => {
        detectCalls += 1;
        return {
          found: excludePorts.includes(upstreamPort) ? null : { url: detectedUrl, source: "system", reader: "scutil", needsAuth: false, latencyMs: 1 },
          tried: [{ url: detectedUrl, source: "system", kind: "proxy", error: null }],
        };
      },
      resolveTarget: async (host) =>
        host === "198.18.0.9"
          ? { ok: false, code: "PROXY_SWITCH_FAKE_IP", message: "fake-IP 198.18.0.9" }
          : { ok: true, address: "127.0.0.1", addresses: [{ address: "127.0.0.1", family: 4 }] },
    }, { initialFetchProvider: "http", waitMs: 400 });
    let snap = controls.snapshot();
    check("F fresh install starts in auto/auto", snap.mode === "auto" && snap.upstreamSource === "auto", `${snap.mode}/${snap.upstreamSource}`);
    check("F detection adopted the found upstream", snap.upstream === detectedUrl && snap.detection.status === "found", `${snap.upstream} ${snap.detection.status}`);
    check("F auto forwards while the upstream answers", snap.effectiveMode === "forward" && snap.probe.reachable === true);

    const viaProxy = await ctx.waterfall(
      "tools/execute",
      { name: "web_fetch", arguments: { url: `http://8.8.8.8:${targetPort}/auto-fwd` } },
      async () => ctx.web.fetch({ url: `http://8.8.8.8:${targetPort}/auto-fwd` }).then((r) => ({ content: [{ type: "text", text: r.body.content }] })),
    );
    check("F auto web_fetch went through the upstream", /UPSTREAM:/.test(viaProxy.content[0].text) && viaProxy.content.length === 1);

    await stop(upstream.server);
    await wait(1100);
    const callsBefore = detectCalls;
    const viaDirect = await ctx.waterfall(
      "tools/execute",
      { name: "web_fetch", arguments: { url: `http://8.8.8.8:${targetPort}/auto-direct` } },
      async () => ctx.web.fetch({ url: `http://8.8.8.8:${targetPort}/auto-direct` }).then((r) => ({ content: [{ type: "text", text: r.body.content }] })),
    );
    snap = controls.snapshot();
    check("F auto re-probes before a fetch and goes direct", /TARGET:\/auto-direct/.test(viaDirect.content[0].text) && snap.effectiveMode === "direct");
    check("F no mismatch warning in auto", snap.warning === null);
    check("F a fresh detection is not repeated on every failed probe", detectCalls === callsBefore, `${callsBefore} -> ${detectCalls}`);

    const fake = await ctx.waterfall(
      "tools/execute",
      { name: "web_fetch", arguments: { url: "http://198.18.0.9/" } },
      async () => ({ content: [{ type: "text", text: "NEXT" }] }),
    );
    check("F auto fake-IP refusal names the missing port", fake.isError === true && /HTTP 端口/.test(fake.content.at(-1).text), fake.content.at(-1).text.trim().slice(0, 40));
    await wait(60);
    // The startup detection is younger than the fake-IP interval, so this one is skipped…
    check("F fake-IP re-detection is rate-limited", detectCalls === callsBefore, `${callsBefore} -> ${detectCalls}`);
    // …while an explicit request always runs.
    await controls.detectNow();
    check("F an explicit detection always runs", detectCalls === callsBefore + 1, `${callsBefore} -> ${detectCalls}`);

    await controls.updateSettings({ upstream: "http://127.0.0.1:9" });
    snap = controls.snapshot();
    check("F a typed upstream switches the source to manual", snap.upstreamSource === "manual");
    const manualCalls = detectCalls;
    await controls.setMode("forward");
    await wait(60);
    check("F manual upstream is never re-detected", detectCalls === manualCalls && controls.snapshot().upstream === "http://127.0.0.1:9");
    await controls.updateSettings({ upstreamSource: "auto" });
    await wait(60);
    check("F switching back to auto detects again", detectCalls > manualCalls);

    await fiber.dispose();
    await stop(target);
  }

  // ---------- Phase G: lifecycle, control-route guards, probe identity (F3/F11/F12/F15/A5) ----------
  {
    async function makeRoute() {
      const holder = { handler: null };
      const server = createHttpServer((request, response) => {
        if (holder.handler === null) {
          response.writeHead(503);
          response.end();
          return;
        }
        void holder.handler(request, response);
      });
      const port = await start(server);
      return { server, port, origin: `http://127.0.0.1:${port}`, holder };
    }
    function rawRequest(port, { method = "GET", path = "/", headers = {}, body = null } = {}) {
      return new Promise((resolve, reject) => {
        const request = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
        });
        request.on("error", reject);
        request.end(body ?? void 0);
      });
    }
    const fastResolver = async () => ({ ok: true, address: "127.0.0.1", addresses: [{ address: "127.0.0.1", family: 4 }] });

    // --- F3/F15/A5 on one instance ---
    {
      const route = await makeRoute();
      process.env.DSH_HOME = join(root, "home-g1");
      let detectCalls = 0;
      const { ctx, fiber, controls, state } = await createContext(runtime, pluginModule, {
        mode: "forward",
        scope: "web_fetch_only",
        listenPort: await freePort(),
        upstream: "http://127.0.0.1:9",
        probeIntervalMs: 3000,
        resolveTarget: fastResolver,
        detectUpstream: async () => {
          detectCalls += 1;
          return { found: null, tried: [] };
        },
      }, { origin: route.origin, waitMs: 150 });
      route.holder.handler = state.handler;
      await wait(40);

      const goodHost = `127.0.0.1:${route.port}`;
      const stateOk = await rawRequest(route.port, { path: "/dsh-proxy-switch/state", headers: { host: goodHost } });
      check("F3 a same-host GET still reads state", stateOk.status === 200, String(stateOk.status));

      const rebound = await rawRequest(route.port, {
        path: "/dsh-proxy-switch/state",
        headers: { host: `evil.example:${route.port}`, "sec-fetch-site": "same-origin" },
      });
      check("F3 a DNS-rebinding Host is refused", rebound.status === 403, `${rebound.status} ${rebound.text.trim().slice(0, 40)}`);

      const noHeader = await rawRequest(route.port, {
        method: "POST",
        path: "/dsh-proxy-switch/mode",
        headers: { host: goodHost, "content-type": "application/json" },
        body: JSON.stringify({ mode: "direct" }),
      });
      check("F3 a mutation without the client header is refused", noHeader.status === 403, String(noHeader.status));

      const withHeader = await rawRequest(route.port, {
        method: "POST",
        path: "/dsh-proxy-switch/mode",
        headers: { host: goodHost, "content-type": "application/json", "x-dsh-proxy-switch-request": "1" },
        body: JSON.stringify({ mode: "direct" }),
      });
      check("F3 a mutation with the client header succeeds", withHeader.status === 200, String(withHeader.status));

      const secretBody = '{"upstream":"http://user:SECRET-BODY@x:9"';
      const badJson = await rawRequest(route.port, {
        method: "POST",
        path: "/dsh-proxy-switch/settings",
        headers: { host: goodHost, "content-type": "application/json", "x-dsh-proxy-switch-request": "1" },
        body: secretBody,
      });
      const snapshotText = JSON.stringify(controls.snapshot());
      check(
        "F15 a malformed body never echoes its content",
        badJson.status === 400 && !badJson.text.includes("SECRET-BODY") && !snapshotText.includes("SECRET-BODY"),
        badJson.text.trim().slice(0, 60),
      );

      const firstDetect = await rawRequest(route.port, {
        method: "POST",
        path: "/dsh-proxy-switch/detect",
        headers: { host: goodHost, "content-type": "application/json", "x-dsh-proxy-switch-request": "1" },
        body: "{}",
      });
      const callsAfterFirstDetect = detectCalls;
      const secondDetect = await rawRequest(route.port, {
        method: "POST",
        path: "/dsh-proxy-switch/detect",
        headers: { host: goodHost, "content-type": "application/json", "x-dsh-proxy-switch-request": "1" },
        body: "{}",
      });
      check(
        "A5 an explicit detection is rate limited",
        firstDetect.status === 200 && secondDetect.status === 429 && detectCalls === callsAfterFirstDetect,
        `${firstDetect.status}/${secondDetect.status} calls=${detectCalls}`,
      );

      // F11: a body that arrives after dispose must not act.
      const settingsPath = join(root, "home-g1", "storages", "dsh-proxy-switch", "state.json");
      const diskBefore = await readFile(settingsPath, "utf8").catch(() => null);
      const late = await new Promise((resolve) => {
        const request = httpRequest(
          {
            host: "127.0.0.1",
            port: route.port,
            method: "POST",
            path: "/dsh-proxy-switch/settings",
            headers: { host: goodHost, "content-type": "application/json", "x-dsh-proxy-switch-request": "1" },
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
          },
        );
        request.write('{"scope":');
        // Dispose while the handler is parked on the body, then send the rest.
        void fiber.dispose().then(async () => {
          await wait(30);
          request.end('"global"}');
        });
      });
      const diskAfter = await readFile(settingsPath, "utf8").catch(() => null);
      check("F11 a settings body completed after dispose is refused", late.status === 503, `${late.status} ${late.text.trim().slice(0, 50)}`);
      check("F11 that late command never writes state", diskAfter === diskBefore);
      await stop(route.server);
    }

    // --- F11: a detection that resolves after dispose must not write state ---
    {
      let releaseDetection;
      const gate = new Promise((resolve) => {
        releaseDetection = resolve;
      });
      const home = join(root, "home-g2");
      process.env.DSH_HOME = home;
      const { fiber } = await createContext(runtime, pluginModule, {
        scope: "web_fetch_only",
        listenPort: await freePort(),
        probeIntervalMs: 3000,
        detectUpstream: async () => {
          await gate;
          return { found: { url: "http://127.0.0.1:9", source: "system", needsAuth: false, latencyMs: 1 }, tried: [] };
        },
      });
      await fiber.dispose();
      releaseDetection();
      await wait(80);
      const written = await readFile(join(home, "storages", "dsh-proxy-switch", "state.json"), "utf8").catch(() => null);
      check("F11 a late detection after dispose does not write state", written === null, String(written).slice(0, 40));
    }

    // --- F12: probe results are bound to the address they measured ---
    {
      const probes = [];
      const home = join(root, "home-g3");
      process.env.DSH_HOME = home;
      const { controls, fiber } = await createContext(runtime, pluginModule, {
        mode: "auto",
        scope: "web_fetch_only",
        listenPort: await freePort(),
        upstream: "http://127.0.0.1:9",
        probeIntervalMs: 3000,
        detectUpstream: async () => ({ found: null, tried: [] }),
        probeImpl: (upstream) =>
          new Promise((resolve) => {
            probes.push({ upstream: upstream.href, resolve });
          }),
      }, { waitMs: 150 });
      check("F12 the first probe targets the configured upstream", probes.length >= 1 && probes[0].upstream === "http://127.0.0.1:9/", String(probes[0]?.upstream));
      await controls.updateSettings({ upstream: "http://127.0.0.1:8" });
      let snapshot = controls.snapshot();
      check("F12 a switch clears reachability until the new address is probed", snapshot.probe.reachable === null && snapshot.effectiveMode === "direct", `${snapshot.probe.reachable}/${snapshot.effectiveMode}`);
      probes[0].resolve({ reachable: true, latencyMs: 1, error: null });
      await wait(40);
      snapshot = controls.snapshot();
      check(
        "F12 the old address's success is discarded",
        snapshot.probe.reachable === null && snapshot.effectiveMode === "direct",
        `${snapshot.probe.reachable}/${snapshot.effectiveMode}`,
      );
      const nextProbeRun = controls.probeNow();
      await wait(30);
      const nextProbe = probes.at(-1);
      check("F12 the new address is actually probed", nextProbe.upstream === "http://127.0.0.1:8/", String(nextProbe.upstream));
      nextProbe.resolve({ reachable: true, latencyMs: 1, error: null });
      await nextProbeRun;
      check("F12 the new address's own result applies", controls.snapshot().probe.reachable === true && controls.snapshot().effectiveMode === "forward");
      await fiber.dispose();
    }

    // --- F12: a real 407 marks the stored upstream as needing credentials ---
    {
      const authUpstream = createHttpServer((request, response) => {
        response.writeHead(407, { "proxy-authenticate": 'Basic realm="test"' });
        response.end();
      });
      const authPort = await start(authUpstream);
      process.env.DSH_HOME = join(root, "home-g4");
      const { ctx, fiber, controls } = await createContext(runtime, pluginModule, {
        mode: "forward",
        scope: "web_fetch_only",
        listenPort: await freePort(),
        upstream: `http://127.0.0.1:${authPort}`,
        probeIntervalMs: 3000,
        detectUpstream: async () => ({ found: null, tried: [] }),
      }, { waitMs: 150 });
      await ctx.web.fetch({ url: "http://8.8.8.8/x" }).catch(() => {});
      await wait(40);
      check("F12 a 407 response is recorded as needing credentials", controls.snapshot().probe.needsAuth === true);
      await fiber.dispose();
      await stop(authUpstream);
    }

    // --- F14: the direct-mode precheck has a budget even when DNS never answers ---
    {
      process.env.DSH_HOME = join(root, "home-g6");
      const { ctx, fiber } = await createContext(runtime, pluginModule, {
        mode: "direct",
        scope: "web_fetch_only",
        listenPort: await freePort(),
        upstream: "http://127.0.0.1:9",
        probeIntervalMs: 3000,
        precheckTimeoutMs: 120,
        resolveTarget: () => new Promise(() => {}),
        detectUpstream: async () => ({ found: null, tried: [] }),
      }, { waitMs: 150 });
      const startedAt = Date.now();
      const refused = await ctx.waterfall(
        "tools/execute",
        { name: "web_fetch", arguments: { url: "http://8.8.8.8/x" } },
        async () => ({ content: [{ type: "text", text: "NEXT" }] }),
      );
      check(
        "F14 a never-ending precheck resolver is bounded",
        refused.isError === true && refused.error?.info?.code === "PROXY_SWITCH_DNS_TIMEOUT" && Date.now() - startedAt < 2_000,
        `${refused.error?.info?.code} after ${Date.now() - startedAt}ms`,
      );
      await fiber.dispose();
    }

    // --- F15: a damaged state file never leaks its content ---
    {
      const home = join(root, "home-g5");
      const dir = join(home, "storages", "dsh-proxy-switch");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "state.json"), '{"upstream":"http://user:SECRET-FILE@x:9"', { encoding: "utf8", mode: 0o600 });
      process.env.DSH_HOME = home;
      const { controls, fiber } = await createContext(runtime, pluginModule, {
        scope: "web_fetch_only",
        listenPort: await freePort(),
        probeIntervalMs: 3000,
        detectUpstream: async () => ({ found: null, tried: [] }),
      });
      const text = JSON.stringify(controls.snapshot());
      check("F15 a malformed state file never echoes its content", !text.includes("SECRET-FILE") && /invalid JSON/.test(text), controls.snapshot().notes.join(" | ").slice(0, 60));
      await fiber.dispose();
    }
  }

  await rm(root, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? "all host-integration checks passed" : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
