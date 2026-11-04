/**
 * Destination classification and resolution for `dsh-proxy-switch`.
 *
 * This module owns the SSRF decision for the `direct` transport. It is deliberately
 * byte-oriented instead of regex-oriented: the previous version missed
 * `0:0:0:0:0:ffff:7f00:1` because it only recognised a few compressed IPv4-mapped
 * spellings, and it could not express RFC 6052 NAT64 prefixes discovered at runtime.
 *
 * Policy is split into two groups so the security claims stay honest:
 *
 * 1. `RULES_V4` / `RULES_V6` — special-purpose space that must never be dialled
 *    directly. This list is intentionally conservative: a few globally reachable
 *    special-purpose blocks (AMT, AS112, ORCHIDv2, …) are still blocked because
 *    `ipaddr.js`'s `range()` also classifies them as non-`unicast`, which is what the
 *    upstream provider uses. The one deliberate divergence is `100:0:0:1::/64`
 *    (IANA Dummy IPv6 Prefix, Globally Reachable=False), which the upstream
 *    `ipaddr.js` release still calls `unicast`; this plugin blocks it.
 * 2. NAT64 — fixed well-known prefixes are covered by rule 1; network-specific
 *    prefixes are discovered with RFC 7050 (`ipv4only.arpa`) and each IPv6 answer is
 *    checked for a private embedded IPv4 destination (RFC 6052).
 *
 * `198.18.0.0/15` is called out separately from other non-public ranges because it is
 * the fake-IP block a TUN/fake-IP proxy client hands out while it is still running.
 */
import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * IPv4 special-purpose space that must never be dialled directly.
 *
 * From the IANA IPv4 Special-Purpose Address Registry. Only ranges whose
 * "Globally Reachable" column is false are listed.
 */
const RULES_V4 = [
  ["0.0.0.0", 8, "unspecified"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "carrier-grade-nat"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "ietf-protocol"],
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "6to4-relay"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "fake-ip"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];

/**
 * IPv6 special-purpose space that must never be dialled directly.
 *
 * `2001::/23` covers the IANA IETF Protocol Assignments block. `ipaddr.js` classifies
 * every sub-block it knows about there as non-`unicast` (`amt`, `benchmarking`,
 * `orchid2`, `droneRemoteIdProtocolEntityTags`, `as112v6`, `teredo`, `reserved`), so
 * this conservative rule matches the upstream provider's outcome while keeping the
 * implementation simple. `100:0:0:1::/64` is the one block where this plugin is
 * stricter than the upstream `ipaddr.js` release (IANA already marks it non-global).
 *
 * `64:ff9b::/96` and `64:ff9b:1::/48` are also blocked here because `ipaddr.js`
 * classifies them `rfc6052` (non-`unicast`); a network-specific NAT64 prefix that
 * `ipaddr.js` would call `unicast` is handled by {@link judgeAddresses}.
 */
const RULES_V6 = [
  ["::", 128, "unspecified"],
  ["::1", 128, "loopback"],
  ["64:ff9b::", 96, "nat64"],
  ["64:ff9b:1::", 48, "nat64-local"],
  ["100::", 64, "discard-only"],
  ["100:0:0:1::", 64, "dummy-prefix"],
  ["2001::", 23, "ietf-protocol"],
  ["2001:db8::", 32, "documentation"],
  ["2002::", 16, "6to4"],
  ["2620:4f:8000::", 48, "as112"],
  ["3fff::", 20, "documentation"],
  ["5f00::", 16, "srv6-sid"],
  ["fc00::", 7, "unique-local"],
  ["fe80::", 10, "link-local"],
  ["fec0::", 10, "site-local"],
  ["ff00::", 8, "multicast"],
];

function compile(rules, type) {
  return rules.map(([network, prefix, reason]) => {
    const list = new BlockList();
    list.addSubnet(network, prefix, type);
    return { list, reason };
  });
}

const COMPILED_V4 = compile(RULES_V4, "ipv4");
const COMPILED_V6 = compile(RULES_V6, "ipv6");

/** RFC 6052 prefix lengths that may carry an IPv4 destination through NAT64. */
const RFC6052_PREFIX_LENGTHS = [32, 40, 48, 56, 64, 96];
const IPV4ONLY_DISCOVERY_HOST = "ipv4only.arpa";
const IPV4ONLY_SENTINELS = new Set(["192.0.0.170", "192.0.0.171"]);

/** Strip the brackets and any `%zone` suffix an IPv6 literal may carry. */
export function unbracket(hostname) {
  return String(hostname).replace(/^\[|\]$/g, "").replace(/%.*$/u, "");
}

