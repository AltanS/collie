import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatAuditLine } from "./audit.ts";
import {
  addressClass,
  NOT_PLACED,
  pairApproveAuditEntry,
  pairAuditEntry,
  pairRequestAuditEntry,
  pairRequestRefusedAuditEntry,
  pairRoute,
} from "./pair-audit.ts";
import { coercePending, filePairingIo, newPending, PairingStore } from "./pairing.ts";

// The audit line of one pairing (bridge/pair-audit.ts): the route as an address class, the pane the code
// came from, the label, and never the code or the token.

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;

describe("addressClass", () => {
  test("loopback, tailnet, LAN and the internet, in both families; anything else is unknown", () => {
    const cases: [string | null | undefined, string][] = [
      ["127.0.0.1", "loopback"],
      ["127.8.9.10", "loopback"],
      ["::1", "loopback"],
      ["::ffff:127.0.0.1", "loopback"],
      ["100.64.0.8", "tailnet"],
      ["100.127.255.254", "tailnet"],
      ["fd7a:115c:a1e0::5", "tailnet"],
      ["[fd7a:115c:a1e0::5]:443", "tailnet"],
      ["100.63.0.1", "internet"],
      ["100.128.0.1", "internet"],
      ["10.1.2.3", "lan"],
      ["172.16.0.1", "lan"],
      ["172.31.255.1", "lan"],
      ["172.32.0.1", "internet"],
      ["192.168.1.20", "lan"],
      ["192.168.1.20:5000", "lan"],
      ["169.254.1.1", "lan"],
      ["fe80::1", "lan"],
      ["fd12:3456::1", "lan"],
      ["fc::1", "internet"],
      ["203.0.113.9", "internet"],
      ["2001:db8::1", "internet"],
      ["", "unknown"],
      ["not an address", "unknown"],
      ["300.1.1.1", "unknown"],
      [null, "unknown"],
      [undefined, "unknown"],
    ];
    for (const [address, kind] of cases) expect([address, addressClass(address)]).toEqual([address, kind]);
  });
});

describe("pairRoute", () => {
  test("a remote peer is its own class, and its X-Forwarded-For is the client's words, ignored", () => {
    expect(pairRoute("100.64.0.8", false, "127.0.0.1")).toEqual({ route: "tailnet" });
    expect(pairRoute("203.0.113.9", false, null)).toEqual({ route: "internet" });
  });

  test("behind a front door on this machine: loopback, and the class of the rightmost forwarded entry", () => {
    expect(pairRoute("127.0.0.1", true, "203.0.113.9, 100.64.0.8")).toEqual({ route: "loopback", forwarded: "tailnet" });
    expect(pairRoute("127.0.0.1", true, "100.64.0.8, ")).toEqual({ route: "loopback", forwarded: "tailnet" });
    expect(pairRoute("::1", true, null)).toEqual({ route: "loopback" });
    // isLoopbackPeer reads an absent peer as loopback; the route follows it.
    expect(pairRoute(undefined, true, null)).toEqual({ route: "loopback" });
  });
});

