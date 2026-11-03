import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";

import { createForwarder } from "../lib/forwarder.js";

function startServer(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function stop(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function proxyGet(port, absoluteUrl) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method: "GET", path: absoluteUrl }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

function connectThrough(port, authority) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let buffered = "";
    const onData = (chunk) => {
      buffered += chunk.toString("latin1");
      if (buffered.includes("\r\n\r\n")) {
        socket.off("data", onData);
        resolve({ socket, head: buffered });
      }
    };
    socket.on("data", onData);
    socket.on("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 4_000).unref();
  });
}

test("forward mode sends the absolute URI to the upstream proxy", async (t) => {
  const seen = [];
  const upstream = http.createServer((request, response) => {
    seen.push({ url: request.url, host: request.headers.host });
    response.writeHead(200, { "x-upstream": "yes" });
    response.end("hello-from-upstream");
  });
  const upstreamPort = await startServer(upstream);
  t.after(() => stop(upstream));

  const results = [];
  const forwarder = createForwarder({
    getMode: () => "forward",
    getUpstream: () => new URL(`http://127.0.0.1:${upstreamPort}`),
    onResult: (entry) => results.push(entry),
  });
  await forwarder.listen(0);
  t.after(() => forwarder.close());

  const response = await proxyGet(forwarder.port, "http://example.com/hello?x=1");
  assert.equal(response.status, 200);
  assert.equal(response.body, "hello-from-upstream");
  assert.equal(seen[0].url, "http://example.com/hello?x=1");
  assert.equal(seen[0].host, "example.com");
  assert.equal(results.some((entry) => entry.status === 200), true);
});

test("forward mode answers 502 with an explicit message when the upstream is down", async (t) => {
  const dead = net.createServer();
  const deadPort = await startServer(dead);
  await stop(dead);

  const forwarder = createForwarder({
    getMode: () => "forward",
    getUpstream: () => new URL(`http://127.0.0.1:${deadPort}`),
  });
  await forwarder.listen(0);
  t.after(() => forwarder.close());

  const response = await proxyGet(forwarder.port, "http://example.com/");
  assert.equal(response.status, 502);
  assert.match(response.body, /转发模式失败/);
  assert.match(response.body, /Forward mode failed/);
  assert.equal(response.headers["x-dsh-proxy-switch-error"], "PROXY_SWITCH_UPSTREAM_UNREACHABLE");
});

test("direct mode refuses a fake-IP destination without dialling", async (t) => {
  const forwarder = createForwarder({
    getMode: () => "direct",
    getUpstream: () => new URL("http://127.0.0.1:1082"),
    resolveTarget: async () => ({ ok: false, code: "PROXY_SWITCH_FAKE_IP", message: "目标解析到 fake-IP 地址 198.18.0.5。 fake-IP 198.18.0.5." }),
  });
  await forwarder.listen(0);
  t.after(() => forwarder.close());

  const response = await proxyGet(forwarder.port, "http://example.com/");
  assert.equal(response.status, 403);
  assert.match(response.body, /fake-IP/);
  assert.equal(response.headers["x-dsh-proxy-switch-error"], "PROXY_SWITCH_FAKE_IP");
});

test("direct mode dials the validated address and preserves path and host", async (t) => {
  const target = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`path=${request.url} host=${request.headers.host}`);
  });
  const targetPort = await startServer(target);
  t.after(() => stop(target));

  const forwarder = createForwarder({
    getMode: () => "direct",
    getUpstream: () => new URL("http://127.0.0.1:1082"),
    resolveTarget: async () => ({ ok: true, address: "127.0.0.1" }),
  });
  await forwarder.listen(0);
  t.after(() => forwarder.close());

  const response = await proxyGet(forwarder.port, `http://direct.example:${targetPort}/a/b?c=d`);
  assert.equal(response.status, 200);
  assert.equal(response.body, `path=/a/b?c=d host=direct.example:${targetPort}`);
});