/** Return the hostname form a socket/HTTP option can dial (never bracketed). */
export function dialHostname(hostname) {
  return unbracket(hostname);
}

function parseIpv4Bytes(text) {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

function parseIpv6Bytes(text) {
  let address = text;
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    if (lastColon === -1) return null;
    const ipv4 = parseIpv4Bytes(address.slice(lastColon + 1));
    if (ipv4 === null) return null;
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    address = `${address.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : halves[0].split(":");
  const right = halves.length === 2 ? (halves[1] === "" ? [] : halves[1].split(":")) : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const fill = 8 - left.length - right.length;
  if (fill < 0 || (halves.length === 2 && fill < 1 && left.length + right.length !== 8)) return null;
  const groups = [...left, ...new Array(fill).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/u.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

/** Parse any textual IP into bytes; `null` when it is not an address. */
export function parseIpBytes(input) {
  const text = unbracket(input);
  const family = isIP(text);
  if (family === 4) return parseIpv4Bytes(text);
  if (family === 6) return parseIpv6Bytes(text);
  return null;
}

function formatIpv4(bytes) {
  return bytes.join(".");
}

function formatIpv6(bytes) {
  const groups = [];
  for (let index = 0; index < 16; index += 2) groups.push(((bytes[index] << 8) | bytes[index + 1]).toString(16));
  return groups.join(":");
}

/** True for the IPv4-mapped block (`::ffff:0:0/96`): 10 zero bytes then `ff ff`. */
function isMappedBytes(bytes) {
  if (bytes.length !== 16) return false;
  for (let index = 0; index < 10; index += 1) if (bytes[index] !== 0) return false;
  return bytes[10] === 255 && bytes[11] === 255;
}

/** True for the IPv4-translated block (`::ffff:0:0:0/96`, RFC 6145). */
function isTranslatedBytes(bytes) {
  if (bytes.length !== 16) return false;
  for (let index = 0; index < 8; index += 1) if (bytes[index] !== 0) return false;
  return bytes[8] === 255 && bytes[9] === 255 && bytes[10] === 0 && bytes[11] === 0;
}

/** True for the deprecated IPv4-compatible block (`::/96`). */
function isCompatibleBytes(bytes) {
  if (bytes.length !== 16) return false;
  for (let index = 0; index < 12; index += 1) if (bytes[index] !== 0) return false;
  return true;
}

function classifyBytes(bytes, original) {
  if (bytes.length === 4) {
    for (const rule of COMPILED_V4) {
      if (rule.list.check(formatIpv4(bytes), "ipv4")) {
        return { public: false, reason: rule.reason, address: original };
      }
    }
    return { public: true, reason: "public", address: original };
  }

  if (isMappedBytes(bytes)) {
    const inner = classifyBytes(bytes.slice(12, 16), formatIpv4(bytes.slice(12, 16)));
    return { ...inner, address: original, mapped: true };
  }
  if (isTranslatedBytes(bytes)) {
    return { public: false, reason: "ipv4-translated", address: original };
  }
  if (isCompatibleBytes(bytes) && !(bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0 && bytes[15] <= 1)) {
    // `::1.2.3.4` is the deprecated IPv4-compatible form. `ipaddr.js` treats it as an
    // IPv4-mapped address, so judge the embedded IPv4 instead of blanket-blocking `::/96`.
    const inner = classifyBytes(bytes.slice(12, 16), formatIpv4(bytes.slice(12, 16)));
    return { ...inner, address: original, mapped: true };
  }

  const text = formatIpv6(bytes);
  for (const rule of COMPILED_V6) {
    if (rule.list.check(text, "ipv6")) return { public: false, reason: rule.reason, address: original };
  }
  return { public: true, reason: "public", address: original };
}

/**
 * Return the embedded IPv4 text of an IPv4-mapped (or deprecated compatible) address.
 *
 * The old regex implementation missed expanded spellings such as
 * `0:0:0:0:0:ffff:7f00:1`. This version parses bytes, so every equivalent spelling
 * yields the same answer. IPv4-translated addresses return `null` because they are
 * refused as a class (matching `ipaddr.js`'s `rfc6145` range).
 */
export function mappedIpv4(input) {
  const bytes = parseIpBytes(input);
  if (bytes === null || bytes.length !== 16) return null;
  if (isMappedBytes(bytes) || isCompatibleBytes(bytes)) return formatIpv4(bytes.slice(12, 16));
  return null;
}

/**
 * Classify one textual IP address.
 *
 * @param input - IPv4 or IPv6 text, optionally bracketed.
 * @returns `{ public, reason, address }`; `reason` is the first matching range name.
 */
export function classifyAddress(input) {
  const address = unbracket(input);
  const family = isIP(address);
  if (family === 0) return { public: false, reason: "not-an-ip", address };
  const bytes = family === 4 ? parseIpv4Bytes(address) : parseIpv6Bytes(address);
  if (bytes === null) return { public: false, reason: "not-an-ip", address };
  return classifyBytes(bytes, address);
}

/** True when the text is a fake-IP (198.18.0.0/15) destination. */
export function isFakeIp(input) {
  return classifyAddress(input).reason === "fake-ip";
}

/** True when the text is an IP literal rather than a hostname. */
export function isIpLiteral(input) {
  return isIP(unbracket(input)) !== 0;
}

/**
 * Extract one IPv4 address from an RFC 6052 IPv6 layout.
 *
 * Mirrors the upstream provider's `embeddedIpv4Address`: for `/96` the last four
 * bytes; for shorter prefixes the bytes after the prefix and the reserved u-octet.
 */
function embeddedIpv4Bytes(bytes, prefixLength) {
  if (prefixLength === 96) return bytes.slice(12, 16);
  if (bytes[8] !== 0) return null;
  const prefixBytes = prefixLength / 8;
  const beforeReservedOctet = 8 - prefixBytes;
  return [...bytes.slice(prefixBytes, prefixBytes + beforeReservedOctet), ...bytes.slice(9, 13 - beforeReservedOctet)];
}

/**
 * Discover the active DNS64 prefix set with RFC 7050's reserved hostname.
 *
 * @param options.lookupFn - DNS implementation, overridden by tests.
 * @returns `[{ bytes, length }]`; an empty list when no DNS64 answer exists.
 */
export async function discoverNat64Prefixes(options = {}) {
  const lookupFn = options.lookupFn ?? lookup;
  let records;
  try {
    records = await lookupFn(IPV4ONLY_DISCOVERY_HOST, { all: true, verbatim: true });
  } catch {
    return [];
  }
  const prefixes = [];
  const seen = new Set();
  for (const record of records) {
    if (record.family !== 6) continue;
    const bytes = parseIpv6Bytes(record.address);
    if (bytes === null) continue;
    for (const length of RFC6052_PREFIX_LENGTHS) {
      const embedded = embeddedIpv4Bytes(bytes, length);
      if (embedded === null || !IPV4ONLY_SENTINELS.has(formatIpv4(embedded))) continue;
      const prefixBytes = bytes.slice(0, length / 8);
      const key = `${length}:${prefixBytes.join(".")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      prefixes.push({ bytes: prefixBytes, length });
    }
  }
  return prefixes;
}

