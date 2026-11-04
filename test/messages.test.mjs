import test from "node:test";
import assert from "node:assert/strict";

import {
  WARNING_AUTO_PROXY_NOT_FOUND,
  WARNING_DIRECT_WITH_UPSTREAM,
  WARNING_FORWARD_WITHOUT_UPSTREAM,
  effectiveModeOf,
  warningFor,
  warningParagraph,
} from "../lib/messages.js";

test("direct + reachable upstream warns about the still-running proxy client", () => {
  const warning = warningFor({ mode: "direct", reachable: true });
  assert.equal(warning.code, WARNING_DIRECT_WITH_UPSTREAM);
  assert.match(warning.zh, /代理客户端仍在运行/);
  assert.match(warning.zh, /fake-IP/);
  assert.match(warning.en, /proxy client is still running/i);
});

test("forward + unreachable upstream warns that every request will fail", () => {
  const warning = warningFor({ mode: "forward", reachable: false });
  assert.equal(warning.code, WARNING_FORWARD_WITHOUT_UPSTREAM);
  assert.match(warning.zh, /上游代理不可用/);
  assert.match(warning.en, /upstream proxy is unreachable/i);
});

test("healthy combinations produce no warning", () => {
  assert.equal(warningFor({ mode: "direct", reachable: false }), null);
  assert.equal(warningFor({ mode: "forward", reachable: true }), null);
  assert.equal(warningFor({ mode: "direct", reachable: null }), null);
  assert.equal(warningFor({ mode: "forward", reachable: null }), null);
});

test("the warning paragraph carries a stable plugin prefix and next steps", () => {
  const warning = warningFor({ mode: "direct", reachable: true });
  const text = warningParagraph(warning, { mode: "direct", upstream: "http://127.0.0.1:1082" });
  assert.match(text, /^\[dsh-proxy-switch\]/);
  assert.match(text, /处理建议/);
  assert.match(text, /http:\/\/127\.0\.0\.1:1082/);
});

test("web_fetch_only warnings do not overclaim that every module fails", () => {
  const direct = warningFor({ mode: "direct", reachable: true, scope: "web_fetch_only" });
  assert.equal(direct.code, WARNING_DIRECT_WITH_UPSTREAM);
  assert.match(direct.zh, /web_fetch/);
  assert.match(direct.zh, /其它模块保持原出站路径/);
  assert.match(direct.en, /web_fetch/);
  assert.match(direct.en, /other modules keep their original outbound path/i);

  const forward = warningFor({ mode: "forward", reachable: false, scope: "web_fetch_only" });
  assert.equal(forward.code, WARNING_FORWARD_WITHOUT_UPSTREAM);
  assert.match(forward.zh, /web_fetch 会失败/);
  assert.match(forward.zh, /其它模块保持原出站路径/);
  assert.match(forward.en, /other modules keep their original outbound path/i);
});

test("global scope keeps the original all-outbound wording", () => {
  const direct = warningFor({ mode: "direct", reachable: true, scope: "global" });
  assert.match(direct.zh, /抓取已按策略拒绝/);
  const forward = warningFor({ mode: "forward", reachable: false, scope: "global" });
  assert.match(forward.zh, /所有出站请求都会失败/);
});

test("the warning paragraph names the scope", () => {
  const warning = warningFor({ mode: "direct", reachable: true, scope: "web_fetch_only" });
  const text = warningParagraph(warning, { mode: "direct", scope: "web_fetch_only", upstream: "http://127.0.0.1:1082" });
  assert.match(text, /策略范围 \/ Scope: web_fetch_only/);
  assert.match(text, /web_fetch 严格/);
});

test("auto follows the probe and never forwards on an unknown probe", () => {
  assert.equal(effectiveModeOf("auto", true), "forward");
  assert.equal(effectiveModeOf("auto", false), "direct");
  assert.equal(effectiveModeOf("auto", null), "direct");
  assert.equal(effectiveModeOf("forward", false), "forward");
  assert.equal(effectiveModeOf("direct", true), "direct");
});

test("auto has no mismatch warning, only the fake-IP-without-port one", () => {
  for (const reachable of [true, false, null]) assert.equal(warningFor({ mode: "auto", reachable }), null);
  const warning = warningFor({ mode: "auto", reachable: false, fakeIpSeen: true, scope: "web_fetch_only" });
  assert.equal(warning.code, WARNING_AUTO_PROXY_NOT_FOUND);
  assert.match(warning.zh, /fake-IP/);
  assert.match(warning.actionZh, /手动填写/);
  assert.equal(warningFor({ mode: "auto", reachable: true, fakeIpSeen: true }), null);
});
