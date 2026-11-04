/**
 * Minimal HTTP proxy client for the plugin's private web_fetch channel.
 *
 * The provider does not use undici's global dispatcher and does not share a connection
 * pool with any other module. It talks to the plugin's own loopback forwarder, which
 * already owns the forward/direct decision, the upstream `Proxy-Authorization`, and the
 * SSRF check. This file is only the client half:
 *
 * - `http:`  → absolute-URI request to the forwarder;
 * - `https:` → `CONNECT` through the forwarder, then TLS to the origin.
 *
 * A proxy error (`x-dsh-proxy-switch-error`) is converted back into a `WebError` with the
 * forwarder's machine code, so the model sees `PROXY_SWITCH_FAKE_IP` / `WEB_BLOCKED_URL`
 * rather than an opaque transport failure.
 */
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { Readable } from "node:stream";
import { WebError } from "@deepseek-ai/dsh-web";
import { formatAuthority, isIpLiteral } from "./net-guard.js";

const ERROR_HEADER = "x-dsh-proxy-switch-error";
const MAX_ERROR_BODY = 16 * 1024;
const CONNECT_HEAD_TIMEOUT_MS = 8_000;
/** A target that accepts the tunnel but never completes TLS must not hang the task. */
const TLS_HANDSHAKE_TIMEOUT_MS = 10_000;

function timeoutOf(signal) {
  const reason = signal?.reason;
  return reason?.name === "TimeoutReason" && reason.code === "WEB_FETCH_TIMEOUT" ? reason : void 0;
}