/** Return the RFC 6052-embedded IPv4 address when an IPv6 address matches a prefix. */
function translatedIpv4Bytes(bytes, prefixes) {
  if (bytes.length !== 16) return null;
  for (const prefix of prefixes) {
    if (!prefix.bytes.every((byte, index) => bytes[index] === byte)) continue;
    const embedded = embeddedIpv4Bytes(bytes, prefix.length);
    if (embedded !== null) return embedded;
  }
  return null;
}

/** Machine code for every malformed authority this module refuses. */
export const INVALID_AUTHORITY_CODE = "PROXY_SWITCH_INVALID_AUTHORITY";

/**
 * Strictly parse a proxy authority (`CONNECT` request-target or URL authority).
 *
 * `splitAuthority` below is deliberately tolerant because it feeds display strings and
 * statistics. A connection must never use it: `Number("notaport")` is `NaN`, and passing
 * that to `net.connect()` throws `ERR_SOCKET_BAD_PORT` from inside an event handler —
 * an uncaught exception that can terminate the Host process.
 *
 * Accepted forms are `hostname[:1-65535]` and `[ipv6][:1-65535]`. A missing port keeps
 * the historical default (80 for `CONNECT`).
 *
 * @param authority - the raw request-target.
 * @param options.defaultPort - port used when the authority omits one.
 * @returns `{ ok: true, host, port }` or `{ ok: false, code, message }`.
 */
