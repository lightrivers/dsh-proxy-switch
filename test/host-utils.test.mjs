import test from "node:test";
import assert from "node:assert/strict";

import {
  appendWarning,
  createProxyOverrideEnvironment,
  failureResult,
  precheckWebFetch,
  strictTargetOf,
  webFetchUrlOf,
} from "../lib/host-utils.js";
import { warningFor } from "../lib/messages.js";

function launchEnvironment(values) {
  const map = new Map(Object.entries(values));
  return { get: (variable) => (map.has(variable) ? { value: map.get(variable), source: "user-env" } : void 0) };
}

test("the override environment points both schemes at the listener and preserves NO_PROXY", () => {
  const base = launchEnvironment({ HTTP_PROXY: "http://127.0.0.1:1082", NO_PROXY: "corp.example" });
  const environment = createProxyOverrideEnvironment(base, "http://127.0.0.1:7899");
  for (const variable of ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY"]) {
    assert.equal(environment.get(variable).value, "http://127.0.0.1:7899");
  }
  // The global scope is an explicit takeover of other modules; clearing NO_PROXY would
  // give child processes "original proxy + new bypass list". web_fetch is isolated in its
  // own provider, so preserving the list cannot let a web_fetch target escape the switch.
  assert.equal(environment.get("NO_PROXY").value, "corp.example");
  assert.equal(environment.get("all_proxy"), void 0);
  assert.equal(environment.get("ALL_PROXY"), void 0);
});

test("a refusal result is a well-formed ToolExecutionResult", () => {
  const result = failureResult("refused", "PROXY_SWITCH_FAKE_IP");
  assert.equal(result.isError, true);
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /^Error: refused/);
  assert.equal(result.error.info.code, "PROXY_SWITCH_FAKE_IP");
});

test("appendWarning keeps existing blocks and appends one paragraph", () => {
  const original = { isError: false, value: { ok: true }, content: [{ type: "text", text: "body" }] };
  const warning = warningFor({ mode: "forward", reachable: false, scope: "global" });
  const appended = appendWarning(original, warning, { mode: "forward", scope: "global" });
  assert.equal(appended.content.length, 2);
  assert.equal(appended.content[0].text, "body");
  assert.match(appended.content[1].text, /dsh-proxy-switch/);
  assert.match(appended.content[1].text, /上游代理不可用/);
  assert.equal(original.content.length, 1, "the input result must not be mutated");
  assert.equal(appended.value.ok, true);
});

test("appendWarning tolerates a result without content", () => {
  const appended = appendWarning({ isError: true }, warningFor({ mode: "direct", reachable: true }));
  assert.equal(appended.content.length, 1);
});

test("webFetchUrlOf reads the url argument shape", () => {
  assert.equal(webFetchUrlOf({ url: "https://example.com" }), "https://example.com");
  assert.equal(webFetchUrlOf({ href: "https://example.com" }), "https://example.com");
  assert.equal(webFetchUrlOf("https://example.com"), "https://example.com");
  assert.equal(webFetchUrlOf({}), void 0);
  assert.equal(webFetchUrlOf(null), void 0);
  assert.equal(webFetchUrlOf('{"url":"https://example.com/x"}'), "https://example.com/x");
  assert.equal(webFetchUrlOf("{not json"), "{not json");
});

test("precheck only inspects web_fetch URLs in direct mode", async () => {
  let asked = 0;
  const resolve = async () => {
    asked += 1;
    return { ok: false, code: "PROXY_SWITCH_FAKE_IP", message: "fake" };
  };
  assert.deepEqual(await precheckWebFetch({ mode: "forward", url: "https://example.com", resolve }), { action: "pass" });
  assert.deepEqual(await precheckWebFetch({ mode: "direct", url: void 0, resolve }), { action: "pass" });
  assert.deepEqual(await precheckWebFetch({ mode: "direct", url: "not a url", resolve }), { action: "pass" });
  assert.deepEqual(await precheckWebFetch({ mode: "direct", url: "data:text/plain,x", resolve }), { action: "pass" });
  assert.deepEqual(await precheckWebFetch({ mode: "direct", url: "file:///etc/hosts", resolve }), { action: "pass" });
  assert.equal(asked, 0);
});

test("precheck refuses a fake-IP destination with the resolver's message", async () => {
  const refusal = { ok: false, code: "PROXY_SWITCH_FAKE_IP", message: "目标解析到 fake-IP 地址 198.18.0.5。" };
  const check = await precheckWebFetch({
    mode: "direct",
    url: "https://example.com/page",
    resolve: async () => refusal,
  });
  assert.equal(check.action, "refuse");
  assert.equal(check.code, "PROXY_SWITCH_FAKE_IP");
  assert.match(check.message, /fake-IP/);
});

test("precheck passes a public destination in direct mode", async () => {
  const check = await precheckWebFetch({
    mode: "direct",
    url: "https://example.com/",
    resolve: async () => ({ ok: true, address: "93.184.216.34" }),
  });
  assert.deepEqual(check, { action: "pass" });
});

test("the refused result plus the warning form the model-facing text pair", () => {
  const refusal = failureResult("目标解析到 fake-IP。", "PROXY_SWITCH_FAKE_IP");
  const warning = warningFor({ mode: "direct", reachable: true, scope: "web_fetch_only" });
  const withWarning = appendWarning(refusal, warning, { mode: "direct", scope: "web_fetch_only" });
  assert.equal(withWarning.isError, true);
  assert.match(withWarning.content[0].text, /fake-IP/);
  assert.match(withWarning.content.at(-1).text, /代理客户端仍在运行/);
  assert.match(withWarning.content.at(-1).text, /Scope: web_fetch_only/);
});