function translate(signal, error) {
  if (error instanceof WebError) return error;
  const timeout = timeoutOf(signal);
  if (timeout !== void 0) return new WebError("web fetch timed out", "WEB_FETCH_TIMEOUT", { cause: timeout });
  if (signal?.aborted) return new WebError("web fetch aborted", "WEB_ABORTED", { cause: error });
  return new WebError(`web fetch failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
}

/**
 * Convert an upstream response into a `Response`.
 *
 * Everything here runs inside an HTTP event callback, where a throw is an unhandled
 * exception in the Host process. A remote server may answer with a status outside the
 * `Response` constructor's 200–599 range (Node's HTTP parser accepts e.g. 600), or with a
 * header value the Web `Headers` class rejects; both are converted to a structured
 * `WebError` so the caller sees a normal transport failure.
 *
 * @param message - the upstream `IncomingMessage`.
 * @returns a `Response` for the provider.
 * @throws WebError when the message cannot be represented.
 */
function toResponse(message) {
  const status = message.statusCode ?? 502;
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new WebError(
      `上游返回了无法转换的 HTTP 状态码 ${status}。 The upstream returned an HTTP status (${status}) that cannot be represented.`,
      "PROXY_SWITCH_UPSTREAM_BAD_RESPONSE",
      { cause: { status } },
    );
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === void 0) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
  }
  if (status === 204 || status === 205 || status === 304) {
    message.resume();
    return new Response(null, { status, headers });
  }
  return new Response(Readable.toWeb(message), { status, headers });
}

function readLimited(stream, limit = MAX_ERROR_BODY) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    stream.on("data", (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function proxyError(status, headers, body, fallbackMessage) {
  const code = headers[ERROR_HEADER];
  if (typeof code === "string" && code !== "") {
    return new WebError(body.trim() !== "" ? body.trim() : fallbackMessage, code);
  }
  return new WebError(body.trim() !== "" ? body.trim() : fallbackMessage, "PROXY_SWITCH_UPSTREAM_REFUSED", { cause: { status } });
}

function requestHttp({ url, headers, signal, proxyPort }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const request = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: `${url.origin}${url.pathname}${url.search}`,
        agent: false,
        headers: { ...headers, host: url.host, connection: "close" },
        signal,
      },
      (response) => {
        try {
          if (response.headers[ERROR_HEADER] !== void 0) {
            readLimited(response).then((body) => {
              try {
                finish(proxyError(response.statusCode ?? 502, response.headers, body, `proxy returned HTTP ${response.statusCode ?? 502}`));
              } catch (error) {
                response.destroy();
                finish(translate(signal, error));
              }
            });
            return;
          }
          const converted = toResponse(response);
          finish(null, { response: converted, close: async () => response.destroy() });
        } catch (error) {
          response.destroy();
          finish(translate(signal, error));
        }
      },
    );
    request.on("error", (error) => finish(translate(signal, error)));
    request.end();
  });
}

/** Read the CONNECT response head, returning its status, headers, and any remainder. */
function readConnectHead(socket, signal) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error, value) => {
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      socket.destroy();
      finish(translate(signal, new Error("aborted")));
    };
    const onError = (error) => finish(translate(signal, error));
    const onClose = () => finish(translate(signal, new Error("proxy closed the CONNECT handshake")));
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const boundary = buffered.indexOf("\r\n\r\n");
      if (boundary === -1) {
        if (buffered.length > MAX_ERROR_BODY) finish(translate(signal, new Error("oversized CONNECT response")));
        return;
      }
      const head = buffered.subarray(0, boundary).toString("latin1");
      const remainder = buffered.subarray(boundary + 4);
      const lines = head.split("\r\n");
      const status = Number((lines[0] ?? "").split(" ")[1]);
      const headers = {};
      for (const line of lines.slice(1)) {
        const index = line.indexOf(":");
        if (index === -1) continue;
        headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
      }
      socket.off("data", onData);
      finish(null, { status, headers, remainder, head });
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(translate(signal, new Error("CONNECT handshake timed out")));
    }, CONNECT_HEAD_TIMEOUT_MS);
    timer.unref?.();
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function requestHttps({ url, headers, signal, proxyPort, tlsOptions, tlsHandshakeTimeoutMs }) {
  const handshakeBudgetMs =
    Number.isFinite(tlsHandshakeTimeoutMs) && tlsHandshakeTimeoutMs > 0 ? tlsHandshakeTimeoutMs : TLS_HANDSHAKE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/u, "");
    const port = url.port === "" ? 443 : Number(url.port);
    let settled = false;
    let socket = null;
    let tlsSocket = null;
    let handshakeTimer = null;
    const clearHandshakeTimer = () => {
      if (handshakeTimer === null) return;
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearHandshakeTimer();
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    // One abort listener owns the whole dial — TCP connect, CONNECT handshake, TLS, and
    // the request — so a cancel during the TLS phase (where no HTTP request exists yet)
    // still closes both sockets and settles the promise.
    const onAbort = () => {
      socket?.destroy();
      tlsSocket?.destroy();
      finish(translate(signal, new Error("aborted")));
    };
    if (signal?.aborted) {
      finish(translate(signal, new Error("aborted")));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    socket = net.connect({ host: "127.0.0.1", port: proxyPort });
    socket.once("connect", () => {
      const authority = formatAuthority(host, port);
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      readConnectHead(socket, signal)
        .then(({ status, headers: responseHeaders, remainder, head }) => {
          if (settled) return;
          if (status !== 200) {
            const body = remainder.toString("utf8");
            socket.destroy();
            finish(proxyError(status, responseHeaders, body, `CONNECT refused with ${head.split("\r\n")[0]}`));
            return;
          }
          if (remainder.length > 0) {
            socket.unshift(remainder);
          }
          if (signal?.aborted) {
            socket.destroy();
            finish(translate(signal, new Error("aborted")));
            return;
          }
          const servername = isIpLiteral(host) ? void 0 : host;
          tlsSocket = tls.connect({
            socket,
            // The explicit `host` matters for an IP literal: without it Node defaults the
            // verification hostname to "localhost", even though the CONNECT target is the
            // IP. `servername` stays undefined for an IP (RFC 6066 forbids IP SNI); Node then
            // verifies the certificate's IP SAN against `host`.
            host,
            servername,
            ALPNProtocols: ["http/1.1"],
            ...tlsOptions,
          });
          // A target that completes CONNECT and then never speaks TLS would otherwise hold
          // the task until the outer deadline — or forever when no deadline is set.
          handshakeTimer = setTimeout(() => {
            tlsSocket?.destroy();
            finish(
              new WebError(
                `代理通道的 TLS 握手超时（${formatAuthority(host, port)}）。 The TLS handshake through the proxy channel timed out.`,
                "PROXY_SWITCH_UPSTREAM_TIMEOUT",
              ),
            );
          }, handshakeBudgetMs);
          handshakeTimer.unref?.();
          const onTlsError = (error) => {
            tlsSocket.destroy();
            finish(translate(signal, error));
          };
          tlsSocket.once("error", onTlsError);
          tlsSocket.once("secureConnect", () => {
            clearHandshakeTimer();
            if (settled) return;
            if (signal?.aborted) {
              tlsSocket.destroy();
              finish(translate(signal, new Error("aborted")));
              return;
            }
            tlsSocket.off("error", onTlsError);
            const agent = new http.Agent({ keepAlive: false });
            agent.createConnection = () => tlsSocket;
            const request = http.request(
              {
                host,
                port,
                method: "GET",
                path: `${url.pathname}${url.search}`,
                headers: { ...headers, host: url.host, connection: "close" },
                agent,
                signal,
              },
              (response) => {
                const close = async () => {
                  response.destroy();
                  tlsSocket.destroy();
                  agent.destroy();
                };
                try {
                  if (response.headers[ERROR_HEADER] !== void 0) {
                    readLimited(response).then((body) => {
                      try {
                        close();
                        finish(proxyError(response.statusCode ?? 502, response.headers, body, `proxy returned HTTP ${response.statusCode ?? 502}`));
                      } catch (error) {
                        close();
                        finish(translate(signal, error));
                      }
                    });
                    return;
                  }
                  const converted = toResponse(response);
                  finish(null, { response: converted, close });
                } catch (error) {
                  close();
                  finish(translate(signal, error));
                }
              },
            );
            request.on("error", (error) => {
              tlsSocket.destroy();
              agent.destroy();
              finish(translate(signal, error));
            });
            request.end();
          });
        })
        .catch((error) => {
          socket.destroy();
          finish(error);
        });
    });
    socket.once("error", (error) => finish(translate(signal, error)));
  });
}

/**
 * Perform one GET through the plugin's web_fetch forwarder.
 *
 * @param input.url - validated HTTP(S) URL.
 * @param input.headers - request headers (user-agent/accept).
 * @param input.signal - fused deadline/cancellation signal.
 * @param input.proxyPort - the web_fetch forwarder's loopback port.
 * @param input.tlsOptions - test-only TLS overrides; production passes none.
 * @param input.tlsHandshakeTimeoutMs - test-only TLS handshake budget override.
 * @returns `{ response, close }` matching the provider's expected shape.
 */
export async function requestThroughLocalProxy(input) {
  try {
    if (input.signal?.aborted) throw translate(input.signal, new Error("aborted"));
    if (input.url.protocol === "https:") return await requestHttps(input);
    return await requestHttp(input);
  } catch (error) {
    throw translate(input.signal, error);
  }
}
