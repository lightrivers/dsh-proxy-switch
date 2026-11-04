/**
 * The local forwarder behind `dsh-proxy-switch`.
 *
 * Two strict-only instances are used:
 *
 * - the **web_fetch channel**, bound on an ephemeral loopback port and used only by the
 *   plugin's `WebFetchProvider`. `isolateConnections` is on, so no HTTP keep-alive or
 *   tunnel survives one request and a mode/upstream change cannot be bypassed by a pooled
 *   connection;
 * - the **global channel**, bound on the configured `listenPort` and used only when the
 *   user explicitly selects `scope = global`. Other modules reach it through the global
 *   policy.
 *
 * There is intentionally no legacy/scope branching here: a request either goes to the
 * upstream proxy (`forward`) or is resolved and dialled directly after the SSRF check
 * (`direct`). A refusal or an unreachable upstream is answered with a real error
 * response; there is no silent fallback to the other mode.
 *
 * Every input that reaches this module is untrusted: a malformed `CONNECT` authority, an
 * invalid upstream credential, a bad header, or a throw from `net.connect` must become an
 * HTTP error response, never an uncaught exception in the Host process.
 *
 * Privacy: nothing here logs or stores a URL or a body. `onResult` carries the target host,
 * the response status, the engine, and timing only.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import {
  classifyAddress,
  formatAuthority,
  isIpLiteral,
  parseAuthority,
  resolveDirectTarget,
  unbracket,
} from "./net-guard.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const CONNECT_TIMEOUT_MS = 5_000;
const CONNECT_HEAD_TIMEOUT_MS = 8_000;
const DIRECT_DIAL_TIMEOUT_MS = 10_000;
/**
 * How long a fully connected upstream may stay silent before it is considered dead.
 *
 * This is deliberately larger than the dial timeout: a reasoning model's first byte (or a
 * queued upstream) can take tens of seconds, and a five-second idle timeout on the same
 * socket would abort slow-but-healthy responses, including SSE streams before their first
 * event. Once a response arrives the timeout is cleared entirely.
 */
const RESPONSE_HEAD_TIMEOUT_MS = 120_000;

const BAD_CREDENTIALS_CODE = "PROXY_SWITCH_BAD_UPSTREAM_CREDENTIALS";
const BAD_UPSTREAM_CODE = "PROXY_SWITCH_BAD_UPSTREAM";

function statusText(status) {
  return http.STATUS_CODES[status] ?? "Error";
}

/** Drop hop-by-hop headers and the absolute-form request line's `Host` rewrite target. */
function sanitizeHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    if (value === void 0) continue;
    result[name] = value;
  }
  return result;
}

function upstreamPort(upstream) {
  if (upstream.port !== "") return Number(upstream.port);
  return upstream.protocol === "https:" ? 443 : 80;
}

/**
 * Build the upstream `Proxy-Authorization` header.
 *
 * `parseUpstream` rejects an incomplete percent-encoding before it can be saved, but this
 * function is also reachable with a URL a test or a future caller constructed directly, so
 * the decode is guarded: a bad credential must become a structured error response, not a
 * `URIError` thrown inside an event handler.
 */
function basicAuth(upstream) {
  if (upstream.username === "" && upstream.password === "") return { ok: true };
  try {
    const user = decodeURIComponent(upstream.username);
    const pass = decodeURIComponent(upstream.password);
    return { ok: true, header: `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}` };
  } catch {
    return {
      ok: false,
      code: BAD_CREDENTIALS_CODE,
      message:
        "上游代理凭据无法解码（百分号编码不完整）：请在设置里重新填写上游地址。" +
        "The upstream proxy credentials cannot be decoded (incomplete percent-encoding); re-enter the upstream address in the settings.",
    };
  }
}

function upstreamFailureMessage(upstream, error) {
  const code = error?.code ?? error?.message ?? "error";
  return (
    `转发模式失败：无法连接到上游代理 ${upstream.origin}（${code}）。` +
    `请确认代理客户端已启动，或把线路切到「自动」或「直连」。` +
    ` Forward mode failed: cannot reach the upstream proxy ${upstream.origin} (${code}). ` +
    `Start the proxy client, or set the route to "Auto" or "Direct".`
  );
}

