import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyAddress,
  formatAuthority,
  isFakeIp,
  judgeAddresses,
  mappedIpv4,
  parseAuthority,
  resolveDirectTarget,
  resolveHost,
  splitAuthority,
  unbracket,
} from "../lib/net-guard.js";

test("fake-IP block is recognised across its full /15", () => {
  assert.equal(isFakeIp("198.18.0.1"), true);
  assert.equal(isFakeIp("198.18.255.255"), true);
  assert.equal(isFakeIp("198.19.0.1"), true);
  assert.equal(isFakeIp("198.19.255.255"), true);
  assert.equal(isFakeIp("198.20.0.1"), false);
  assert.equal(isFakeIp("198.17.255.255"), false);
});

test("private, loopback and link-local ranges are classified", () => {
  const cases = [
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["169.254.1.1", "link-local"],
    ["100.64.0.1", "carrier-grade-nat"],
    ["0.0.0.0", "unspecified"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["192.0.2.5", "documentation"],
    ["203.0.113.9", "documentation"],
  ];
  for (const [address, reason] of cases) {
    const verdict = classifyAddress(address);
    assert.equal(verdict.public, false, `${address} should not be public`);
    assert.equal(verdict.reason, reason, `${address} reason`);
  }
});

test("public IPv4 and IPv6 stay public", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "198.17.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(classifyAddress(address).public, true, `${address} should be public`);
  }
});

