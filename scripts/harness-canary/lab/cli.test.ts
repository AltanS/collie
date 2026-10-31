import { describe, expect, test } from "bun:test";
import { basename, join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { claim, settle } from "./lab-ledger";
import { parseBridgeUrl, parseCli, pending, PHONE_ONLY_SUFFIX, phoneOnlyRoot, readTokenFile, type CliOptions } from "./cli";

// The phone leg's flags: --leg, --bridge and --token-file. Paths are built with the host's own join and
// resolve, as in watch.test.ts, so the same claims hold on Windows (`D:\home\u\...`).

const argv = (...args: string[]): CliOptions => {
  const parsed = parseCli(args, "/checkout", {}, "/home/u");
  if (parsed === "help") throw new Error("help");
  return parsed;
};

describe("--leg", () => {
  test("the default is every leg, a scratch bridge, and the nightly lab root and ledger", () => {
    const cli = argv();
    expect(cli.legs).toBe("all");
    expect(cli.bridge).toBeNull();
    expect(cli.ledger).toBe(join("/home/u", ".local", "state", "collie-harness-lab", "ledger.json"));
  });

  test("--leg phone is a hand run of one named version, with its own lab root and ledger", () => {
    const cli = argv("--leg", "phone", "--version", "claude=2.1.302");
    expect(cli.legs).toBe("phone");
    expect(cli.labRoot).toBe(phoneOnlyRoot(resolve(join("/home/u", ".cache", "collie-lab", "harness-lab")), cli.ledger));
    expect(cli.labRoot).toBe(join(resolve(join("/home/u", ".cache", "collie-lab", "harness-lab")), PHONE_ONLY_SUFFIX, basename(cli.labRoot)));
    expect(basename(cli.labRoot)).toMatch(/^ledger-[0-9a-f]{10}$/u);
    expect(cli.ledger).toBe(join("/home/u", ".local", "state", "collie-harness-lab", `ledger.${PHONE_ONLY_SUFFIX}.json`));
    const other = argv("--leg", "phone", "--version", "claude=2.1.302", "--ledger", "/tmp/l.json");
    expect(other.ledger).toBe(resolve(`/tmp/l.${PHONE_ONLY_SUFFIX}.json`));
    // Two ledgers, two folders: one run's start sweep never deletes the other's run folder.
    expect(other.labRoot).not.toBe(cli.labRoot);
  });

  test("--leg phone needs one version and runs Claude only; an unknown leg is refused", () => {
    expect(() => argv("--leg", "phone")).toThrow(/name it with --version/);
    expect(() => argv("--leg", "phone", "--version", "claude=2.1.301,claude=2.1.302")).toThrow(/name it with --version/);
    expect(() => argv("--leg", "phone", "--version", "codex=0.156.1")).toThrow(/Claude only/);
    expect(() => argv("--leg", "walk")).toThrow(/--leg takes all or phone/);
    expect(argv("--leg", "phone", "--plan").legs).toBe("phone");
  });
});

describe("--bridge and --token-file", () => {
  test("they go together, and only with --leg phone", () => {
    const cli = argv("--leg", "phone", "--version", "claude=2.1.302", "--bridge", "http://127.0.0.1:8788", "--token-file", "/tmp/tok");
    expect(cli.bridge).toEqual({ url: "http://127.0.0.1:8788", tokenFile: resolve("/tmp/tok") });
    expect(() => argv("--leg", "phone", "--version", "claude=2.1.302", "--bridge", "http://127.0.0.1:8788")).toThrow(/go together/);
    expect(() => argv("--bridge", "http://127.0.0.1:8788", "--token-file", "/tmp/tok")).toThrow(/add --leg phone/);
  });

  test("the bridge must be on this machine, an origin with no path", () => {
    expect(parseBridgeUrl("http://localhost:5199/")).toBe("http://localhost:5199");
    expect(() => parseBridgeUrl("http://bluefin:8788")).toThrow(/on this machine/);
    expect(() => parseBridgeUrl("http://127.0.0.1:8788/collie/")).toThrow(/no path/);
    expect(() => parseBridgeUrl("ftp://127.0.0.1:21")).toThrow(/http URL/);
    expect(() => parseBridgeUrl("not a url")).toThrow(/URL like/);
  });

  test("the token is the file's first line, and an empty or missing file stops the command", () => {
    expect(readTokenFile("/t", () => "  abc123 \nsecond line\n")).toBe("abc123");
    expect(() => readTokenFile("/t", () => "\n")).toThrow(/holds no token/);
    expect(() => readTokenFile("/t", () => {
      throw new Error("ENOENT");
    })).toThrow(/cannot be read/);
  });
});

describe("pending, the pairs a run takes", () => {
  test("a failed row stays skipped unless the pair was named with --version", () => {
    const dir = mkdtempSync(join(tmpdir(), "lab-cli-"));
    try {
      const ledger = join(dir, "ledger.json");
      claim(ledger, "pi", "1.4.0", "2026-10-23", "/l", Date.now(), 1);
      settle(ledger, "pi", "1.4.0", { result: "failed", note: "ETARGET" });
      claim(ledger, "pi", "1.3.0", "2026-10-17", "/l", Date.now(), 1);
      settle(ledger, "pi", "1.3.0", { result: "fail", note: "drift" });
      const pair = (version: string, named: boolean) => ({ harness: "pi", version, source: "test", named });
      expect(pending([pair("1.4.0", false)], ledger, Date.now(), 4)).toEqual([]);
      expect(pending([pair("1.4.0", true)], ledger, Date.now(), 4)).toHaveLength(1);
      expect(pending([pair("1.3.0", true)], ledger, Date.now(), 4)).toEqual([]);
      expect(pending([pair("1.5.0", false)], ledger, Date.now(), 4)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