function upstreamAuthMessage(upstream) {
  return (
    `转发模式失败：上游代理 ${upstream.origin} 要求认证（HTTP 407）。请在设置里填写 http://user:pass@host:port。` +
    ` Forward mode failed: upstream ${upstream.origin} requires authentication (HTTP 407). Set http://user:pass@host:port in the settings.`
  );
}

function connectFailureMessage(authority, error) {
  const code = error?.code ?? error?.message ?? "error";
  return `直连模式连接目标 ${authority} 失败（${code}）。 Direct mode could not connect to ${authority} (${code}).`;
}

function nonPublicLiteralMessage(host) {
  return (
    `转发模式拒绝请求：目标 ${host} 是非公网 IP 字面量。代理会从它自己的网络解析这个地址，可能触达本机或内网服务。` +
    ` Forward mode refused ${host}: it is a non-public IP literal, which the proxy would resolve from its own network.`
  );
}

/** Write an HTTP error response to a client socket that may be mid-tunnel handshake. */
function writeSocketError(socket, status, message, code, extraHeaders = {}) {
  if (socket.destroyed || !socket.writable) return;
  const body = Buffer.from(`${message}\n`, "utf8");
  const extra = Object.entries(extraHeaders)
    .filter(([, value]) => typeof value === "string" && !/[\r\n]/u.test(value))
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  const head =
    `HTTP/1.1 ${status} ${statusText(status)}\r\n` +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    `Content-Length: ${body.length}\r\n` +
    `X-DSH-Proxy-Switch-Error: ${code}\r\n` +
    extra +
    "Connection: close\r\n\r\n";
  try {
    socket.end(Buffer.concat([Buffer.from(head, "latin1"), body]));
  } catch {
    socket.destroy();
  }
}

/**
 * Build a strict forwarder.
 *
 * @param options.getMode - returns `"forward" | "direct"`.
 * @param options.getUpstream - returns the parsed upstream URL (may throw if corrupt).
 * @param options.engine - `"web_fetch" | "global"`; only used in statistics.
 * @param options.isolateConnections - disables HTTP keep-alive/agent reuse for this instance.
 * @param options.rejectNonPublicIpLiteral - refuse a non-public IP literal in `forward` mode
 *   (the upstream provider does this for web_fetch; the global channel leaves it off).
 * @param options.onUpstreamFailure - called when the upstream looks dead; triggers a re-probe.
 * @param options.logger - optional `{ info, warn, error, debug }` sink.
 * @param options.onResult - optional `{ host, status, mode, engine, milliseconds, kind }` sink.
 */
