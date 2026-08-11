import { describe, expect, test } from "bun:test";

import { capture, context, fakeExec } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { cmdQr } from "./qr.ts";
import { packetFilterDeniesAll } from "./tailnet.ts";

// What `qr` decides is WHICH url is worth encoding, and when there is nothing true to encode at all.
// The drawing itself is decode-tested in scripts/qr.test.ts, and the whole verb runs end to end
// against the compiled binary in scripts/collie-cli.test.sh.

const NAMED = '{"Self":{"DNSName":"host.example."}}';
const GRANTED = '{"PacketFilter":[{"SrcIPs":["*"]}]}';
const DENY_ALL = '{"PacketFilter":[]}';

function deps(env: Record<string, string | undefined>, netmap = GRANTED, status = NAMED) {
  const io = capture();
  const exec = fakeExec({
    answers: [
      ["tailscale status --json", { stdout: status }],
      // Bounded through `timeout` when it exists, which in the fake it does.
      ["timeout 3 /fake/tailscale debug netmap", { stdout: netmap }],
      ["tailscale debug netmap", { stdout: netmap }],
    ],
  });
  return { ctx: context(env), io, exec };
}

describe("which URL gets a QR", () => {
  test("the tailnet front door, drawn with the URL printed below it", async () => {
    const d = deps({});
    expect(await cmdQr(d)).toBe(EXIT.OK);
    const out = d.io.stdout.join("\n");
    expect(out).toContain("https://host.example");
    expect(out).toContain("█");
    expect(d.io.stderr).toEqual([]);
  });

  test("http mode carries the port, exactly as `url` reports it", async () => {
    const d = { ...deps({}), ctx: context({}, { serveMode: "http" }) };
    expect(await cmdQr(d)).toBe(EXIT.OK);
    expect(d.io.stdout.join("\n")).toContain("http://host.example:8787");
  });

  test("under COLLIE_SKIP_SERVE the operator's public URL is still worth scanning", async () => {
    const d = deps({ COLLIE_SKIP_SERVE: "1", COLLIE_PUBLIC_URL: "https://collie.example.com" });
    expect(await cmdQr(d)).toBe(EXIT.OK);
    expect(d.io.stdout.join("\n")).toContain("https://collie.example.com");
    // Collie publishes no front door there (ADR 0001), so it must not go asking the tailnet either.
    expect(d.exec.calls.join("\n")).not.toContain("tailscale");
  });

  test("with no public URL there is nothing true to encode, and nothing is invented", async () => {
    const d = deps({ COLLIE_SKIP_SERVE: "1" });
    expect(await cmdQr(d)).toBe(EXIT.FAIL);
    expect(d.io.stdout).toEqual([]);
    expect(d.io.stderr.join("\n")).toContain("COLLIE_PUBLIC_URL is unset");
  });

  test("no tailnet name refuses rather than encoding a loopback placeholder", async () => {
    // A phone scanning `http://127.0.0.1:8787` goes to its OWN localhost.
    const d = deps({}, GRANTED, "{}");
    expect(await cmdQr(d)).toBe(EXIT.FAIL);
    expect(d.io.stdout).toEqual([]);
    expect(d.io.stderr.join("\n")).toContain("tailnet front door isn't up");
  });
});

describe("a front door nothing can reach", () => {
  test("still gets its QR, with the reason on stderr", async () => {
    // The code is fine; the tailnet policy isn't. Refusing to draw would blame the wrong thing, and
    // saying nothing would have the operator scan a dead end and blame the code.
    const d = deps({}, DENY_ALL);
    expect(await cmdQr(d)).toBe(EXIT.OK);
    expect(d.io.stdout.join("\n")).toContain("https://host.example");
    expect(d.io.stderr.join("\n")).toContain("admits no peer");
  });

  test("says nothing when the netmap cannot answer — a false alarm is worse than silence", async () => {
    for (const netmap of [GRANTED, "not json at all", '{"DNS":{}}']) {
      const d = deps({}, netmap);
      expect(await cmdQr(d)).toBe(EXIT.OK);
      expect(d.io.stderr).toEqual([]);
    }
  });
});

describe("packetFilterDeniesAll", () => {
  test("only an empty array is a definite deny-all", () => {
    expect(packetFilterDeniesAll(DENY_ALL)).toBe(true);
    expect(packetFilterDeniesAll(GRANTED)).toBe(false);
    expect(packetFilterDeniesAll('{"PacketFilter":null}')).toBe(false);
    expect(packetFilterDeniesAll("{}")).toBe(false);
    expect(packetFilterDeniesAll("")).toBe(false);
  });
});
