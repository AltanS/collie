import { describe, expect, test } from "bun:test";

import { bridgeUrlFrom, configuredPublicUrl, selfDnsName } from "./tailnet.ts";

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

describe("bridgeUrlFrom", () => {
  test("https terminates on 443, http carries the port", () => {
    expect(bridgeUrlFrom("host.example", "https", 8787)).toBe("https://host.example");
    expect(bridgeUrlFrom("host.example", "http", 8787)).toBe("http://host.example:8787");
  });

  test("without a name, says loopback AND why", () => {
    expect(bridgeUrlFrom(null, "https", 8787)).toBe(
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