test("IPv4-mapped IPv6 is judged as the IPv4 destination", () => {
  assert.equal(mappedIpv4("::ffff:198.18.0.1"), "198.18.0.1");
  assert.equal(mappedIpv4("::ffff:c612:0001"), "198.18.0.1");
  assert.equal(isFakeIp("::ffff:198.18.0.1"), true);
  assert.equal(classifyAddress("::ffff:10.0.0.1").reason, "private");

  // Every equivalent spelling, including the uncompressed form that the old regex missed.
  for (const address of ["0:0:0:0:0:ffff:7f00:1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
    assert.equal(classifyAddress(address).reason, "loopback", address);
  }
  assert.equal(mappedIpv4("0:0:0:0:0:ffff:7f00:1"), "127.0.0.1");

  // IPv4-translated (RFC 6145) is blocked as a class, matching ipaddr.js's `rfc6145`
  // range; it is not silently treated as the embedded IPv4.
  assert.equal(mappedIpv4("::ffff:0:c612:252"), null);
  assert.equal(classifyAddress("::ffff:0:c612:252").reason, "ipv4-translated");
  assert.equal(classifyAddress("::ffff:0:0808:0808").public, false);

  // Deprecated IPv4-compatible `::a.b.c.d` is judged by its embedded IPv4.
  assert.equal(classifyAddress("::1.2.3.4").public, true);
  assert.equal(classifyAddress("::127.0.0.1").reason, "loopback");
});

test("IPv6 local ranges are blocked", () => {
  assert.equal(classifyAddress("::1").reason, "loopback");
  assert.equal(classifyAddress("::").reason, "unspecified");
  assert.equal(classifyAddress("fe80::1").reason, "link-local");
  assert.equal(classifyAddress("fd00::1").reason, "unique-local");
  assert.equal(classifyAddress("ff02::1").reason, "multicast");
  assert.equal(classifyAddress("2001:db8::1").reason, "documentation");
});

test("hostname helpers strip brackets and zones", () => {
  assert.equal(unbracket("[::1]"), "::1");
  assert.equal(unbracket("fe80::1%en0"), "fe80::1");
  assert.deepEqual(splitAuthority("example.com:443"), { host: "example.com", port: 443 });
  assert.deepEqual(splitAuthority("[::1]:8080"), { host: "::1", port: 8080 });
  assert.deepEqual(splitAuthority("example.com"), { host: "example.com", port: 80 });
});

test("judgeAddresses refuses the whole answer set when any address is not public", () => {
  const fake = judgeAddresses("example.com", [{ address: "198.18.0.7", family: 4 }]);
  assert.equal(fake.ok, false);
  assert.equal(fake.code, "PROXY_SWITCH_FAKE_IP");
  assert.match(fake.message, /fake-IP/);

  const mixed = judgeAddresses("example.com", [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.5", family: 4 },
  ]);
  assert.equal(mixed.ok, false);
  assert.equal(mixed.code, "PROXY_SWITCH_NON_PUBLIC");

  const empty = judgeAddresses("example.com", []);
  assert.equal(empty.ok, false);
  assert.equal(empty.code, "PROXY_SWITCH_DNS_EMPTY");

  const good = judgeAddresses("example.com", [{ address: "93.184.216.34", family: 4 }]);
  assert.equal(good.ok, true);
  assert.equal(good.address, "93.184.216.34");
});

test("resolveHost short-circuits IP literals without asking DNS", async () => {
  let asked = 0;
  const lookupFn = async () => {
    asked += 1;
    return [];
  };
  const resolved = await resolveHost("198.18.0.9", { lookupFn });
  assert.equal(asked, 0);
  assert.deepEqual(resolved.addresses, [{ address: "198.18.0.9", family: 4 }]);
});

test("resolveDirectTarget reports DNS failure as a refusal", async () => {
  const verdict = await resolveDirectTarget("does-not-exist.invalid", {
    lookupFn: async () => {
      throw Object.assign(new Error("nope"), { code: "ENOTFOUND" });
    },
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "PROXY_SWITCH_DNS_ERROR");
});

test("resolveDirectTarget accepts a public answer and refuses fake-IP", async () => {
  const publicVerdict = await resolveDirectTarget("example.com", {
    lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  assert.equal(publicVerdict.ok, true);

  const fakeVerdict = await resolveDirectTarget("example.com", {
    lookupFn: async () => [{ address: "198.18.12.34", family: 4 }],
  });
  assert.equal(fakeVerdict.ok, false);
  assert.equal(fakeVerdict.code, "PROXY_SWITCH_FAKE_IP");
});


test("special-purpose IPv4/IPv6 ranges are not public", () => {
  const cases = [
    ["192.88.99.1", "6to4-relay"],
    ["64:ff9b::1", "nat64"],
    ["64:ff9b:1::1", "nat64-local"],
    ["100::1", "discard-only"],
    ["2001::1", "ietf-protocol"],
    ["2001:2::1", "ietf-protocol"],
    ["2001:10::1", "ietf-protocol"],
    ["2001:20::1", "ietf-protocol"],
    ["2002::1", "6to4"],
    ["2620:4f:8000::1", "as112"],
    ["3fff::1", "documentation"],
    ["5f00::1", "srv6-sid"],
    ["100:0:0:1::1", "dummy-prefix"],
    ["::ffff:0:7f00:1", "ipv4-translated"],
  ];
  for (const [address, reason] of cases) {
    const verdict = classifyAddress(address);
    assert.equal(verdict.public, false, `${address} should not be public`);
    assert.equal(verdict.reason, reason, `${address} reason`);
  }
});

test("addresses just outside the new ranges stay public", () => {
  const cases = [
    "192.88.100.1",
    "64:ff9b:2::1",
    "100:0:0:2::1",
    "2001:4860:4860::8888",
    "2001:db9::1",
    "3fff:1000::1",
    "5f01::1",
    "2620:4f:8001::1",
  ];
  for (const address of cases) {
    assert.equal(classifyAddress(address).public, true, `${address} should be public`);
  }
});

test("new ranges are recognised through IPv4-mapped forms", () => {
  assert.equal(classifyAddress("::ffff:192.88.99.1").reason, "6to4-relay");
  assert.equal(classifyAddress("::ffff:192.88.100.1").public, true);
  assert.equal(classifyAddress("::ffff:0:c0a8:0101").reason, "ipv4-translated");
  assert.equal(classifyAddress("0:0:0:0:0:ffff:c0a8:0101").reason, "private");
});

test("a network-specific NAT64 prefix is checked for a private embedded IPv4", async () => {
  const target = "2001:4860:1234::7f00:1";
  const lookupFn = async (hostname) => {
    if (hostname === "ipv4only.arpa") {
      return [
        { address: "2001:4860:1234::c000:aa", family: 6 },
        { address: "2001:4860:1234::c000:ab", family: 6 },
      ];
    }
    if (hostname === "attacker.example") return [{ address: target, family: 6 }];
    return [];
  };
  const verdict = await resolveDirectTarget("attacker.example", { lookupFn });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "PROXY_SWITCH_NON_PUBLIC");
  assert.match(verdict.message, /nat64-loopback/);

  const publicTarget = await resolveDirectTarget("attacker.example", {
    nat64Prefixes: void 0,
    lookupFn: async (hostname) => {
      if (hostname === "ipv4only.arpa") return [{ address: "2001:4860:1234::c000:aa", family: 6 }];
      return [{ address: "2001:4860:1234::808:808", family: 6 }];
    },
  });
  assert.equal(publicTarget.ok, true);
});

test("parseAuthority accepts only well-formed host:port pairs", () => {
  const valid = [
    ["example.com:443", "example.com", 443],
    ["example.com", "example.com", 80],
    ["[2606:4700:4700::1111]:443", "2606:4700:4700::1111", 443],
    ["[::1]:80", "::1", 80],
    ["::1", "::1", 80],
    ["198.18.0.1:443", "198.18.0.1", 443],
    ["example.com:1", "example.com", 1],
    ["example.com:65535", "example.com", 65_535],
    ["Sub.Example.com.:8443", "Sub.Example.com.", 8443],
  ];
  for (const [authority, host, port] of valid) {
    const parsed = parseAuthority(authority);
    assert.equal(parsed.ok, true, `${authority} should parse`);
    assert.equal(parsed.host, host, `${authority} host`);
    assert.equal(parsed.port, port, `${authority} port`);
  }

  const invalid = [
    "",
    "example.com:notaport",
    "example.com:0",
    "example.com:65536",
    "example.com:-1",
    "example.com:+443",
    "example.com:1e3",
    "example.com:",
    ":443",
    "[::1",
    "[::1]443",
    "[::1]:",
    "[::1]:0",
    "[::1]:65536",
    "[::1]:abc",
    "[::1]:443:extra",
    "example.com:443:extra",
    "example.com/443",
    "exa mple.com:443",
    "[not-an-ipv6]:443",
    "[]:443",
    "::1:notaport",
  ];
  for (const authority of invalid) {
    const parsed = parseAuthority(authority);
    assert.equal(parsed.ok, false, `${JSON.stringify(authority)} must be refused`);
    assert.equal(parsed.code, "PROXY_SWITCH_INVALID_AUTHORITY");
  }
});

test("formatAuthority brackets IPv6 and keeps IPv4/domains bare", () => {
  assert.equal(formatAuthority("example.com", 443), "example.com:443");
  assert.equal(formatAuthority("1.1.1.1", 80), "1.1.1.1:80");
  assert.equal(formatAuthority("::1", 443), "[::1]:443");
  assert.equal(formatAuthority("[2606:4700:4700::1111]", 443), "[2606:4700:4700::1111]:443");
});