export function parseAuthority(authority, options = {}) {
  const defaultPort = options.defaultPort ?? 80;
  const fail = (zh, en) => ({
    ok: false,
    code: INVALID_AUTHORITY_CODE,
    message: `代理请求的目标地址不合法：${zh} Proxy target authority is invalid: ${en}`,
  });
  if (typeof authority !== "string") return fail("目标地址不是字符串。", "the authority is not a string.");
  const text = authority;
  if (text === "") return fail("目标地址为空。", "the authority is empty.");
  if (/\s/u.test(text) || /[\u0000-\u001f\u007f]/u.test(text)) {
    return fail("目标地址包含空白或控制字符。", "the authority contains whitespace or control characters.");
  }

  let host;
  let portText = null;
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close === -1) return fail("IPv6 方括号未闭合。", "the IPv6 bracket is not closed.");
    host = text.slice(1, close);
    if (host === "") return fail("IPv6 主机为空。", "the IPv6 host is empty.");
    if (isIP(host) !== 6) return fail("方括号内不是合法 IPv6 地址。", "the bracketed host is not a valid IPv6 address.");
    const rest = text.slice(close + 1);
    if (rest !== "") {
      if (!rest.startsWith(":")) {
        return fail("IPv6 方括号后存在多余字符。", "the authority has extra characters after the IPv6 bracket.");
      }
      portText = rest.slice(1);
      if (portText === "") return fail("端口为空。", "the port is empty.");
    }
  } else {
    if (text.includes("[") || text.includes("]")) {
      return fail("方括号位置不合法。", "the brackets are in an invalid position.");
    }
    if (isIP(text) === 6) {
      host = text;
    } else {
      const colon = text.lastIndexOf(":");
      if (colon === -1) {
        host = text;
      } else {
        host = text.slice(0, colon);
        portText = text.slice(colon + 1);
        if (host.includes(":")) return fail("IPv6 地址必须用方括号括起来。", "an IPv6 address must be bracketed.");
        if (portText === "") return fail("端口为空。", "the port is empty.");
      }
    }
  }

  if (host === "") return fail("主机名为空。", "the host is empty.");
  if (/[\s/\\@?#%]/u.test(host)) return fail("主机名包含非法字符。", "the host contains illegal characters.");
  if (isIP(host) === 0) {
    if (host.length > 253) return fail("主机名过长。", "the host is longer than 253 characters.");
    if (!/^[A-Za-z0-9._-]+$/u.test(host)) return fail("主机名包含非法字符。", "the host contains illegal characters.");
    if (host.startsWith(".") || host.includes("..")) {
      return fail("主机名格式不合法。", "the host is not a valid hostname.");
    }
  }

  let port;
  if (portText === null) {
    port = defaultPort;
  } else {
    if (!/^[0-9]{1,5}$/u.test(portText)) {
      return fail(`端口 "${portText}" 不是 1–65535 的十进制整数。`, `the port "${portText}" is not a decimal integer in 1–65535.`);
    }
    port = Number(portText);
    if (port < 1 || port > 65_535) return fail(`端口 ${port} 超出 1–65535。`, `the port ${port} is outside 1–65535.`);
  }
  return { ok: true, host, port };
}

/** Render one host/port pair in the bracketed form a `CONNECT` request line requires. */
export function formatAuthority(host, port) {
  const bare = unbracket(host);
  return isIP(bare) === 6 ? `[${bare}]:${port}` : `${bare}:${port}`;
}

/**
 * Split a `host:port` authority, tolerating bracketed IPv6.
 *
 * Display only. It returns `NaN` for a malformed port on purpose (no throwing), so a
 * statistics label can still be printed; every connection path must use
 * {@link parseAuthority} instead.
 */
export function splitAuthority(authority) {
  const text = String(authority);
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close === -1) return { host: text, port: 80 };
    const host = text.slice(1, close);
    const rest = text.slice(close + 1);
    return { host, port: rest.startsWith(":") ? Number(rest.slice(1)) : 80 };
  }
  const colon = text.lastIndexOf(":");
  if (colon === -1) return { host: text, port: 80 };
  return { host: text.slice(0, colon), port: Number(text.slice(colon + 1)) };
}

/**
 * Resolve a destination hostname to its complete address set.
 *
 * @param hostname - URL hostname or authority host, bracketed IPv6 allowed.
 * @param options.lookupFn - DNS implementation, overridden by tests.
 * @returns `{ literal, addresses: [{ address, family }] }`.
 */
export async function resolveHost(hostname, options = {}) {
  const host = unbracket(hostname);
  const literalFamily = isIP(host);
  if (literalFamily !== 0) {
    return { literal: true, addresses: [{ address: host, family: literalFamily }] };
  }
  const lookupFn = options.lookupFn ?? lookup;
  const records = await lookupFn(host, { all: true, verbatim: true });
  return {
    literal: false,
    addresses: records.map((entry) => ({ address: entry.address, family: entry.family })),
  };
}