export function createForwarder(options) {
  const {
    getMode,
    getUpstream,
    engine = "global",
    isolateConnections = false,
    rejectNonPublicIpLiteral = false,
    onUpstreamFailure,
    logger,
    onResult,
    resolveTarget = resolveDirectTarget,
  } = options;
  const sockets = new Set();
  const tunnels = new Set();
  let server = null;

  /**
   * Register one tunnelled pair so either socket's disappearance tears down both, and so
   * `close()` can destroy tunnels that a half-close would otherwise leave behind.
   */
  const registerTunnel = (clientSocket, upstreamSocket) => {
    const terminate = () => {
      tunnels.delete(tunnel);
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    };
    const tunnel = { terminate };
    tunnels.add(tunnel);
    clientSocket.on("close", terminate);
    upstreamSocket.on("close", terminate);
    clientSocket.on("error", terminate);
    upstreamSocket.on("error", terminate);
    return terminate;
  };

  const report = (entry) => {
    try {
      onResult?.({ ...entry, engine });
    } catch {
      /* statistics must never break a request */
    }
  };

  const notifyUpstreamFailure = () => {
    try {
      onUpstreamFailure?.();
    } catch {
      /* a probe must never break a request */
    }
  };

  /** Read the upstream through the getter, treating a corrupt value as "no upstream". */
  const readUpstream = () => {
    try {
      const upstream = getUpstream();
      return upstream instanceof URL ? upstream : null;
    } catch {
      return null;
    }
  };

  /**
   * Two-phase idle timeout: a short budget while dialling, a generous one while waiting for
   * the response head. Both clear when a response arrives.
   */
  function armTimeouts(request) {
    const abort = () => request.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    request.setTimeout(CONNECT_TIMEOUT_MS, abort);
    request.on("socket", (socket) => {
      const extend = () => {
        if (!request.destroyed) request.setTimeout(RESPONSE_HEAD_TIMEOUT_MS, abort);
      };
      if (socket.connecting) socket.once("connect", extend);
      else extend();
    });
  }

  const respondError = (res, status, message, code, extraHeaders = {}) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const body = `${message}\n`;
    try {
      res.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": Buffer.byteLength(body, "utf8"),
        "x-dsh-proxy-switch-error": code,
        ...extraHeaders,
        connection: "close",
      });
      res.end(body);
    } catch {
      res.destroy();
    }
  };

  function safeHost(req) {
    try {
      return new URL(req.url).hostname;
    } catch {
      return String(req.headers.host ?? "").split(":")[0];
    }
  }

  function targetPort(target) {
    if (target.port !== "") return Number(target.port);
    return target.protocol === "https:" ? 443 : 80;
  }

  /** Report exactly once per HTTP request, before the response body is written. */
  function failHttp(res, done, status, message, code, extraHeaders) {
    done(status);
    respondError(res, status, message, code, extraHeaders);
  }

  function handleHttpRequest(req, res) {
    const startedAt = Date.now();
    let target;
    try {
      target = new URL(req.url);
    } catch {
      report({ kind: "http", host: safeHost(req), status: 400, mode: getMode() });
      respondError(
        res,
        400,
        "dsh-proxy-switch 只接受绝对 URI 的代理请求。 dsh-proxy-switch only accepts absolute-URI proxy requests.",
        "PROXY_SWITCH_NOT_ABSOLUTE_URI",
      );
      return;
    }
    if (target.hostname === "") {
      report({ kind: "http", host: "", status: 400, mode: getMode() });
      respondError(
        res,
        400,
        "dsh-proxy-switch 收到没有主机名的目标。 dsh-proxy-switch received a target without a hostname.",
        "PROXY_SWITCH_BAD_TARGET",
      );
      return;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      report({ kind: "http", host: target.hostname, status: 400, mode: getMode() });
      respondError(
        res,
        400,
        `dsh-proxy-switch 不支持 ${target.protocol}// 目标。 dsh-proxy-switch does not proxy ${target.protocol}// targets.`,
        "PROXY_SWITCH_UNSUPPORTED_SCHEME",
      );
      return;
    }

    const host = target.hostname;
    const port = targetPort(target);
    let settled = false;
    const done = (status) => {
      if (settled) return;
      settled = true;
      report({ kind: "http", host, status, mode: getMode(), milliseconds: Date.now() - startedAt });
    };
    res.on("close", () => {
      if (!res.writableFinished) done(499);
    });

    if (getMode() === "forward") {
      forwardHttp(req, res, target, done);
      return;
    }
    void directHttp(req, res, target, done).catch((error) => {
      done(502);
      respondError(res, 502, connectFailureMessage(target.host, error), "PROXY_SWITCH_INTERNAL_ERROR");
    });
  }

  function forwardHttp(req, res, target, done) {
    const upstream = readUpstream();
    if (upstream === null) {
      failHttp(res, done, 502, "上游代理地址未配置或不可用。 The upstream proxy is not configured.", BAD_UPSTREAM_CODE);
      return;
    }
    if (rejectNonPublicIpLiteral && isIpLiteral(target.hostname) && !classifyAddress(target.hostname).public) {
      failHttp(res, done, 403, nonPublicLiteralMessage(target.hostname), "WEB_BLOCKED_URL");
      return;
    }
    const auth = basicAuth(upstream);
    if (!auth.ok) {
      failHttp(res, done, 502, auth.message, auth.code);
      return;
    }
    const library = upstream.protocol === "https:" ? https : http;
    const headers = sanitizeHeaders(req.headers);
    headers.host = target.host;
    if (auth.header !== void 0) headers["proxy-authorization"] = auth.header;

    let upstreamRequest;
    try {
      upstreamRequest = library.request({
        protocol: upstream.protocol,
        hostname: unbracket(upstream.hostname),
        port: upstreamPort(upstream),
        method: req.method,
        path: target.href,
        headers,
        ...(isolateConnections ? { agent: false } : {}),
      });
    } catch (error) {
      done(502);
      respondError(res, 502, upstreamFailureMessage(upstream, error), "PROXY_SWITCH_UPSTREAM_UNREACHABLE");
      return;
    }

    let settled = false;
    armTimeouts(upstreamRequest);

    upstreamRequest.on("error", (error) => {
      if (settled) return;
      settled = true;
      notifyUpstreamFailure();
      done(502);
      respondError(res, 502, upstreamFailureMessage(upstream, error), "PROXY_SWITCH_UPSTREAM_UNREACHABLE");
    });

    upstreamRequest.on("response", (upstreamResponse) => {
      settled = true;
      upstreamRequest.setTimeout(0);
      const status = upstreamResponse.statusCode ?? 502;
      if (status === 407) {
        upstreamResponse.destroy();
        done(407);
        respondError(res, 407, upstreamAuthMessage(upstream), "PROXY_SWITCH_UPSTREAM_AUTH_REQUIRED", {
          "proxy-authenticate": 'Basic realm="dsh-proxy-switch upstream"',
        });
        return;
      }
      res.writeHead(status, sanitizeHeaders(upstreamResponse.headers));
      upstreamResponse.on("error", () => res.destroy());
      res.on("close", () => upstreamResponse.destroy());
      upstreamResponse.pipe(res);
      res.on("finish", () => done(status));
    });

    req.on("error", () => upstreamRequest.destroy());
    req.pipe(upstreamRequest);
  }

  async function directHttp(req, res, target, done) {
    const verdict = await resolveTarget(target.hostname);
    if (!verdict.ok) {
      done(403);
      respondError(res, 403, verdict.message, verdict.code);
      return;
    }
    const library = target.protocol === "https:" ? https : http;
    const headers = sanitizeHeaders(req.headers);
    headers.host = target.host;
    const port = targetPort(target);

    let upstreamRequest;
    try {
      upstreamRequest = library.request({
        host: verdict.address,
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
        ...(target.protocol === "https:" ? { servername: unbracket(target.hostname) } : {}),
        ...(isolateConnections ? { agent: false } : {}),
      });
    } catch (error) {
      done(502);
      respondError(res, 502, connectFailureMessage(target.host, error), "PROXY_SWITCH_DIRECT_UNREACHABLE");
      return;
    }

    let settled = false;
    armTimeouts(upstreamRequest);

    upstreamRequest.on("error", (error) => {
      if (settled) return;
      settled = true;
      done(502);
      respondError(res, 502, connectFailureMessage(target.host, error), "PROXY_SWITCH_DIRECT_UNREACHABLE");
    });

    upstreamRequest.on("response", (upstreamResponse) => {
      settled = true;
      upstreamRequest.setTimeout(0);
      const status = upstreamResponse.statusCode ?? 502;
      res.writeHead(status, sanitizeHeaders(upstreamResponse.headers));
      upstreamResponse.on("error", () => res.destroy());
      res.on("close", () => upstreamResponse.destroy());
      upstreamResponse.pipe(res);
      res.on("finish", () => done(status));
    });

    req.on("error", () => upstreamRequest.destroy());
    req.pipe(upstreamRequest);
  }

  /**
   * Strict CONNECT: parse, decide, then tunnel.
   *
   * The authority is validated before anything else: `splitAuthority` returns `NaN` for
   * `example.com:notaport`, and `net.connect({ port: NaN })` throws synchronously from an
   * event handler — which is an uncaught exception, not a 400.
   */
  function handleConnect(req, clientSocket, head) {
    const startedAt = Date.now();
    const authorityText = req.url;
    const parsed = parseAuthority(authorityText, { defaultPort: 80 });
    clientSocket.on("error", () => clientSocket.destroy());
    if (!parsed.ok) {
      report({ kind: "connect", host: "", status: 400, mode: getMode() });
      writeSocketError(clientSocket, 400, parsed.message, parsed.code);
      return;
    }
    const { host, port } = parsed;
    clientSocket.on("close", () => {
      if (!clientSocket.writableFinished) {
        report({ kind: "connect", host, status: 499, mode: getMode(), milliseconds: Date.now() - startedAt });
      }
    });

    const context = { authorityText, host, port, clientSocket, head, startedAt };
    const guard = (promise) => {
      promise.catch((error) => {
        report({ kind: "connect", host, status: 502, mode: getMode(), milliseconds: Date.now() - startedAt });
        writeSocketError(clientSocket, 502, connectFailureMessage(formatAuthority(host, port), error), "PROXY_SWITCH_INTERNAL_ERROR");
      });
    };

    if (getMode() === "forward") connectViaUpstream(context);
    else guard(connectDirect(context));
  }

  async function connectDirect(context) {
    const verdict = await resolveTarget(context.host);
    if (!verdict.ok) {
      report({ kind: "connect", host: context.host, status: 403, mode: getMode(), milliseconds: Date.now() - context.startedAt });
      writeSocketError(context.clientSocket, 403, verdict.message, verdict.code);
      return;
    }
    await dialDirect(context, verdict.address);
  }

  /** Dial one validated destination and pipe it to the client. */
  function dialDirect(context, address) {
    const { clientSocket, head, host, port, startedAt } = context;
    return new Promise((resolve) => {
      let socket;
      try {
        socket = net.connect({ host: address, port });
      } catch (error) {
        report({ kind: "connect", host, status: 502, mode: getMode(), milliseconds: Date.now() - startedAt });
        writeSocketError(clientSocket, 502, connectFailureMessage(formatAuthority(host, port), error), "PROXY_SWITCH_DIRECT_UNREACHABLE");
        resolve();
        return;
      }
      let done = false;
      const timer = setTimeout(() => {
        socket.destroy(Object.assign(new Error("direct connect timeout"), { code: "ETIMEDOUT" }));
      }, DIRECT_DIAL_TIMEOUT_MS);
      timer.unref?.();

      socket.once("error", (error) => {
        clearTimeout(timer);
        if (done) return;
        done = true;
        report({ kind: "connect", host, status: 502, mode: getMode(), milliseconds: Date.now() - startedAt });
        writeSocketError(clientSocket, 502, connectFailureMessage(formatAuthority(host, port), error), "PROXY_SWITCH_DIRECT_UNREACHABLE");
        resolve();
      });

      socket.once("connect", () => {
        clearTimeout(timer);
        if (done) return;
        done = true;
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) socket.write(head);
        registerTunnel(clientSocket, socket);
        socket.pipe(clientSocket);
        clientSocket.pipe(socket);
        report({ kind: "connect", host, status: 200, mode: getMode(), milliseconds: Date.now() - startedAt });
        resolve();
      });
    });
  }

  /**
   * Tunnel through the upstream proxy.
   *
   * `Proxy-Authorization` belongs to the upstream handshake only: it is written on the
   * `CONNECT` line pair and never forwarded into the tunnel.
   */
  function connectViaUpstream(context) {
    const { clientSocket, head, host, port, startedAt } = context;
    const upstream = readUpstream();
    if (upstream === null) {
      report({ kind: "connect", host, status: 502, mode: getMode(), milliseconds: Date.now() - startedAt });
      writeSocketError(clientSocket, 502, "上游代理地址未配置或不可用。 The upstream proxy is not configured.", BAD_UPSTREAM_CODE);
      return;
    }
    if (rejectNonPublicIpLiteral && isIpLiteral(host) && !classifyAddress(host).public) {
      report({ kind: "connect", host, status: 403, mode: getMode(), milliseconds: Date.now() - startedAt });
      writeSocketError(clientSocket, 403, nonPublicLiteralMessage(host), "WEB_BLOCKED_URL");
      return;
    }
    const auth = basicAuth(upstream);
    if (!auth.ok) {
      report({ kind: "connect", host, status: 502, mode: getMode(), milliseconds: Date.now() - startedAt });
      writeSocketError(clientSocket, 502, auth.message, auth.code);
      return;
    }
    const targetAuthority = formatAuthority(host, port);
    let upstreamSocket;
    try {
      upstreamSocket = net.connect({ host: unbracket(upstream.hostname), port: upstreamPort(upstream) });
    } catch (error) {
      report({ kind: "connect", host, status: 502, mode: getMode(), milliseconds: Date.now() - startedAt });
      writeSocketError(clientSocket, 502, upstreamFailureMessage(upstream, error), "PROXY_SWITCH_UPSTREAM_UNREACHABLE");
      return;
    }
    let done = false;

    const finish = (statusCode) => {
      done = true;
      report({ kind: "connect", host, status: statusCode, mode: getMode(), milliseconds: Date.now() - startedAt });
    };

    const fail = (status, message, code, extraHeaders) => {
      if (done) return;
      finish(status);
      upstreamSocket.destroy();
      writeSocketError(clientSocket, status, message, code, extraHeaders);
    };

    const connectTimer = setTimeout(() => {
      fail(504, upstreamFailureMessage(upstream, { code: "ETIMEDOUT" }), "PROXY_SWITCH_UPSTREAM_UNREACHABLE");
    }, CONNECT_TIMEOUT_MS);
    connectTimer.unref?.();

    upstreamSocket.once("error", (error) => {
      clearTimeout(connectTimer);
      if (done) return;
      notifyUpstreamFailure();
      fail(502, upstreamFailureMessage(upstream, error), "PROXY_SWITCH_UPSTREAM_UNREACHABLE");
    });

    upstreamSocket.once("connect", () => {
      clearTimeout(connectTimer);
      const headers = [
        `CONNECT ${targetAuthority} HTTP/1.1`,
        `Host: ${targetAuthority}`,
        "Proxy-Connection: keep-alive",
      ];
      if (auth.header !== void 0) headers.push(`Proxy-Authorization: ${auth.header}`);
      upstreamSocket.write(`${headers.join("\r\n")}\r\n\r\n`);
      let buffered = Buffer.alloc(0);
      const headTimer = setTimeout(() => {
        fail(504, `转发模式等待上游代理隧道响应超时（${upstream.origin}）。 Forward mode timed out waiting for the upstream tunnel.`, "PROXY_SWITCH_UPSTREAM_TIMEOUT");
      }, CONNECT_HEAD_TIMEOUT_MS);
      headTimer.unref?.();

      const onData = (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        const boundary = buffered.indexOf("\r\n\r\n");
        if (boundary === -1) {
          if (buffered.length > 16 * 1024) {
            clearTimeout(headTimer);
            fail(502, "上游代理返回的响应头过长。 The upstream proxy sent an oversized response header.", "PROXY_SWITCH_UPSTREAM_BAD_RESPONSE");
          }
          return;
        }
        clearTimeout(headTimer);
        upstreamSocket.off("data", onData);
        const headText = buffered.subarray(0, boundary).toString("latin1");
        const remainder = buffered.subarray(boundary + 4);
        const statusLine = headText.split("\r\n")[0] ?? "";
        const code = Number(statusLine.split(" ")[1]);
        if (code === 407) {
          fail(407, upstreamAuthMessage(upstream), "PROXY_SWITCH_UPSTREAM_AUTH_REQUIRED", {
            "Proxy-Authenticate": 'Basic realm="dsh-proxy-switch upstream"',
          });
          return;
        }
        if (code !== 200) {
          if (done) return;
          finish(502);
          upstreamSocket.destroy();
          writeSocketError(
            clientSocket,
            502,
            `转发模式失败：上游代理 ${upstream.origin} 拒绝隧道 ${targetAuthority}（${statusLine}）。` +
              ` Forward mode failed: upstream ${upstream.origin} refused the tunnel ${targetAuthority} (${statusLine}).`,
            "PROXY_SWITCH_UPSTREAM_REFUSED_TUNNEL",
          );
          return;
        }
        if (done) return;
        done = true;
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (remainder.length > 0) clientSocket.write(remainder);
        if (head?.length) upstreamSocket.write(head);
        registerTunnel(clientSocket, upstreamSocket);
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
        report({ kind: "connect", host, status: 200, mode: getMode(), milliseconds: Date.now() - startedAt });
      };

      upstreamSocket.on("data", onData);
    });
  }

  function handleClientError(error, socket) {
    if (socket.writable) {
      writeSocketError(socket, 400, `dsh-proxy-switch 收到无法解析的请求：${error?.code ?? "bad request"}。`, "PROXY_SWITCH_BAD_REQUEST");
    } else {
      socket.destroy();
    }
  }

  return {
    /**
     * Bind the loopback listener.
     *
     * @param port - TCP port; `0` asks the OS for an ephemeral port (web_fetch channel).
     * @returns `{ ok: true }` or `{ ok: false, error }`; a bind failure never throws.
     */
    async listen(port) {
      if (server !== null) await this.close();
      const instance = http.createServer((req, res) => {
        try {
          handleHttpRequest(req, res);
        } catch (error) {
          logger?.error?.("[dsh-proxy-switch] request handler failed: %s", error?.message ?? error);
          try {
            respondError(res, 502, "dsh-proxy-switch 内部错误。 Internal error.", "PROXY_SWITCH_INTERNAL_ERROR");
          } catch {
            res.destroy();
          }
        }
      });
      instance.keepAliveTimeout = 65_000;
      instance.headersTimeout = 70_000;
      instance.on("connect", (req, socket, head) => {
        try {
          handleConnect(req, socket, head);
        } catch (error) {
          logger?.error?.("[dsh-proxy-switch] CONNECT handler failed: %s", error?.message ?? error);
          try {
            writeSocketError(socket, 502, "dsh-proxy-switch 内部错误。 Internal error.", "PROXY_SWITCH_INTERNAL_ERROR");
          } catch {
            socket.destroy();
          }
        }
      });
      instance.on("clientError", (error, socket) => handleClientError(error, socket));
      instance.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      const bound = await new Promise((resolve) => {
        const onError = (error) => {
          instance.off("listening", onListening);
          resolve({ ok: false, error: error?.code ?? String(error) });
        };
        const onListening = () => {
          instance.off("error", onError);
          resolve({ ok: true });
        };
        instance.once("error", onError);
        instance.once("listening", onListening);
        try {
          instance.listen(port, "127.0.0.1");
        } catch (error) {
          instance.off("error", onError);
          resolve({ ok: false, error: error?.code ?? String(error) });
        }
      });
      if (!bound.ok) {
        try {
          instance.close();
        } catch {
          /* already failed */
        }
        logger?.error?.("[dsh-proxy-switch] failed to bind 127.0.0.1:%s (%s)", port, bound.error);
        return bound;
      }
      server = instance;
      logger?.info?.("[dsh-proxy-switch] %s channel listening on 127.0.0.1:%s", engine, port);
      return { ok: true };
    },

    /** Stop the listener and destroy every live tunnel. */
    async close() {
      const instance = server;
      server = null;
      for (const tunnel of tunnels) tunnel.terminate();
      tunnels.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (instance === null) return;
      await new Promise((resolve) => instance.close(() => resolve()));
    },

    /** The bound port, or `null` when not listening. */
    get port() {
      const address = server?.address();
      return address !== null && typeof address === "object" ? address.port : null;
    },
  };
}