describe("the pairing's audit line", () => {
  test("label, route, forwarded class and the pane that made the code; no address", () => {
    const line = formatAuditLine(
      pairAuditEntry("pixel", pairRoute("127.0.0.1", true, "100.64.0.8"), { session: "main", paneId: "w1:p3" }),
      NOW,
    );
    expect(JSON.parse(line)).toEqual({
      ts: new Date(NOW).toISOString(),
      action: "pair",
      device: "pixel",
      detail: { label: "pixel", route: "loopback", forwardedFrom: "tailnet", mintSession: "main", mintPane: "w1:p3" },
    });
    expect(line).not.toContain("100.64.0.8");
  });

  test("a code from no placed pane says so", () => {
    const entry = pairAuditEntry("pixel", { route: "tailnet" }, null);
    expect(JSON.parse(formatAuditLine(entry, NOW))).toMatchObject({
      detail: { label: "pixel", route: "tailnet", mintSession: NOT_PLACED, mintPane: NOT_PLACED },
    });
    expect(JSON.parse(formatAuditLine(entry, NOW)).detail).not.toHaveProperty("forwardedFrom");
  });

  test("with COLLIE_AUDIT_CONTENT=none the route and the pane stay; the label stays in the envelope", () => {
    const entry = pairAuditEntry("pixel", { route: "loopback", forwarded: "lan" }, { session: "main", paneId: "w1:p3" });
    expect(JSON.parse(formatAuditLine(entry, NOW, "none"))).toEqual({
      ts: new Date(NOW).toISOString(),
      action: "pair",
      device: "pixel",
      detail: { label: "⟨redacted⟩", route: "loopback", forwardedFrom: "lan", mintSession: "main", mintPane: "w1:p3" },
    });
  });

  test("a real claim's line holds neither the code nor the token, in either content mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "collie-pair-audit-"));
    dirs.push(dir);
    const io = filePairingIo(dir);
    const code = "ABCD2345";
    await io.writePending({ ...newPending(code, NOW), mintedIn: { session: "main", paneId: "w1:p3" } });
    const claimed = await new PairingStore(io, () => NOW + 1_000).claim(code, "pixel");
    if (!claimed.ok) throw new Error(`the claim failed: ${claimed.reason}`);
    expect(claimed.mintedIn).toEqual({ session: "main", paneId: "w1:p3" });
    const entry = pairAuditEntry("pixel", pairRoute("127.0.0.1", true, "100.64.0.8"), claimed.mintedIn);
    for (const content of ["preview", "none"] as const) {
      const line = formatAuditLine(entry, NOW, content);
      expect(line).not.toContain(code);
      expect(line).not.toContain(claimed.token);
      expect(line.toLowerCase()).not.toContain(code.toLowerCase());
    }
  });

  test("the bridge's pair route audits through pairAuditEntry, and hands it no token or code", () => {
    const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
    const at = src.indexOf('if (pathname === "/api/pair" && req.method === "POST")');
    const handler = src.slice(at, src.indexOf("\n      }\n", at));
    const calls = handler.split("audit.record(").slice(1).map((rest) => rest.slice(0, rest.indexOf(");")));
    expect(calls.some((call) => call.includes("pairAuditEntry("))).toBe(true);
    for (const call of calls) {
      expect(call).not.toContain("token");
      expect(call).not.toContain(".code");
    }
  });
});

describe("the pane on the pending code", () => {
  test("is carried when it is two short plain strings, and dropped otherwise, never failing the code", () => {
    const base = newPending("ABCD2345", NOW);
    expect(coercePending({ ...base, mintedIn: { session: "main", paneId: "w1:p3" } })!.mintedIn).toEqual({ session: "main", paneId: "w1:p3" });
    for (const bad of [null, "main/w1:p3", { session: "main" }, { session: "", paneId: "w1:p3" }, { session: "main", paneId: "w1‮p3" }, { session: "x".repeat(129), paneId: "p" }]) {
      const pending = coercePending({ ...base, mintedIn: bad });
      expect(pending).not.toBeNull();
      expect(pending).not.toHaveProperty("mintedIn");
    }
  });

  test("a pending file without one claims as before, and the claim says null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "collie-pair-audit-"));
    dirs.push(dir);
    const io = filePairingIo(dir);
    await io.writePending(newPending("ABCD2345", NOW));
    const claimed = await new PairingStore(io, () => NOW + 1_000).claim("ABCD2345", "pixel");
    expect(claimed.ok && claimed.mintedIn).toBeNull();
  });
});

// ── Pairing with a phone (ADR 0139) ──────────────────────────────────────────────────────────

describe("the pairing request's audit lines", () => {
  test("a request names its route and nothing else", () => {
    expect(JSON.parse(formatAuditLine(pairRequestAuditEntry({ route: "loopback", forwarded: "tailnet" }), NOW))).toEqual({
      ts: new Date(NOW).toISOString(),
      action: "pair-request",
      detail: { route: "loopback", forwardedFrom: "tailnet" },
    });
    expect(JSON.parse(formatAuditLine(pairRequestAuditEntry({ route: "lan" }), NOW)).detail).toEqual({ route: "lan" });
  });

  test("an approval names the approver, the new label and both routes", () => {
    const entry = pairApproveAuditEntry({
      approver: "pixel",
      label: "Chrome on Linux",
      asker: { route: "tailnet" },
      approverRoute: { route: "loopback", forwarded: "tailnet" },
    });
    expect(JSON.parse(formatAuditLine(entry, NOW))).toEqual({
      ts: new Date(NOW).toISOString(),
      action: "pair-approve",
      device: "pixel",
      detail: { approver: "pixel", label: "Chrome on Linux", route: "tailnet", approverRoute: "loopback", approverForwardedFrom: "tailnet" },
    });
  });

  test("a refusal names its reason, and the approver when one answered", () => {
    for (const reason of ["wrong-code", "refused", "expired", "rate"] as const) {
      expect(JSON.parse(formatAuditLine(pairRequestRefusedAuditEntry(reason), NOW))).toEqual({
        ts: new Date(NOW).toISOString(),
        action: "pair-request-refused",
        detail: { reason },
      });
    }
    expect(JSON.parse(formatAuditLine(pairRequestRefusedAuditEntry("wrong-code", "pixel"), NOW)).device).toBe("pixel");
  });
});

