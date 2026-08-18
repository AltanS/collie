import { describe, expect, test } from "bun:test";

import {
  CODE_ALPHABET,
  CODE_ATTEMPTS,
  CODE_LENGTH,
  CODE_TTL_MS,
  coercePending,
  DEVICES_FILENAME,
  type PairedDevice,
  PENDING_FILENAME,
  sha256Hex,
} from "../bridge/pairing.ts";
import { capture, context, type FakeFiles, fakeFiles, type SeededFiles, STATE } from "./fakes.ts";
import { EXIT } from "./io.ts";
import {
  cmdDevices,
  cmdDevicesList,
  cmdDevicesRevoke,
  cmdPair,
  type PairingDeps,
} from "./pairing.ts";

// The two operator-side verbs of device pairing, against fake seams. What is asserted here is what
// only these verbs own: the file that lands under the state dir (path, mode, shape), and the exact
// words the operator reads. Every decision inside them — the code alphabet, the TTL, the registry
// coercion — belongs to `bridge/pairing.ts` and is pinned in its own suite.

const PENDING = `${STATE}/${PENDING_FILENAME}`;
const REGISTRY = `${STATE}/${DEVICES_FILENAME}`;
const NOW = 1_700_000_000_000;

/** Deterministic entropy: a fixed byte per position, so the minted code is a fixed string. */
const fixedRandom = (byte: number) => (n: number) => Buffer.alloc(n, byte);

function deps(seed: Record<string, string> = {}): PairingDeps & { io: ReturnType<typeof capture>; files: FakeFiles } {
  const io = capture();
  const files = fakeFiles(seed);
  return { ctx: context(), io, files, now: () => NOW, random: fixedRandom(0) };
}

function device(over: Partial<PairedDevice> = {}): PairedDevice {
  return {
    label: "phone",
    tokenHash: sha256Hex("t"),
    createdAt: NOW - 86_400_000,
    lastSeenAt: NOW - 60_000,
    ...over,
  };
}

const registryFile = (...devices: PairedDevice[]): SeededFiles => ({
  [REGISTRY]: JSON.stringify({ devices }),
});

describe("collie pair", () => {
  test("writes the pending file the bridge reads — owner-only, hash only, never the code", () => {
    const d = deps();
    expect(cmdPair(d)).toBe(EXIT.OK);

    const entry = d.files.entries.get(PENDING);
    expect(entry).toBeDefined();
    expect(entry!.mode).toBe(0o600);
    const pending = coercePending(JSON.parse(entry!.text));
    expect(pending).not.toBeNull();

    const code = d.io.stdout[0]!;
    expect(code).toHaveLength(CODE_LENGTH);
    for (const ch of code) expect(CODE_ALPHABET).toContain(ch);
    // The printed code is the only copy: the file holds its hash and nothing else.
    expect(entry!.text).not.toContain(code);
    expect(pending!.codeHash).toBe(sha256Hex(code));
    expect(pending!.expiresAt).toBe(NOW + CODE_TTL_MS);
    expect(pending!.attemptsLeft).toBe(CODE_ATTEMPTS);
  });

  test("prints the code, its expiry and where to type it — and never mentions a restart", () => {
    const d = deps();
    cmdPair(d);
    const out = d.io.stdout.join("\n");
    expect(d.io.stderr).toEqual([]);
    expect(out).toContain(new Date(NOW + CODE_TTL_MS).toISOString());
    expect(out).toContain("10 minutes");
    expect(out).toContain("single-use");
    expect(out).toContain("Settings");
    expect(out).not.toContain("restart collie");
    // The bare code is the first line, undecorated, so it can be read off or piped.
    expect(d.io.stdout[0]).toBe(d.io.stdout[0]!.trim());
    expect(d.io.stdout[1]).toBe("");
  });

  test("a second pair replaces the pending file and says the earlier code is dead", () => {
    const d = deps();
    cmdPair(d);
    const first = d.io.stdout[0]!;
    const second = { ...d, io: capture(), random: fixedRandom(1) };
    expect(cmdPair(second)).toBe(EXIT.OK);

    const later = second.io.stdout[0]!;
    expect(later).not.toBe(first);
    expect(second.io.stdout.join("\n")).toContain("earlier `collie pair`");
    // Exactly one pending pairing exists, and it is the newer one.
    expect(coercePending(JSON.parse(d.files.entries.get(PENDING)!.text))!.codeHash).toBe(
      sha256Hex(later),
    );
  });

  test("the first pair does not claim to have killed a code that never existed", () => {
    const d = deps();
    cmdPair(d);
    expect(d.io.stdout.join("\n")).not.toContain("earlier");
  });

  test("an unwritable state dir is an operational failure, not a code the phone can never spend", () => {
    const d = deps();
    d.files.write = () => {
      throw new Error("EROFS: read-only file system");
    };
    expect(cmdPair(d)).toBe(EXIT.FAIL);
    expect(d.io.stderr.join("\n")).toContain("EROFS");
  });
});

