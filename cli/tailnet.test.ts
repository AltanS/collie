import { describe, expect, test } from "bun:test";

import { fakeExec } from "./fakes.ts";
import {
  bridgeUrlFrom,
  certDomains,
  configuredPublicUrl,
  dialableBridgeHost,
  localBridgeHostPort,
  localBridgeUrl,
  selfDnsName,
  selfHosts,
  TAILSCALE_PROBE_MS,
  tailnetCertDomains,
  tailnetHosts,
  readTailscale,
  tailnetInboundBlocked,
  tailnetName,
} from "./tailnet.ts";

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

// F13: `collie start`'s banner printed `local http://127.0.0.1:8787` on a machine bound to
// 192.168.77.1, where loopback carried nothing at all — a URL that refuses to connect, printed
// two lines under a readiness probe that had resolved the bind correctly and said "running".
describe("the local bridge address", () => {
  test("an absent COLLIE_HOST is loopback, exactly as it always was", () => {
    expect(localBridgeUrl({}, 8787)).toBe("http://127.0.0.1:8787");
    expect(localBridgeHostPort({}, 8787)).toBe("127.0.0.1:8787");
  });

  test("a moved bind is the address the bridge actually bound", () => {
    expect(localBridgeUrl({ COLLIE_HOST: "192.168.77.1" }, 8787)).toBe("http://192.168.77.1:8787");
    expect(localBridgeHostPort({ COLLIE_HOST: "192.168.77.1" }, 8787)).toBe("192.168.77.1:8787");
  });

  test("a wildcard bind answers on loopback too, so loopback is what it promises", () => {
    for (const host of ["", "0.0.0.0", "::"]) {
      expect(dialableBridgeHost({ COLLIE_HOST: host })).toBe("127.0.0.1");
    }
  });

  test("an IPv6 literal is bracketed, and one already bracketed is left alone", () => {
    expect(localBridgeUrl({ COLLIE_HOST: "fd7a::1" }, 8787)).toBe("http://[fd7a::1]:8787");
    expect(localBridgeUrl({ COLLIE_HOST: "[fd7a::1]" }, 8787)).toBe("http://[fd7a::1]:8787");
  });
});

describe("certDomains — has this tailnet got HTTPS at all? (#172)", () => {
  test("a named domain, an empty list and an absent key are three different answers", () => {
    expect(certDomains('{"CertDomains":["host.example"]}')).toEqual(["host.example"]);
    // Absent, null and empty all mean the same thing: no certificates. That is an ANSWER.
    expect(certDomains('{"Self":{"DNSName":"host.example."}}')).toEqual([]);
    expect(certDomains('{"CertDomains":null}')).toEqual([]);
    expect(certDomains('{"CertDomains":[]}')).toEqual([]);
  });

  test("anything unreadable is `can't tell`, never `no HTTPS`", () => {
    // A false "your tailnet has no HTTPS" would refuse a publish that works.
    expect(certDomains("not json")).toBeNull();
    expect(certDomains("7")).toBeNull();
    expect(certDomains('{"CertDomains":"host.example"}')).toBeNull();
  });

  test("blank entries are dropped, so a list of nothing reads as no certificates", () => {
    expect(certDomains('{"CertDomains":["  ",""]}')).toEqual([]);
  });
});

describe("tailnetInboundBlocked — bounded inside Collie, on every OS", () => {
  const NETMAP: [string, { stdout: string; code?: number }] = ["tailscale debug netmap", { stdout: "{}" }];

  test("a netmap call that timed out (code 124) is `can't tell`, not blocked", () => {
    const exec = fakeExec({ answers: [["tailscale debug netmap", { code: 124, stdout: '{"PacketFilter":[]}' }]] });
    expect(tailnetInboundBlocked(exec)).toBe(false);
  });

  test("it asks the seam for the three-second bound and never looks for an external `timeout`", () => {
    const whichAsked: string[] = [];
    const exec = fakeExec({ answers: [NETMAP] });
    const which = exec.which;
    exec.which = (tool) => {
      whichAsked.push(tool);
      return which(tool);
    };
    tailnetInboundBlocked(exec);
    expect(exec.calls).toEqual(["tailscale debug netmap"]);
    expect(exec.timeouts).toEqual([{ call: "tailscale debug netmap", ms: TAILSCALE_PROBE_MS }]);
    expect(whichAsked).not.toContain("timeout");
  });

  test("an empty packet filter with exit 0 is blocked", () => {
    const exec = fakeExec({ answers: [["tailscale debug netmap", { stdout: '{"PacketFilter":[]}' }]] });
    expect(tailnetInboundBlocked(exec)).toBe(true);
  });

  test("no tailscale on PATH is `can't tell`", () => {
    expect(tailnetInboundBlocked(fakeExec({ absent: ["tailscale"] }))).toBe(false);
  });
});

describe("every other tailscale call is bounded too", () => {
  test("hosts, name and certificate reads pass the probe bound", () => {
    const exec = fakeExec({ answers: [["tailscale status --json", { stdout: "{}" }]] });
    tailnetHosts(exec);
    tailnetName(exec);
    tailnetCertDomains(exec);
    expect(exec.timeouts).toEqual([
      { call: "tailscale status --json", ms: TAILSCALE_PROBE_MS },
      { call: "tailscale status --json", ms: TAILSCALE_PROBE_MS },
      { call: "tailscale status --json", ms: TAILSCALE_PROBE_MS },
    ]);
  });
});

describe("readTailscale", () => {
  test("code 124 (the seam's expiry) is slow; any other failure is down", () => {
    const slow = fakeExec({ answers: [["tailscale status --json", { code: 124 }]] });
    expect(readTailscale(slow)).toEqual({ kind: "slow" });
    const down = fakeExec({ answers: [["tailscale status --json", { code: 1 }]] });
    expect(readTailscale(down)).toEqual({ kind: "down", state: null });
  });
});
