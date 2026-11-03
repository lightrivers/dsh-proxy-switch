/**
 * End-to-end routing check against a REAL upstream proxy.
 *
 * Runs the forwarder in this process on an ephemeral loopback port and drives it with
 * `curl -x`, so no Harness instance, policy install, or restart is involved.
 *
 * Usage: `node scripts/e2e-real.mjs [upstreamPort]`
 * Defaults to `127.0.0.1:1082`. Cases that need a live upstream or a fake-IP DNS
 * environment are skipped when that precondition is absent; runnable cases must pass.
 */
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { promisify } from "node:util";

import { createForwarder } from "../lib/forwarder.js";
import { classifyAddress } from "../lib/net-guard.js";

const run = promisify(execFile);
const upstreamPort = Number(process.argv[2] ?? 1082);

/** A TCP port can be open without being a usable HTTP proxy; probe one CONNECT. */
function probeForwardProxy(timeoutMs = 2_500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: upstreamPort });
    let buffered = "";
    const finish = (ok) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => {
      socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
    });
    socket.on("data", (chunk) => {
      buffered += chunk.toString("latin1");
      if (!buffered.includes("\r\n\r\n")) return;
      finish(Number((buffered.split(" ")[1] ?? "").trim()) === 200);
    });
    socket.once("error", () => finish(false));
  });
}
const upstream = new URL(`http://127.0.0.1:${upstreamPort}`);

let mode = "forward";
const routes = [];
const forwarder = createForwarder({
  getMode: () => mode,
  getUpstream: () => upstream,
  onResult: (entry) => {
    routes.push(entry);
    console.log("  route:", JSON.stringify(entry));
  },
});
await forwarder.listen(0);
const proxy = `http://127.0.0.1:${forwarder.port}`;
console.log(`forwarder ${proxy} -> upstream ${upstream.origin}\n`);

async function curl(target, extra = []) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await run(
      "curl",
      ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "12", "-x", proxy, ...extra, target],
      { timeout: 20_000 },
    );
    return { code: stdout.trim(), ms: Date.now() - started, stderr: stderr.trim() };
  } catch (error) {
    return { code: `ERR:${error.code ?? "?"}`, ms: Date.now() - started, stderr: String(error.stderr ?? error.message).trim() };
  }
}

const forwardWorks = await probeForwardProxy();
let fakeIp = false;
try {
  const records = await lookup("example.com", { all: true, verbatim: true });
  fakeIp = records.some((record) => classifyAddress(record.address).reason === "fake-ip");
} catch {
  fakeIp = false;
}
console.log(`upstream CONNECT works=${forwardWorks}; example.com fake-IP=${fakeIp}\n`);

const cases = [];
if (forwardWorks) {
  cases.push(
    {
      label: "forward  CONNECT https://example.com",
      mode: "forward",
      target: "https://example.com",
      extra: ["-k"],
      check: (result, route) => route?.status === 200,
    },
  );
}
if (fakeIp) {
  cases.push({
    label: "direct   CONNECT https://example.com (proxy still on -> fake-IP refused)",
    mode: "direct",
    target: "https://example.com",
    extra: ["-k"],
    check: (result, route) => route?.status === 403,
  });
}
cases.push({
  label: "direct   CONNECT https://1.1.1.1 (public literal, dialled directly)",
  mode: "direct",
  target: "https://1.1.1.1",
  extra: ["-k"],
  check: (result, route) => route?.status === 200 && (result.code === "200" || result.code === "301"),
});

if (!forwardWorks) console.log(`SKIP  forward cases: upstream ${upstream.origin} did not answer a CONNECT with 200.`);
if (!fakeIp) console.log("SKIP  direct fake-IP case: example.com does not resolve into 198.18.0.0/15 here.");

let failures = 0;
for (const item of cases) {
  mode = item.mode;
  const before = routes.length;
  const result = await curl(item.target, item.extra);
  const newRoutes = routes.slice(before);
  // Curl may close the connection after a redirect; the forwarder then also reports 499.
  // Prefer the successful route for the assertion.
  const route = newRoutes.find((entry) => entry.status === 200) ?? newRoutes.at(-1);
  const ok = item.check(result, route);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${item.label} -> curl=${result.code} route=${route?.status ?? "-"} (${result.ms}ms)${result.stderr ? ` | ${result.stderr.split("\n")[0]}` : ""}`);
}

// Upstream unreachable must answer promptly with a real error, not hang.
const deadRoutes = [];
const deadForwarder = createForwarder({
  getMode: () => "forward",
  getUpstream: () => new URL("http://127.0.0.1:1"),
  onResult: (entry) => deadRoutes.push(entry),
});
await deadForwarder.listen(0);
const deadProxy = `http://127.0.0.1:${deadForwarder.port}`;
const deadStarted = Date.now();
const dead = await run(
  "curl",
  ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", "-x", deadProxy, "https://example.com"],
  { timeout: 15_000 },
).catch((error) => ({ stdout: `ERR:${error.code ?? "?"}` }));
const deadMs = Date.now() - deadStarted;
const deadRoute = deadRoutes.at(-1);
const deadOk = deadRoute?.status === 502 && deadMs < 8_000;
if (!deadOk) failures += 1;
console.log(`${deadOk ? "PASS" : "FAIL"}  forward  upstream down -> curl=${dead.stdout.trim()} route=${deadRoute?.status ?? "-"} (${deadMs}ms, must be 502 and prompt)`);
await deadForwarder.close();

await forwarder.close();
console.log(`\n${failures === 0 ? "all cases passed" : `${failures} case(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