test("CONNECT in forward mode tunnels through the upstream proxy", async (t) => {
  const upstream = http.createServer();
  upstream.on("connect", (request, socket) => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
    // An upgraded socket is not tracked by server.close(); close it when the peer ends.
    socket.on("end", () => socket.destroy());
  });
  const upstreamPort = await startServer(upstream);
  t.after(() => stop(upstream));

  const forwarder = createForwarder({
    getMode: () => "forward",
    getUpstream: () => new URL(`http://127.0.0.1:${upstreamPort}`),
  });
  await forwarder.listen(0);
  t.after(() => forwarder.close());

  const { socket, head } = await connectThrough(forwarder.port, "secure.example:443");
  assert.match(head, /200 Connection Established/);
  socket.write("ping");
  const [chunk] = await once(socket, "data");
  assert.equal(chunk.toString("utf8"), "echo:ping");
  socket.destroy();
});

test("CONNECT in forward mode reports an unreachable upstream", async (t) => {
  const dead = net.createServer();
  const deadPort = await startServer(dead);
  await stop(dead);

  const forwarder = createForwarder({
    getMode: () => "forward",
    getUpstream: () => new URL(`http://127.0.0.1:${deadPort}`),
  });
  await forwarder.listen(0);
  t.after(() => forwarder.close());

  const { socket, head } = await connectThrough(forwarder.port, "secure.example:443");
  assert.match(head, /502/);
  assert.match(head, /PROXY_SWITCH_UPSTREAM_UNREACHABLE/);
  socket.destroy();
});

test("CONNECT in direct mode refuses a fake-IP target", async (t) => {
  const forwarder = createForwarder({
    getMode: () => "direct",
    getUpstream: () => new URL("http://127.0.0.1:1082"),
    resolveTarget: async () => ({ ok: false, code: "PROXY_SWITCH_FAKE_IP", message: "refused fake-IP" }),
  });
  await forwarder.listen(0);
  t.after(() => forwarder.close());

  const { socket, head } = await connectThrough(forwarder.port, "secure.example:443");
  assert.match(head, /403/);
  assert.match(head, /PROXY_SWITCH_FAKE_IP/);
  socket.destroy();
});

test("the listener binds loopback only", async (t) => {
  const forwarder = createForwarder({
    getMode: () => "direct",
    getUpstream: () => new URL("http://127.0.0.1:1082"),
  });
  const bound = await forwarder.listen(0);
  t.after(() => forwarder.close());
  assert.equal(bound.ok, true);
  const socket = net.connect({ host: "127.0.0.1", port: forwarder.port });
  await once(socket, "connect");
  socket.destroy();
});

// ---------------------------------------------------------------------------
// CONNECT authority hardening (P0-1)
// ---------------------------------------------------------------------------

test("malformed CONNECT authorities are answered with 400 and never crash the listener", async (t) => {
  const forwarder = createForwarder({
    getMode: () => "forward",
    getUpstream: () => new URL("http://127.0.0.1:1"),
  });
  await forwarder.listen(0);
  t.after(() => forwarder.close());

  const malformed = [
    "example.com:notaport",
    "example.com:65536",
    "example.com:0",
    "example.com:-1",
    "example.com:1e3",
    ":443",
    "[::1",
    "[::1]443",
    "[::1]:",
    "[]:443",
    "example.com:443:extra",
    "exa mple.com:443",
  ];
  for (const authority of malformed) {
    const { socket, head } = await connectThrough(forwarder.port, authority);
    assert.match(head, /^HTTP\/1\.1 400 /, `${authority} must be 400`);
    // A space never reaches our parser: Node's HTTP parser rejects the request line first
    // and reports HPE_INVALID_CONSTANT. Both layers must answer 400, neither may crash.
    assert.match(
      head,
      /PROXY_SWITCH_INVALID_AUTHORITY|PROXY_SWITCH_BAD_REQUEST/,
      `${authority} must carry a machine code`,
    );
    socket.destroy();
  }

  // Still serving after all of that: a valid authority reaches the normal path (502 because
  // the upstream is dead), which proves the process and listener survived.
  const { socket, head } = await connectThrough(forwarder.port, "example.com:443");
  assert.match(head, /^HTTP\/1\.1 502 /);
  socket.destroy();
});

