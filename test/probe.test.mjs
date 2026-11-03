import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { createProbeLoop, probeUpstream } from "../lib/probe.js";

function startServer(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("probeUpstream detects a listening port", async (t) => {
  const server = net.createServer((socket) => socket.end());
  const port = await startServer(server);
  t.after(() => stopServer(server));
  const result = await probeUpstream(new URL(`http://127.0.0.1:${port}`));
  assert.equal(result.reachable, true);
  assert.equal(result.error, null);
  assert.equal(typeof result.latencyMs, "number");
});

test("probeUpstream reports an unreachable port instead of hanging", async () => {
  const server = net.createServer();
  const port = await startServer(server);
  await stopServer(server);
  const result = await probeUpstream(new URL(`http://127.0.0.1:${port}`), { timeoutMs: 500 });
  assert.equal(result.reachable, false);
  assert.equal(typeof result.error, "string");
});

test("probeUpstream honours the timeout for a black-hole address", async () => {
  const connectImpl = () => {
    const socket = new net.Socket();
    return socket;
  };
  const result = await probeUpstream(new URL("http://127.0.0.1:9"), { timeoutMs: 120, connectImpl });
  assert.equal(result.reachable, false);
  assert.equal(result.error, "timeout");
});

test("the probe loop reports an update and stops cleanly", async (t) => {
  const updates = [];
  let interval = 60_000;
  const loop = createProbeLoop({
    getUpstream: () => new URL("http://127.0.0.1:1082"),
    getIntervalMs: () => interval,
    onUpdate: (update) => updates.push(update),
    probeImpl: async () => ({ reachable: true, latencyMs: 3, error: null }),
  });
  t.after(() => loop.stop());
  loop.start();
  await loop.runNow();
  assert.equal(updates.length >= 1, true);
  assert.equal(updates.at(-1).reachable, true);
  assert.equal(typeof updates.at(-1).checkedAt, "number");
  loop.reschedule();
  loop.stop();
  assert.equal(updates.at(-1).reachable, true);
});

test("probeUpstream dials an IPv6 upstream without brackets", async (t) => {
  const server = net.createServer((socket) => socket.end());
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "::1", resolve);
    });
  } catch {
    t.skip("no IPv6 loopback on this machine");
    return;
  }
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const result = await probeUpstream(new URL(`http://[::1]:${port}`));
  assert.equal(result.reachable, true);
});