describe("collie devices list", () => {
  test("an empty registry says pairing is not enforced, and points at `pair`", () => {
    const d = deps();
    expect(cmdDevicesList(d)).toBe(EXIT.OK);
    const out = d.io.stdout.join("\n");
    expect(out).toContain("no devices paired");
    expect(out).toContain("not enforced");
    expect(out).toContain("collie pair");
  });

  test("a missing, unreadable or malformed file reads as empty rather than throwing", () => {
    const seeds: Record<string, string>[] = [{}, { [REGISTRY]: "{" }, { [REGISTRY]: '{"devices":"nope"}' }];
    for (const seed of seeds) {
      const d = { ...deps(seed) };
      expect(cmdDevicesList(d)).toBe(EXIT.OK);
      expect(d.io.stdout.join("\n")).toContain("no devices paired");
    }
  });

  test("one line per device: label, created, last seen", () => {
    const d = deps(
      registryFile(device({ label: "pixel" }), device({ label: "ipad", lastSeenAt: 0 })),
    );
    expect(cmdDevicesList(d)).toBe(EXIT.OK);
    expect(d.io.stdout).toHaveLength(2);
    expect(d.io.stdout[0]).toContain("pixel");
    expect(d.io.stdout[0]).toContain(new Date(NOW - 86_400_000).toISOString());
    expect(d.io.stdout[0]).toContain(new Date(NOW - 60_000).toISOString());
    // A device that has never made a request reads as `never`, not as the epoch.
    expect(d.io.stdout[1]).toContain("never");
    expect(d.io.stdout[1]).not.toContain("1970");
  });

  test("no token hash is ever printed — the registry's secrets stay in the file", () => {
    const d = deps(registryFile(device()));
    cmdDevicesList(d);
    expect(d.io.stdout.join("\n")).not.toContain(sha256Hex("t"));
  });

  test("listing writes nothing", () => {
    const d = deps(registryFile(device()));
    cmdDevicesList(d);
    expect(d.files.entries.get(REGISTRY)!.text).toBe(JSON.stringify({ devices: [device()] }));
  });
});

describe("collie devices revoke", () => {
  test("drops the named device, keeps the rest, and says no restart is needed", () => {
    const d = deps(registryFile(device({ label: "pixel" }), device({ label: "ipad" })));
    expect(cmdDevicesRevoke(d, ["pixel"])).toBe(EXIT.OK);

    const entry = d.files.entries.get(REGISTRY)!;
    expect(entry.mode).toBe(0o600);
    // SAFETY: the file is the registry `cmdDevicesRevoke` just wrote — `{ devices: [...] }` is the
    // only shape it serialises, and the labels read off it are what the next line asserts.
    const labels = (JSON.parse(entry.text) as { devices: PairedDevice[] }).devices.map((x) => x.label);
    expect(labels).toEqual(["ipad"]);
    const out = d.io.stdout.join("\n");
    expect(out).toContain("pixel");
    expect(out).toContain("next request");
    expect(out).toContain("no restart");
  });

  test("revoking the last device says pairing is no longer enforced", () => {
    const d = deps(registryFile(device({ label: "pixel" })));
    expect(cmdDevicesRevoke(d, ["pixel"])).toBe(EXIT.OK);
    expect(d.io.stdout.join("\n")).toContain("no longer enforced");
    expect(JSON.parse(d.files.entries.get(REGISTRY)!.text)).toEqual({ devices: [] });
  });

  test("an unknown label fails, names the labels that do exist, and writes nothing", () => {
    const d = deps(registryFile(device({ label: "pixel" })));
    expect(cmdDevicesRevoke(d, ["nope"])).toBe(EXIT.FAIL);
    expect(d.io.stdout).toEqual([]);
    expect(d.io.stderr.join("\n")).toContain("no paired device labelled `nope`");
    expect(d.io.stderr.join("\n")).toContain("pixel");
    expect(d.files.entries.get(REGISTRY)!.text).toBe(
      JSON.stringify({ devices: [device({ label: "pixel" })] }),
    );
  });

  test("a revoke against an empty registry says so rather than listing nothing", () => {
    const d = deps();
    expect(cmdDevicesRevoke(d, ["pixel"])).toBe(EXIT.FAIL);
    expect(d.io.stderr.join("\n")).toContain("nothing is paired");
    expect(d.files.entries.has(REGISTRY)).toBe(false);
  });

  test("a missing label is a usage error, not a revocation of something", () => {
    for (const args of [[], [""]]) {
      const d = deps(registryFile(device()));
      expect(cmdDevicesRevoke(d, args)).toBe(EXIT.USAGE);
      expect(d.io.stderr.join("\n")).toContain("usage: collie devices revoke <label>");
    }
  });

  test("a write that fails is reported, not silently reported as a revocation", () => {
    const d = deps(registryFile(device({ label: "pixel" })));
    d.files.write = () => {
      throw new Error("ENOSPC");
    };
    expect(cmdDevicesRevoke(d, ["pixel"])).toBe(EXIT.FAIL);
    expect(d.io.stdout).toEqual([]);
    expect(d.io.stderr.join("\n")).toContain("ENOSPC");
  });
});

describe("the devices parent verb", () => {
  test("routes its two sub-verbs", () => {
    const list = deps();
    expect(cmdDevices(list, ["list"])).toBe(EXIT.OK);
    expect(list.io.stdout.join("\n")).toContain("no devices paired");

    const revoke = deps(registryFile(device({ label: "pixel" })));
    expect(cmdDevices(revoke, ["revoke", "pixel"])).toBe(EXIT.OK);
    expect(revoke.io.stdout.join("\n")).toContain("revoked");
  });

  test("bare, `help` and a misspelt sub-verb all print the usage block naming every sub-verb", () => {
    for (const args of [[], ["help"], ["lst"]]) {
      const d = deps();
      expect(cmdDevices(d, args)).toBe(EXIT.USAGE);
      const err = d.io.stderr.join("\n");
      expect(err).toContain("usage: collie devices {list|revoke}");
      expect(err).toContain("list ");
      expect(err).toContain("revoke ");
      // Only a real mistake is called one.
      expect(err.includes("unknown devices subcommand")).toBe(args[0] === "lst");
    }
  });
});