/**
 * Decide whether a whole resolved answer set may be connected to directly.
 *
 * Every address must be public: one private or fake-IP answer is enough to refuse,
 * which also closes the multi-record rebinding window. A network-specific NAT64
 * prefix is checked separately because the IPv6 address itself can be globally
 * routable while the embedded IPv4 destination is a loopback or private service.
 *
 * @param hostname - the destination that produced the answers, for the message.
 * @param addresses - the complete resolved set.
 * @param options.nat64Prefixes - discovered RFC 7050 prefixes.
 * @returns a verdict with an explicit, user-facing message on refusal.
 */
export function judgeAddresses(hostname, addresses, options = {}) {
  if (addresses.length === 0) {
    return {
      ok: false,
      code: "PROXY_SWITCH_DNS_EMPTY",
      message: `直连模式下无法解析目标主机 ${hostname}（没有返回任何地址）。Direct mode could not resolve ${hostname} to any address.`,
    };
  }
  const nat64Prefixes = options.nat64Prefixes ?? [];
  const verdicts = addresses.map((entry) => {
    const verdict = classifyAddress(entry.address);
    if (verdict.public && nat64Prefixes.length > 0) {
      const bytes = parseIpBytes(entry.address);
      if (bytes !== null && bytes.length === 16) {
        const embedded = translatedIpv4Bytes(bytes, nat64Prefixes);
        if (embedded !== null) {
          const embeddedVerdict = classifyAddress(formatIpv4(embedded));
          if (!embeddedVerdict.public) {
            return {
              ...verdict,
              public: false,
              reason: `nat64-${embeddedVerdict.reason}`,
              nat64: formatIpv4(embedded),
            };
          }
        }
      }
    }
    return verdict;
  });
  const fake = verdicts.find((verdict) => verdict.reason === "fake-ip");
  if (fake !== void 0) {
    return {
      ok: false,
      code: "PROXY_SWITCH_FAKE_IP",
      address: fake.address,
      message:
        `直连模式拒绝请求：目标 ${hostname} 解析到 fake-IP 地址 ${fake.address}（198.18.0.0/15），` +
        `说明本地代理客户端（TUN + fake-IP）仍在运行。请关闭代理客户端，或把线路切到「走代理」。` +
        ` Direct mode refused ${hostname}: it resolves to the fake-IP address ${fake.address} (198.18.0.0/15), ` +
        `so a TUN/fake-IP proxy client is still running. Turn that client off, or set the route to "Through proxy".`,
    };
  }
  const blocked = verdicts.find((verdict) => !verdict.public);
  if (blocked !== void 0) {
    const nat64 = blocked.nat64 !== void 0 ? `，内嵌 IPv4 ${blocked.nat64}` : "";
    return {
      ok: false,
      code: "PROXY_SWITCH_NON_PUBLIC",
      address: blocked.address,
      message:
        `直连模式拒绝请求：目标 ${hostname} 解析到非公网地址 ${blocked.address}（${blocked.reason}${nat64}）。` +
        ` Direct mode refused ${hostname}: it resolves to the non-public address ${blocked.address} (${blocked.reason}${nat64}).`,
    };
  }
  const validated = addresses.map((entry) => ({ address: entry.address, family: entry.family }));
  return { ok: true, address: verdicts[0].address, addresses: validated };
}

/**
 * Resolve plus judge in one step — the exact check `direct` mode performs per request.
 *
 * @param hostname - destination hostname.
 * @param options.lookupFn - DNS implementation, overridden by tests.
 * @param options.nat64Prefixes - pre-discovered prefixes, overridden by tests.
 * @returns `{ ok: true, address, addresses }` or a refusal with `code` and `message`.
 */
export async function resolveDirectTarget(hostname, options = {}) {
  const lookupFn = options.lookupFn ?? lookup;
  let resolved;
  try {
    resolved = await resolveHost(hostname, options);
  } catch (error) {
    return {
      ok: false,
      code: "PROXY_SWITCH_DNS_ERROR",
      message: `直连模式无法解析目标主机 ${hostname}：${error?.code ?? error?.message ?? error}。 Direct mode failed to resolve ${hostname}: ${error?.code ?? error?.message ?? error}.`,
    };
  }
  let nat64Prefixes = options.nat64Prefixes;
  if (nat64Prefixes === void 0 && resolved.addresses.some((entry) => entry.family === 6)) {
    nat64Prefixes = await discoverNat64Prefixes({ lookupFn });
  }
  return judgeAddresses(hostname, resolved.addresses, { nat64Prefixes: nat64Prefixes ?? [] });
}