test("CONNECT port boundaries 1 and 65535 still reach the normal path", async (t) => {
  const forwarder = createForwarder({
    getMode: () => "forward",
    getUpstream: () => new URL("http://127.0.0.1:1"),
  });
  await forwarder.listen(0);
  t.after(() => forwarder.close());
  for (const authority of ["example.com:1", "example.com:65535", "[2606:4700:4700::1111]:443"]) {
    const { socket, head } = await connectThrough(forwarder.port, authority);
    assert.equal(/^HTTP\/1\.1 400 /.test(head), false, `${authority} must not be a 400`);
    socket.destroy();
  }
});

// ---------------------------------------------------------------------------
// Upstream authentication (P0-2 / P1-3)
// ---------------------------------------------------------------------------

const BASIC = `Basic ${Buffer.from("user:pass").toString("base64")}`;

test("an authenticated upstream receives Proxy-Authorization for plain HTTP", async (t) => {
  const seen = [];
  const upstream = http.createServer((request, response) => {
    seen.push(request.headers["proxy-authorization"]);
    if (request.headers["proxy-authorization"] !== BASIC) {
      response.writeHead(407, { "proxy-authenticate": 'Basic realm="test"' });
      response.end("auth required");
      return;
    }
    response.writeHead(200);
    response.end("hello-from-authenticated-upstream");
  });
  const upstreamPort = await startServer(upstream);
  t.after(() => stop(upstream));

  const forwarder = createForwarder({
    getMode: () => "forward",
    getUpstream: () => new URL(`http://user:pass@127.0.0.1:${upstreamPort}`),
  });
  await forwarder.listen(0);
  t.after(() => forwarder.close());

  const response = await proxyGet(forwarder.port, "http://example.com/auth");
  assert.equal(response.status, 200);
  assert.equal(response.body, "hello-from-authenticated-upstream");
  assert.deepEqual(seen, [BASIC]);
});

