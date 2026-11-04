import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";

import {
  detectUpstream,
  parseGsettingsValue,
  parseKioslaverc,
  parseScutilProxy,
  parseWindowsInternetSettings,
  parseWindowsProxyServer,
  proxiesFromEnvironment,
  readSystemProxy,
  upstreamUrl,
  verifyHttpProxy,
} from "../lib/detect.js";

const SCUTIL = `<dictionary> {
  ExceptionsList : <array> {
    0 : localhost
  }
  HTTPEnable : 1
  HTTPPort : 1082
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 1082
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 0
}`;

test("macOS scutil output yields the enabled HTTP(S) proxy once", () => {
  assert.deepEqual(parseScutilProxy(SCUTIL), ["http://127.0.0.1:1082"]);
  assert.deepEqual(parseScutilProxy(SCUTIL.replace(/Enable : 1/gu, "Enable : 0")), []);
  assert.deepEqual(parseScutilProxy(""), []);
});

test("Windows ProxyServer handles both single and per-protocol forms", () => {
  assert.deepEqual(parseWindowsProxyServer("127.0.0.1:7890"), ["http://127.0.0.1:7890"]);
  assert.deepEqual(parseWindowsProxyServer("http=127.0.0.1:10809;https=127.0.0.1:10809;socks=127.0.0.1:10808"), [
    "http://127.0.0.1:10809",
  ]);
  assert.deepEqual(parseWindowsProxyServer("socks=127.0.0.1:1080"), []);
  assert.deepEqual(parseWindowsProxyServer("http://proxy.lan:8080"), ["http://proxy.lan:8080"]);
  assert.deepEqual(parseWindowsProxyServer("garbage"), []);
});

test("Windows registry output is honoured only while ProxyEnable is 1", () => {
  const on = [
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
    "    ProxyEnable    REG_DWORD    0x1",
    "    ProxyServer    REG_SZ    127.0.0.1:7897",
  ].join("\r\n");
  assert.deepEqual(parseWindowsInternetSettings(on), ["http://127.0.0.1:7897"]);
  assert.deepEqual(parseWindowsInternetSettings(on.replace("0x1", "0x0")), []);
});

test("Linux GNOME and KDE settings are parsed", () => {
  assert.equal(parseGsettingsValue("'manual'\n"), "manual");
  assert.equal(parseGsettingsValue("7890\n"), "7890");
  const kde = "[General]\nfoo=1\n[Proxy Settings]\nProxyType=1\nhttpProxy=http://127.0.0.1 7890\nhttpsProxy=http://127.0.0.1:7890\n";
  assert.deepEqual(parseKioslaverc(kde), ["http://127.0.0.1:7890"]);
  assert.deepEqual(parseKioslaverc(kde.replace("ProxyType=1", "ProxyType=0")), []);
});

test("readSystemProxy picks the platform reader", async () => {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args].join(" "));
    if (file.endsWith("scutil")) return SCUTIL;
    if (file.endsWith("reg.exe")) return "    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    127.0.0.1:7890\n";
    if (args.includes("mode")) return "'manual'";
    if (args.includes("host")) return "'127.0.0.1'";
    if (args.includes("port")) return "2080";
    return null;
  };
  assert.deepEqual((await readSystemProxy({ platform: "darwin", run })).urls, ["http://127.0.0.1:1082"]);
  const windows = await readSystemProxy({ platform: "win32", run, env: { SystemRoot: "C:\\Windows" } });
  assert.deepEqual(windows.urls, ["http://127.0.0.1:7890"]);
  assert.ok(calls.some((call) => call.includes("reg.exe query")));
  const exists = async () => true;
  assert.deepEqual((await readSystemProxy({ platform: "linux", run, env: {}, exists })).urls, ["http://127.0.0.1:2080"]);
  assert.deepEqual((await readSystemProxy({ platform: "aix", run })).urls, []);
});

