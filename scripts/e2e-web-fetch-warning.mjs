/**
 * Reproduce the exact `web_fetch` text produced when `direct` mode refuses a fake-IP target.
 *
 * Why a script instead of a live session: the refusal is correct precisely because the TUN
 * proxy client is still running, and that same state would break the model request that has
 * to read the result — historically true because the refusal applied to every outbound
 * request. With the default `scope = web_fetch_only` other modules keep their original
 * transport, so the live UX is verified by `scripts/e2e-host.mjs`; this script still pins the
 * exact model-facing text using the same pure functions the Host wrapper calls:
 * `precheckWebFetch` → `failureResult` → `warningFor` → `appendWarning`.
 *
 * Usage: `node scripts/e2e-web-fetch-warning.mjs [url]`
 * Requires the environment it is describing: mode = direct, upstream proxy running, DNS
 * answering with a fake-IP address. Prints the DNS answer first, so the precondition is visible.
 */
import { lookup } from "node:dns/promises";

import { appendWarning, failureResult, precheckWebFetch } from "../lib/host-utils.js";
import { warningFor } from "../lib/messages.js";
import { classifyAddress, resolveDirectTarget } from "../lib/net-guard.js";
import { maskUpstream } from "../lib/state.js";

const url = process.argv[2] ?? "https://example.com/";
const upstream = maskUpstream("http://127.0.0.1:1082");
const hostname = new URL(url).hostname;

const records = await lookup(hostname, { all: true, verbatim: true });
const verdicts = records.map((record) => ({ ...record, ...classifyAddress(record.address) }));
console.log(`DNS ${hostname} =>`);
for (const verdict of verdicts) console.log(`  ${verdict.address}  public=${verdict.public}  reason=${verdict.reason}`);
const fakeIp = verdicts.some((verdict) => verdict.reason === "fake-ip");
console.log(fakeIp ? "=> fake-IP present: this environment CAN reproduce the direct-mode refusal." : "=> no fake-IP: this environment will NOT reproduce the refusal (proxy client is off).");

/** Mirror of the Host `tools/execute` wrapper body, with the same imports the Host uses. */
async function simulateWebFetch({ mode, scope, reachable }) {
  const warning = warningFor({ mode, scope, reachable });
  const check = await precheckWebFetch({ mode, url, resolve: resolveDirectTarget });
  if (check.action === "refuse") {
    const refusal = failureResult(check.message, check.code);
    return warning === null ? refusal : appendWarning(refusal, warning, { mode, scope, upstream });
  }
  return { action: "pass", note: "the wrapper would call next() and append a warning only if one exists", warning };
}

function render(result) {
  if (result.action === "pass") return `  (pass through) warning=${result.warning === null ? "none" : result.warning.code}`;
  const lines = [];
  lines.push(`  isError: ${result.isError}`);
  lines.push(`  error.info.code: ${result.error?.info?.code}`);
  lines.push(`  content blocks: ${result.content.length}`);
  for (const [index, block] of result.content.entries()) {
    lines.push(`  --- block[${index}] (${block.type}) ---`);
    for (const line of String(block.text).split("\n")) lines.push(`  | ${line}`);
  }
  return lines.join("\n");
}

const cases = [
  ["A. mode=direct, scope=web_fetch_only (default), upstream reachable", { mode: "direct", scope: "web_fetch_only", reachable: true }],
  ["B. mode=direct, scope=global, upstream reachable (previous behaviour)", { mode: "direct", scope: "global", reachable: true }],
  ["C. mode=forward, upstream reachable (healthy)", { mode: "forward", scope: "web_fetch_only", reachable: true }],
  ["D. mode=forward, scope=web_fetch_only, upstream unreachable", { mode: "forward", scope: "web_fetch_only", reachable: false }],
  ["E. mode=forward, scope=global, upstream unreachable", { mode: "forward", scope: "global", reachable: false }],
];

for (const [label, input] of cases) {
  console.log(`\n=== ${label} ===`);
  console.log(render(await simulateWebFetch(input)));
}