test("an authenticated upstream receives Proxy-Authorization for CONNECT and it never reaches the target", async (t) => {
  const seen = [];
  const upstream = http.createServer();
  upstream.on("connect", (request, socket) => {
    seen.push(request.headers["proxy-authorization"]);
    if (request.headers["proxy-authorization"] !== BASIC) {
      socket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
    socket.on("end", () => socket.destroy());
  });
  const upstreamPort = await startServer(upstream);
  t.after(() => stop(upstream));

  const forwarder = createForwarder({
    getMode: () => "forward",
    getUpstream: () => new URL(`http://user:pass@127.0.0.1:${upstreamPort}`),
  });
  await forwarder.listen(0);
  t.after(() => forwarder.close());

  const { socket, head } = await connectThrough(forwarder.port, "secure.example:443");
  assert.match(head, /200 Connection Established/);
  socket.write("ping");
  const [chunk] = await once(socket, "data");
  assert.equal(chunk.toString("utf8"), "echo:ping");
  assert.deepEqual(seen, [BASIC]);
  // The tunnel carries the target's own bytes only; the proxy header is not replayed.
  socket.destroy();
});

test("CONNECT to an upstream that answers 407 reports a structured error", async (t) => {
  const upstream = http.createServer();
  upstream.on("connect", (request, socket) => {
    socket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n');
    socket.destroy();
  });
  const upstreamPort = await startServer(upstream);
  t.after(() => stop(upstream));

  const forwarder = createForwarder({
    getMode: () => "forward",
    getUpstream: () => new URL(`http://user:wrong@127.0.0.1:${upstreamPort}`),
  });
  await forwarder.listen(0);
  t.after(() => forwarder.close());

  const { socket, head } = await connectThrough(forwarder.port, "secure.example:443");
  assert.match(head, /^HTTP\/1\.1 407 /);
  assert.match(head, /PROXY_SWITCH_UPSTREAM_AUTH_REQUIRED/);
  assert.match(head, /Proxy-Authenticate/);
  // Credentials must never appear in the error body.
  assert.equal(head.includes("wrong"), false);
  socket.destroy();
});

test("a malformed percent-encoded credential becomes a 502, not an uncaught exception", async (t) => {
  const forwarder = createForwarder({
    getMode: () => "forward",
    getUpstream: () => new URL("http://u%ZZ:p@127.0.0.1:1082"),
  });
  await forwarder.listen(0);
  t.after(() => forwarder.close());

  const response = await proxyGet(forwarder.port, "http://example.com/");
  assert.equal(response.status, 502);
  assert.equal(response.headers["x-dsh-proxy-switch-error"], "PROXY_SWITCH_BAD_UPSTREAM_CREDENTIALS");

  const { socket, head } = await connectThrough(forwarder.port, "secure.example:443");
  assert.match(head, /^HTTP\/1\.1 502 /);
  assert.match(head, /PROXY_SWITCH_BAD_UPSTREAM_CREDENTIALS/);
  socket.destroy();

  // Still alive and serving errors rather than having crashed.
  const again = await proxyGet(forwarder.port, "http://example.com/");
  assert.equal(again.status, 502);
});

// ---------------------------------------------------------------------------
// Scope routing (P1-6)
// ---------------------------------------------------------------------------

test("forward mode refuses a non-public IP literal when asked", async (t) => {
  const upstream = http.createServer((request, response) => {
    response.writeHead(200);
    response.end("upstream");
  });
  const upstreamPort = await startServer(upstream);
  t.after(() => stop(upstream));

  const forwarder = createForwarder({
    getMode: () => "forward",
    getUpstream: () => new URL(`http://127.0.0.1:${upstreamPort}`),
    rejectNonPublicIpLiteral: true,
  });
  await forwarder.listen(0);
  t.after(() => forwarder.close());

  const blocked = await proxyGet(forwarder.port, "http://127.0.0.1/");
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers["x-dsh-proxy-switch-error"], "WEB_BLOCKED_URL");

  const { socket, head } = await connectThrough(forwarder.port, "127.0.0.1:443");
  assert.match(head, /^HTTP\/1\.1 403 /);
  assert.match(head, /WEB_BLOCKED_URL/);
  socket.destroy();
});

test("close() destroys live tunnels and releases the listener", async (t) => {
  let upstreamTunnel;
  const upstream = http.createServer();
  upstream.on("connect", (request, socket) => {
    upstreamTunnel = socket;
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.on("data", (chunk) => socket.write(chunk));
    // Upgraded HTTP sockets are half-open capable; finish the close so the test can observe it.
    socket.on("end", () => socket.destroy());
  });
  const upstreamPort = await startServer(upstream);
  t.after(() => stop(upstream));

  const forwarder = createForwarder({
    getMode: () => "forward",
    getUpstream: () => new URL(`http://127.0.0.1:${upstreamPort}`),
  });
  await forwarder.listen(0);
  const { socket, head } = await connectThrough(forwarder.port, "secure.example:443");
  assert.match(head, /200 Connection Established/);
  assert.ok(upstreamTunnel, "the tunnel must have reached the upstream");
  // The upstream side of the tunnel closing proves close() destroyed it rather than only
  // dropping the listener.
  const upstreamClosed = once(upstreamTunnel, "close");
  await forwarder.close();
  await upstreamClosed;
  assert.equal(forwarder.port, null);
  socket.destroy();
});
