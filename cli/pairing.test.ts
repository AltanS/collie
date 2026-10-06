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
import { capture, context, type FakeFiles, fakeExec, fakeFiles, type SeededFiles, STATE } from "./fakes.ts";
import { EXIT } from "./io.ts";
import {
  cmdDevices,
  cmdDevicesClearExpiry,
  cmdDevicesList,
  cmdDevicesRevoke,
  cmdDevicesSetExpiry,
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

/** A tailnet that answers, so `pair` has a URL to draw; `status` of `{}` is a tailnet with no name. */
const tailnetExec = (status = '{"Self":{"DNSName":"host.example."}}') =>
  fakeExec({
    answers: [
      ["tailscale status --json", { stdout: status }],
      ["timeout 3 /fake/tailscale debug netmap", { stdout: '{"PacketFilter":[{"SrcIPs":["*"]}]}' }],
    ],
  });

function deps(
  seed: Record<string, string> = {},
  status?: string,
): PairingDeps & { io: ReturnType<typeof capture>; files: FakeFiles } {
  const io = capture();
  const files = fakeFiles(seed);
  return { ctx: context(), io, files, exec: tailnetExec(status), now: () => NOW, random: fixedRandom(0) };
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
  test("writes the pending file the bridge reads — owner-only, hash only, never the code", async () => {
    const d = deps();
    expect(await cmdPair(d)).toBe(EXIT.OK);

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

  test("prints the code, its expiry and where to type it — and never mentions a restart", async () => {
    const d = deps();
    await cmdPair(d);
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

  test("a second pair replaces the pending file and says the earlier code is dead", async () => {
    const d = deps();
    await cmdPair(d);
    const first = d.io.stdout[0]!;
    const second = { ...d, io: capture(), random: fixedRandom(1) };
    expect(await cmdPair(second)).toBe(EXIT.OK);

    const later = second.io.stdout[0]!;
    expect(later).not.toBe(first);
    expect(second.io.stdout.join("\n")).toContain("earlier `collie pair`");
    // Exactly one pending pairing exists, and it is the newer one.
    expect(coercePending(JSON.parse(d.files.entries.get(PENDING)!.text))!.codeHash).toBe(
      sha256Hex(later),
    );
  });

  test("the first pair does not claim to have killed a code that never existed", async () => {
    const d = deps();
    await cmdPair(d);
    expect(d.io.stdout.join("\n")).not.toContain("earlier");
  });

  test("the code is also a QR that opens Settings with it filled in", async () => {
    const d = deps();
    expect(await cmdPair(d)).toBe(EXIT.OK);
    const code = d.io.stdout[0]!;
    const out = d.io.stdout.join("\n");
    // The bare code still leads: a QR is the second way to carry it, never the only one.
    expect(out).toContain(`https://host.example/settings?pair=${code}`);
    // No fragment: the browser focuses a fragment target on load, which would take focus off the
    // name field the phone is meant to land on.
    expect(out).not.toContain("#paired-devices");
    expect(out).toContain("\u2588");
    expect(out).toContain("Scan it:");
    expect(d.io.stderr).toEqual([]);
  });

  test("no tailnet name costs the QR and nothing else — the code is already on disk", async () => {
    const d = deps({}, "{}");
    expect(await cmdPair(d)).toBe(EXIT.OK);
    expect(d.io.stdout[0]).toHaveLength(CODE_LENGTH);
    expect(d.files.entries.has(PENDING)).toBe(true);
    expect(d.io.stdout.join("\n")).toContain("No QR:");
    // `urlToEncode` already said why, on stderr, in its own words.
    expect(d.io.stderr.join("\n")).toContain("tailnet front door isn't up");
  });

  test("no --expires writes the pending file without a token lifetime, exactly as before", async () => {
    const d = deps();
    expect(await cmdPair(d)).toBe(EXIT.OK);
    expect(Object.keys(JSON.parse(d.files.entries.get(PENDING)!.text))).toEqual([
      "codeHash",
      "expiresAt",
      "attemptsLeft",
    ]);
    expect(d.io.stdout.join("\n")).not.toContain("stops working");
  });

  test("--expires 30d puts the token lifetime on the pending code and says so", async () => {
    for (const args of [["--expires", "30d"], ["--expires=30d"]]) {
      const d = deps();
      expect(await cmdPair(d, args)).toBe(EXIT.OK);
      const pending = coercePending(JSON.parse(d.files.entries.get(PENDING)!.text));
      expect(pending!.tokenLifetimeMs).toBe(30 * 86_400_000);
      // The CODE's own ten minutes are untouched by the token's lifetime.
      expect(pending!.expiresAt).toBe(NOW + CODE_TTL_MS);
      expect(d.io.stdout.join("\n")).toContain("30 days after it pairs");
    }
  });

  test("a bad duration is a usage error and mints no code", async () => {
    for (const bad of ["0d", "-1d", "30", "30m", "abc", "1.5d", "99999w"]) {
      const d = deps();
      expect(await cmdPair(d, ["--expires", bad])).toBe(EXIT.USAGE);
      expect(d.files.entries.has(PENDING)).toBe(false);
      expect(d.io.stdout).toEqual([]);
      expect(d.io.stderr.join("\n")).toContain("usage: collie pair [--expires <duration>]");
    }
  });

  test("--expires with no value, and an unknown argument, are refused rather than ignored", async () => {
    for (const args of [["--expires"], ["--expire", "30d"], ["30d"]]) {
      const d = deps();
      expect(await cmdPair(d, args)).toBe(EXIT.USAGE);
      expect(d.files.entries.has(PENDING)).toBe(false);
    }
  });

  test("an unwritable state dir is an operational failure, not a code the phone can never spend", async () => {
    const d = deps();
    d.files.write = () => {
      throw new Error("EROFS: read-only file system");
    };
    expect(await cmdPair(d)).toBe(EXIT.FAIL);
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

  test("the expiry column: no expiry, a date ahead, or EXPIRED", () => {
    const d = deps(
      registryFile(
        device({ label: "pixel" }),
        device({ label: "ipad", expiresAt: NOW + 86_400_000 }),
        device({ label: "old", expiresAt: NOW - 1 }),
      ),
    );
    expect(cmdDevicesList(d)).toBe(EXIT.OK);
    expect(d.io.stdout[0]).toContain("no expiry");
    expect(d.io.stdout[1]).toContain(`expires ${new Date(NOW + 86_400_000).toISOString()}`);
    expect(d.io.stdout[2]).toContain(`EXPIRED ${new Date(NOW - 1).toISOString()}`);
    // One closing line says what an expired entry still does, and what to do about it.
    expect(d.io.stdout[3]).toContain("revoke it");
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

/** The registry `deps` holds after a verb wrote it. */
function writtenDevices(d: ReturnType<typeof deps>): PairedDevice[] {
  // SAFETY: the file is the registry the verb under test just wrote — `{ devices: [...] }` is the
  // only shape it serialises.
  return (JSON.parse(d.files.entries.get(REGISTRY)!.text) as { devices: PairedDevice[] }).devices;
}

describe("collie devices set-expiry / clear-expiry", () => {
  test("set-expiry stamps now + duration on that device only, owner-only", () => {
    const d = deps(registryFile(device({ label: "pixel" }), device({ label: "ipad" })));
    expect(cmdDevicesSetExpiry(d, ["pixel", "12h"])).toBe(EXIT.OK);
    expect(d.files.entries.get(REGISTRY)!.mode).toBe(0o600);
    const [pixel, ipad] = writtenDevices(d);
    expect(pixel!.expiresAt).toBe(NOW + 12 * 3_600_000);
    expect("expiresAt" in ipad!).toBe(false);
    const out = d.io.stdout.join("\n");
    expect(out).toContain(new Date(NOW + 12 * 3_600_000).toISOString());
    expect(out).toContain("12 hours from now");
  });

  test("set-expiry gives an expired device a fresh lifetime", () => {
    const d = deps(registryFile(device({ label: "pixel", expiresAt: NOW - 1 })));
    expect(cmdDevicesSetExpiry(d, ["pixel", "2w"])).toBe(EXIT.OK);
    expect(writtenDevices(d)[0]!.expiresAt).toBe(NOW + 14 * 86_400_000);
  });

  test("clear-expiry removes the key, so the entry is shaped like one that never had it", () => {
    const d = deps(registryFile(device({ label: "pixel", expiresAt: NOW + 1000 })));
    expect(cmdDevicesClearExpiry(d, ["pixel"])).toBe(EXIT.OK);
    expect(writtenDevices(d)).toEqual([device({ label: "pixel" })]);
    expect(d.io.stdout.join("\n")).toContain("no longer expires");
  });

  test("clear-expiry on a device without one says so and writes nothing", () => {
    const seed = registryFile(device({ label: "pixel" }));
    const d = deps(seed);
    expect(cmdDevicesClearExpiry(d, ["pixel"])).toBe(EXIT.OK);
    expect(d.files.entries.get(REGISTRY)!.text).toBe(seed[REGISTRY]!);
    expect(d.io.stdout.join("\n")).toContain("nothing to clear");
  });

  test("an unknown label fails, names the paired labels, and writes nothing", () => {
    for (const run of [
      (d: ReturnType<typeof deps>) => cmdDevicesSetExpiry(d, ["nope", "30d"]),
      (d: ReturnType<typeof deps>) => cmdDevicesClearExpiry(d, ["nope"]),
    ]) {
      const seed = registryFile(device({ label: "pixel", expiresAt: NOW + 1 }));
      const d = deps(seed);
      expect(run(d)).toBe(EXIT.FAIL);
      expect(d.io.stderr.join("\n")).toContain("no paired device labelled `nope`");
      expect(d.io.stderr.join("\n")).toContain("pixel");
      expect(d.files.entries.get(REGISTRY)!.text).toBe(seed[REGISTRY]!);
    }
  });

  test("a case-insensitive label is accepted when unique, and an ambiguous one lists the matches", () => {
    const unique = deps(registryFile(device({ label: "Pixel" })));
    expect(cmdDevicesSetExpiry(unique, ["pixel", "1d"])).toBe(EXIT.OK);
    expect(writtenDevices(unique)[0]!.expiresAt).toBe(NOW + 86_400_000);

    const seed = registryFile(device({ label: "Pixel" }), device({ label: "PIXEL" }));
    const ambiguous = deps(seed);
    expect(cmdDevicesSetExpiry(ambiguous, ["pixel", "1d"])).toBe(EXIT.FAIL);
    const err = ambiguous.io.stderr.join("\n");
    expect(err).toContain("more than one paired device: Pixel, PIXEL");
    expect(ambiguous.files.entries.get(REGISTRY)!.text).toBe(seed[REGISTRY]!);
    // An exact match always wins over the folded ones.
    const exact = deps(seed);
    expect(cmdDevicesSetExpiry(exact, ["PIXEL", "1d"])).toBe(EXIT.OK);
    expect(writtenDevices(exact).map((x) => x.expiresAt)).toEqual([undefined, NOW + 86_400_000]);
  });

  test("a bad duration or a missing argument is a usage error and writes nothing", () => {
    for (const args of [["pixel", "0d"], ["pixel", "-3d"], ["pixel", "soon"], ["pixel"], [], ["pixel", "1d", "extra"]]) {
      const seed = registryFile(device({ label: "pixel" }));
      const d = deps(seed);
      expect(cmdDevicesSetExpiry(d, args)).toBe(EXIT.USAGE);
      expect(d.files.entries.get(REGISTRY)!.text).toBe(seed[REGISTRY]!);
    }
    const clear = deps(registryFile(device()));
    expect(cmdDevicesClearExpiry(clear, [])).toBe(EXIT.USAGE);
    expect(clear.io.stderr.join("\n")).toContain("usage: collie devices clear-expiry <label>");
  });
});

describe("the devices parent verb", () => {
  test("routes its sub-verbs", () => {
    const list = deps();
    expect(cmdDevices(list, ["list"])).toBe(EXIT.OK);
    expect(list.io.stdout.join("\n")).toContain("no devices paired");

    const revoke = deps(registryFile(device({ label: "pixel" })));
    expect(cmdDevices(revoke, ["revoke", "pixel"])).toBe(EXIT.OK);
    expect(revoke.io.stdout.join("\n")).toContain("revoked");

    const set = deps(registryFile(device({ label: "pixel" })));
    expect(cmdDevices(set, ["set-expiry", "pixel", "30d"])).toBe(EXIT.OK);
    const clear = deps(registryFile(device({ label: "pixel", expiresAt: NOW })));
    expect(cmdDevices(clear, ["clear-expiry", "pixel"])).toBe(EXIT.OK);
  });

  test("bare, `help` and a misspelt sub-verb all print the usage block naming every sub-verb", () => {
    for (const args of [[], ["help"], ["lst"]]) {
      const d = deps();
      expect(cmdDevices(d, args)).toBe(EXIT.USAGE);
      const err = d.io.stderr.join("\n");
      expect(err).toContain("usage: collie devices {list|revoke|set-expiry|clear-expiry}");
      expect(err).toContain("list ");
      expect(err).toContain("revoke ");
      expect(err).toContain("set-expiry ");
      expect(err).toContain("clear-expiry ");
      // Only a real mistake is called one.
      expect(err.includes("unknown devices subcommand")).toBe(args[0] === "lst");
    }
  });
});
