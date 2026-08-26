import { describe, expect, test } from "bun:test";

import { bridgeUrlFrom, configuredPublicUrl, selfDnsName, selfHosts } from "./tailnet.ts";

// The shell piped `tailscale status --json` through a one-liner interpreter to get at one field —
// the runtime dependency the compiled binary exists to remove. Same answers, in process.

describe("selfDnsName", () => {
  test("strips the trailing dot the tailnet reports", () => {
    expect(selfDnsName('{"Self":{"DNSName":"host.example.ts.net."}}')).toBe("host.example.ts.net");
  });

  test("reads as no name when the JSON says nothing useful", () => {
    // Every one of these is a real shape: tailscale down, logged out, or a version that renamed the
    // field. The shell swallowed all of them the same way, and the fallback URL says why.
    expect(selfDnsName("")).toBeNull();
    expect(selfDnsName("not json")).toBeNull();
    expect(selfDnsName("{}")).toBeNull();
    expect(selfDnsName('{"Self":{}}')).toBeNull();
    expect(selfDnsName('{"Self":{"DNSName":""}}')).toBeNull();
    expect(selfDnsName('{"Self":{"DNSName":42}}')).toBeNull();
  });
});

describe("selfHosts", () => {
  const STATUS = JSON.stringify({
    Self: { DNSName: "desk.tail1234.ts.net.", TailscaleIPs: ["100.64.0.1", "fd7a::1"] },
  });

  test("names the MagicDNS name first, then every Tailscale IP, v6 bracketed", () => {
    expect(selfHosts(STATUS)).toEqual(["desk.tail1234.ts.net", "100.64.0.1", "[fd7a::1]"]);
  });

  test("a node with no addresses still contributes its name", () => {
    expect(selfHosts(JSON.stringify({ Self: { DNSName: "desk.ts.net." } }))).toEqual(["desk.ts.net"]);
  });

  test("nothing readable is no hosts, never a bad one", () => {
    expect(selfHosts("")).toEqual([]);
    expect(selfHosts("{}")).toEqual([]);
    expect(selfHosts(JSON.stringify({ Self: { TailscaleIPs: "100.64.0.1" } }))).toEqual([]);
  });

  test("a malformed address list costs the addresses and never the name", () => {
    const mixed = JSON.stringify({ Self: { DNSName: "desk.ts.net.", TailscaleIPs: [42] } });
    expect(selfHosts(mixed)).toEqual(["desk.ts.net"]);
  });
});

describe("bridgeUrlFrom", () => {
  test("https terminates on 443, http carries the port", () => {
    expect(bridgeUrlFrom("host.example", "https", 8787, 443)).toBe("https://host.example");
    expect(bridgeUrlFrom("host.example", "http", 8787, 443)).toBe("http://host.example:8787");
  });

  test("an https front door away from 443 carries its listener port", () => {
    // COLLIE_SERVE_PORT: several developers on one host, one tailnet name, a port each.
    expect(bridgeUrlFrom("host.example", "https", 8787, 8443)).toBe("https://host.example:8443");
    // The bridge port is NOT the one in the URL — the tailnet listener is.
    expect(bridgeUrlFrom("host.example", "https", 9001, 8443)).toBe("https://host.example:8443");
    // http mode ignores it: there the listener already is the bridge port.
    expect(bridgeUrlFrom("host.example", "http", 8787, 8443)).toBe("http://host.example:8787");
  });

  test("without a name, says loopback AND why", () => {
    expect(bridgeUrlFrom(null, "https", 8787, 443)).toBe(
      "http://127.0.0.1:8787 (Tailscale name unavailable)",
    );
    expect(bridgeUrlFrom(null, "https", 8787, 8443)).toBe(
      "http://127.0.0.1:8787 (Tailscale name unavailable)",
    );
  });
});

describe("configuredPublicUrl", () => {
  test("the operator's URL is taken as given, minus a trailing slash", () => {
    // The reported break: `tailscale serve` on a port that isn't 443, because something else owns
    // 443. Nothing local can infer that port — the operator names it, so it wins (issue #122).
    expect(configuredPublicUrl({ COLLIE_PUBLIC_URL: "https://host.example.ts.net:9443" })).toBe(
      "https://host.example.ts.net:9443",
    );
    expect(configuredPublicUrl({ COLLIE_PUBLIC_URL: " https://c.example/ " })).toBe(
      "https://c.example",
    );
  });

  test("unset, blank or whitespace reads as no answer", () => {
    expect(configuredPublicUrl({})).toBeNull();
    expect(configuredPublicUrl({ COLLIE_PUBLIC_URL: "" })).toBeNull();
    expect(configuredPublicUrl({ COLLIE_PUBLIC_URL: "   " })).toBeNull();
  });
});