test("environment proxies keep only http:// values", () => {
  const env = { HTTPS_PROXY: "http://user:pw@127.0.0.1:7890", ALL_PROXY: "socks5://127.0.0.1:7891", http_proxy: "not a url" };
  assert.deepEqual(proxiesFromEnvironment((name) => env[name]), ["http://user:pw@127.0.0.1:7890"]);
});

test("upstreamUrl brackets IPv6 and refuses bad ports", () => {
  assert.equal(upstreamUrl("::1", 7890), "http://[::1]:7890");
  assert.equal(upstreamUrl("127.0.0.1", "0"), null);
  assert.equal(upstreamUrl("", 7890), null);
});

/** A fake listener that answers the first line with a fixed response. */
async function fakeServer(t, reply) {
  const server = createServer((socket) => {
    socket.once("data", () => {
      if (reply !== null) socket.end(reply);
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("verifyHttpProxy classifies proxy, auth proxy, web server, and silence", async (t) => {
  const proxy = await fakeServer(t, "HTTP/1.1 200 Connection established\r\n\r\n");
  const auth = await fakeServer(t, "HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
  const web = await fakeServer(t, "HTTP/1.1 400 Bad Request\r\n\r\n");
  const ssh = await fakeServer(t, "SSH-2.0-OpenSSH_9.0\r\n");
  assert.equal((await verifyHttpProxy(proxy)).kind, "proxy");
  assert.equal((await verifyHttpProxy(auth)).kind, "proxy-auth");
  assert.equal((await verifyHttpProxy(web)).kind, "http");
  assert.equal((await verifyHttpProxy(ssh)).kind, "none");
  const silent = await fakeServer(t, null);
  assert.equal((await verifyHttpProxy(silent, { timeoutMs: 200 })).kind, "none");
  assert.equal((await verifyHttpProxy("http://127.0.0.1:1", { timeoutMs: 500 })).kind, "none");
});

test("detectUpstream prefers the system setting, then the environment, then a scan", async () => {
  const verdicts = new Map([
    ["http://127.0.0.1:1082", { kind: "proxy" }],
    ["http://127.0.0.1:7890", { kind: "proxy" }],
    ["http://127.0.0.1:6152", { kind: "http" }],
    ["http://127.0.0.1:7897", { kind: "proxy" }],
  ]);
  const verify = async (url) => ({ latencyMs: 1, ...(verdicts.get(url) ?? { kind: "none" }) });

  const system = await detectUpstream({
    readSystem: async () => ({ reader: "scutil", urls: ["http://127.0.0.1:1082"] }),
    getEnv: () => void 0,
    verify,
  });
  // An explicitly configured proxy must still answer 200/407 like any other candidate.
  assert.equal(system.found.url, "http://127.0.0.1:1082");
  assert.equal(system.found.source, "system");

  const environment = await detectUpstream({
    readSystem: async () => ({ reader: "scutil", urls: [] }),
    getEnv: (name) => (name === "HTTPS_PROXY" ? "http://127.0.0.1:7897" : void 0),
    verify,
  });
  assert.equal(environment.found.source, "environment");

  const scan = await detectUpstream({
    readSystem: async () => ({ reader: "scutil", urls: [] }),
    getEnv: () => void 0,
    commonPorts: [6152, 7890],
    verify,
  });
  // A scanned port must prove it is a proxy: 6152 answered like a web server.
  assert.equal(scan.found.url, "http://127.0.0.1:7890");
  assert.equal(scan.found.source, "scan");

  const none = await detectUpstream({ readSystem: async () => ({ urls: [] }), getEnv: () => void 0, commonPorts: [1], verify });
  assert.equal(none.found, null);
  assert.equal(none.tried.length, 1);
});

test("detectUpstream never offers the plugin's own ports", async () => {
  const seen = [];
  const verify = async (url) => {
    seen.push(url);
    return { kind: "proxy", latencyMs: 1 };
  };
  const result = await detectUpstream({
    readSystem: async () => ({ reader: "scutil", urls: ["http://127.0.0.1:7899"] }),
    getEnv: (name) => (name === "HTTP_PROXY" ? "http://localhost:53000" : void 0),
    excludePorts: [7899, 53000],
    commonPorts: [7899, 7890],
    verify,
  });
  assert.equal(result.found.url, "http://127.0.0.1:7890");
  assert.deepEqual(seen, ["http://127.0.0.1:7890"]);
});

test("F5: a system or environment candidate that only answers a status line is not adopted", async () => {
  const verify = async (url) => {
    if (url === "http://127.0.0.1:1082") return { kind: "http", status: 404, latencyMs: 1 };
    if (url === "http://127.0.0.1:7890") return { kind: "proxy", latencyMs: 1 };
    return { kind: "none", latencyMs: 1 };
  };
  const result = await detectUpstream({
    readSystem: async () => ({ reader: "scutil", urls: ["http://127.0.0.1:1082"] }),
    getEnv: (name) => (name === "HTTPS_PROXY" ? "http://127.0.0.1:7890" : void 0),
    verify,
  });
  assert.equal(result.found.url, "http://127.0.0.1:7890");
  assert.equal(result.tried.find((entry) => entry.url === "http://127.0.0.1:1082").kind, "http");

  const none = await detectUpstream({
    readSystem: async () => ({ reader: "scutil", urls: ["http://127.0.0.1:1082"] }),
    getEnv: () => void 0,
    commonPorts: [],
    verify,
  });
  assert.equal(none.found, null);
});

test("F9: the plugin's own ports are excluded in every spelling, including local names", async () => {
  const seen = [];
  const verify = async (url) => {
    seen.push(url);
    return { kind: "proxy", latencyMs: 1 };
  };
  const lookupFn = async (host) => {
    if (host === "my-mac.local") return [{ address: "127.0.0.1", family: 4 }];
    const error = new Error("ENOTFOUND");
    error.code = "ENOTFOUND";
    throw error;
  };
  const result = await detectUpstream({
    readSystem: async () => ({
      reader: "scutil",
      urls: ["http://localhost.:7899", "http://[::ffff:127.0.0.1]:53000", "http://127.1:53001"],
    }),
    getEnv: (name) => (name === "HTTP_PROXY" ? "http://my-mac.local:53000" : void 0),
    excludePorts: [7899, 53000, 53001],
    commonPorts: [7890],
    lookupFn,
    verify,
  });
  assert.equal(result.found.url, "http://127.0.0.1:7890");
  assert.deepEqual(seen, ["http://127.0.0.1:7890"], "no self spelling may even be verified");
});

test("F18: configuration readers never take their executable from PATH or an untrusted SystemRoot", async () => {
  const runCalls = [];
  const run = async (file, args) => {
    runCalls.push([file, ...args].join(" "));
    if (args.includes("mode")) return "'manual'";
    if (args.includes("host")) return "'127.0.0.1'";
    if (args.includes("port")) return "2080";
    return null;
  };
  const exists = async (path) => path === "/usr/bin/gsettings";
  const linux = await readSystemProxy({ platform: "linux", run, env: {}, exists });
  assert.deepEqual(linux.urls, ["http://127.0.0.1:2080"]);
  assert.ok(runCalls.every((call) => call.startsWith("/usr/bin/gsettings")), runCalls.join(" | "));

  for (const SystemRoot of ["attacker-controlled", "\\server\\share", "Windows", "C:\\Windows\\..\\evil"]) {
    const winCalls = [];
    const winRun = async (file) => {
      winCalls.push(file);
      return "";
    };
    await readSystemProxy({ platform: "win32", run: winRun, env: { SystemRoot } });
    assert.equal(winCalls.length, 1);
    assert.match(winCalls[0], /^[A-Za-z]:\\Windows\\System32\\reg\.exe$/u, `${SystemRoot} -> ${winCalls[0]}`);
  }
});
