import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { AuditLog, type AuditEntry } from "../bridge/audit.ts";
import { PACK_PROTOCOL_VERSION } from "../bridge/pack/enrollment.ts";
import { fp, leadStore, material, member, PACK, T0 } from "../bridge/pack/fixtures.ts";
import { serializeTrustStore, TrustStore, type TrustStoreData, type TrustStoreIo } from "../bridge/pack/trust-store.ts";
import { capture, context, fakeExec, fakeFiles, fakeOps, ROOT, type SeededOps } from "./fakes.ts";
import type { Environment } from "./context.ts";
import { EXIT } from "./io.ts";
import { cmdPack, type PackDeps } from "./pack.ts";
import {
  bindOverwriteConfirmation,
  cmdPackAdd,
  composeStdin,
  configureScript,
  enrollScript,
  installScript,
  membershipScript,
  packAddDeps,
  parseMembership,
  parseProbe,
  probeScript,
  restartScript,
  shq,
  sshOptions,
  STDIN_MARKER,
  type PackAddDeps,
  type RemoteResult,
} from "./remote.ts";
import { realExec } from "./sys.ts";

// `collie pack add` against fakes for every seam. **NOTHING here spawns `ssh` or reaches a network**:
// the transport is a function that records `(script, stdin)` pairs and answers from a table, the
// prompts are values, and the trust store is in memory. That is the same safety boundary
// `cli/fakes.ts` draws for the lifecycle verbs and `cli/pack.test.ts` draws for the pack verbs — a
// verb that installs software on another machine is exactly the one that must never be run for real
// by a test suite.

// ── The fake transport ───────────────────────────────────────────────────────

type Leg = "probe" | "install" | "configure" | "membership" | "enroll" | "restart";

/** Which leg a script is, read off the script itself — so a test never depends on call ordering. */
function legOf(script: string): Leg {
  if (script.includes("collie-probe:")) return "probe";
  if (script.includes("collie-install:")) return "install";
  if (script.includes("collie-configure:")) return "configure";
  if (script.includes("pack status --no-probe")) return "membership";
  if (script.includes('"$ROOT/bin/collie" restart')) return "restart";
  if (script.includes("'join'")) return "enroll";
  throw new Error(`unrecognised leg script:\n${script}`);
}

interface Recorded {
  leg: Leg;
  script: string;
  stdin: string | undefined;
}

const COMMIT = "abc123def4567890abc123def4567890abc123de";
const VERSION = "1.2.3";
const REMOTE_HOME = "/home/pat";
const REMOTE_CHECKOUT = `${REMOTE_HOME}/.collie`;
const TAILSCALE_JSON = JSON.stringify({ Self: { DNSName: "desk.tail.ts.net." } });

const PROBE_DEFAULTS = {
  home: REMOTE_HOME,
  git: "/usr/bin/git",
  bun: "/home/pat/.bun/bin/bun",
  herdr: "/usr/local/bin/herdr",
  configdir: "/home/pat/.config/herdr/plugins/config/herdr.collie",
  envhost: "",
  envport: "",
  checkout: "",
  commit: "",
  branch: "",
  dirty: "",
  dirtyfiles: "",
  version: "",
  address: "100.64.0.9",
  port: "free",
} satisfies Record<string, string>;

/** Leg 1's stdout, as the remote would print it. */
function probeOut(over: Record<string, string> = {}): string {
  const all = { ...PROBE_DEFAULTS, ...over };
  const lines = Object.entries(all).map(([k, v]) => `collie-probe:${k}=${v}`);
  return [...lines, "collie-probe:probe=ok", ""].join("\n");
}

const SOLO_STATUS = [
  "mode: solo — this collie is not in a pack (no trust store, or an empty one).",
  "  `collie pack invite` here makes it a lead; `collie join …` makes it a peer.",
].join("\n");

type LegAnswers = Partial<Record<Leg, Partial<RemoteResult>>>;

interface Harness {
  deps: PackAddDeps;
  io: ReturnType<typeof capture>;
  calls: Recorded[];
  closed: number;
  data(): TrustStoreData | null;
  restarts: number;
}

interface HarnessOptions {
  store?: TrustStoreData | null;
  answers?: LegAnswers;
  /** The whole result for a leg, bypassing the defaults — for `spawned:false` and ssh's own 255. */
  confirm?: boolean | null;
  prompt?: string | null;
  /** What the lead's store looks like when it is re-read after the join. */
  after?: TrustStoreData | null;
  /** Answers `hello` in the final verdict. `false` = the member does not answer. */
  reachable?: boolean;
  flags?: string[];
  /** Extra resolved env — `COLLIE_PUBLIC_URL` is the one that steers the lead's own address. */
  env?: Record<string, string>;
  /** Seed for the ops store — how `pack add` remembers a host it already reached. */
  ops?: SeededOps;
}

function harness(opts: HarnessOptions = {}): Harness {
  const initial = opts.store === undefined ? leadStore() : opts.store;
  let contents = initial === null ? null : serializeTrustStore(initial);
  const storeIo: TrustStoreIo = {
    read: async () => contents,
    write: async (_p, d) => {
      contents = d;
    },
  };
  const store = new TrustStore("/state", storeIo);
  const ops = fakeOps(opts.ops);
  const out = capture();
  const calls: Recorded[] = [];
  const audit: AuditEntry[] = [];
  let restarts = 0;
  let closed = 0;

  const exec = fakeExec({
    answers: [
      [`git -C ${ROOT} rev-parse HEAD`, { stdout: `${COMMIT}\n` }],
      [`git -C ${ROOT} status --porcelain`, { stdout: "" }],
      [`git -C ${ROOT} show ${COMMIT}:herdr-plugin.toml`, { stdout: `version = "${VERSION}"\n` }],
      ["tailscale status --json", { stdout: TAILSCALE_JSON }],
    ],
  });

  const deps: PackAddDeps = {
    // The same reason `cli/pack.test.ts` sets this: the real `setTimeout` in `PeerClient` must never
    // fire and report a fake peer as unreachable.
    ctx: context({ COLLIE_PACK_TIMEOUT_MS: "60000", ...opts.env }),
    io: out,
    exec,
    files: fakeFiles(),
    store,
    ops,
    // SAFETY: `AuditLog` hands its sink the line it just serialised from an `AuditEntry` — the
    // log's own round trip, not foreign input.
    audit: new AuditLog((l: string) => void audit.push(JSON.parse(l) as AuditEntry), { now: () => T0 }),
    fetch: async () =>
      opts.reachable === false
        ? Promise.reject(new Error("connection refused"))
        : new Response(JSON.stringify({ protocol: PACK_PROTOCOL_VERSION, member: "nas", version: VERSION }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-pack-protocol": String(PACK_PROTOCOL_VERSION),
              "x-pack-member": "nas",
            },
          }),
    now: () => T0,
    random: (() => {
      let i = 0;
      return () => `r${++i}`;
    })(),
    mintIdentity: () => Promise.resolve(material("fresh")),
    readStdin: () => Promise.resolve(""),
    restart: () => {
      restarts += 1;
      return Promise.resolve(EXIT.OK);
    },
    serve: () => Promise.resolve(EXIT.OK),
    unserve: () => EXIT.OK,
    clearNotifications: () => Promise.resolve(),
    remote: () => ({
      run: async (script, stdin) => {
        const leg = legOf(script);
        calls.push({ leg, script, stdin });
        const canned = opts.answers?.[leg] ?? {};
        const stdout =
          leg === "probe"
            ? probeOut()
            : leg === "membership"
              ? SOLO_STATUS
              : leg === "install"
                ? `collie-install:root=${REMOTE_CHECKOUT}\ncollie-install:version=${VERSION}`
                : "";
        const fallback: RemoteResult = { code: 0, stdout, stderr: "", spawned: true };
        return { ...fallback, ...canned };
      },
      close: () => {
        closed += 1;
      },
    }),
    confirm: () => (opts.confirm === undefined ? true : opts.confirm),
    prompt: () => opts.prompt ?? null,
    gitBundle: () => Promise.resolve("QkFTRTY0LWJ1bmRsZQ=="),
    reload: () =>
      Promise.resolve(
        opts.after === undefined
          ? leadStore({ peers: [member({ memberId: "nas", address: "100.64.0.9:8787" })] })
          : opts.after,
      ),
  };

  return {
    deps,
    io: out,
    calls,
    get closed() {
      return closed;
    },
    data: () => store.current(),
    get restarts() {
      return restarts;
    },
  };
}

const text = (io: ReturnType<typeof capture>): string => [...io.stdout, ...io.stderr].join("\n");
const run = (h: Harness, args: string[] = ["nas.example"]): Promise<number> => cmdPackAdd(h.deps, args);

// ── The generated scripts, pinned ────────────────────────────────────────────
// A leg script is a program that runs on someone ELSE's machine. Pinning the text is what stops a
// change to it landing invisibly; the rule tests below make "no `curl | sh`, no `PATH` assumption"
// mechanically checkable rather than a promise in a comment.

const GOLDEN: [file: string, script: string][] = [
  ["leg1-probe.sh", probeScript({ path: null, port: 8787 })],
  ["leg1-probe-path.sh", probeScript({ path: "/srv/collie", port: 9000 })],
  ["leg2-install.sh", installScript({ root: "/home/pat/.collie", commit: "abc123", version: "1.2.3" })],
  ["leg3-configure.sh", configureScript({ configDir: "/cfg", host: "100.1.2.3", port: 8787, instance: null })],
  [
    "leg3-configure-instance.sh",
    configureScript({ configDir: "/cfg", host: "100.1.2.3", port: 9000, instance: "v1" }),
  ],
  ["leg4-membership.sh", membershipScript("/home/pat/.collie")],
  // Not one of `pack add`'s legs — `pack update` drives it, and it is pinned here with the rest
  // because it is the same kind of thing: a program this machine writes and another one runs.
  ["restart.sh", restartScript("/home/pat/.collie")],
  [
    "leg4-enroll.sh",
    enrollScript({
      root: "/home/pat/.collie",
      leadAddress: "desk.tail.ts.net",
      peerAddress: "100.1.2.3:8787",
      label: "nas",
    }),
  ],
];

describe("the leg scripts", () => {
  for (const [file, script] of GOLDEN) {
    test(`${file} matches its golden file`, () => {
      expect(script).toBe(readFileSync(join(import.meta.dir, "testdata", file), "utf8"));
    });
  }

  test("nothing is piped into a shell, and nothing is fetched", () => {
    for (const [file, script] of GOLDEN) {
      expect(`${file}: ${script}`).not.toContain("curl");
      expect(`${file}: ${script}`).not.toContain("wget");
      expect(script).not.toMatch(/\|\s*(ba)?sh\b/);
    }
  });

  test("no script assumes a tool is on PATH — every one is resolved or absolute", () => {
    for (const [file, script] of GOLDEN) {
      for (const line of script.split("\n")) {
        // A line may NAME a tool as an argument (`collie_tool git`); it may never START with one.
        expect(`${file}: ${line}`).not.toMatch(/^\s*(git|bun|herdr|tailscale|ss|netstat|collie)\b/);
      }
    }
  });

  test("tool resolution is `command -v` then fixed-path `[ -x ]`, as the shim does it", () => {
    const probe = probeScript({ path: null, port: 8787 });
    expect(probe).toContain('command -v "$_n"');
    expect(probe).toContain('[ -x "$_c" ]');
    expect(probe).toContain('"${BUN_INSTALL:-$HOME/.bun}/bin/$_n"');
    // Only an ABSOLUTE answer from `command -v` is taken: it reports a shell function as a bare word.
    expect(probe).toContain("/*) printf '%s' \"$_p\"; return 0 ;;");
  });

  test("the config root is asked for on the remote, never composed here", () => {
    expect(probeScript({ path: null, port: 8787 })).toContain("plugin config-dir 'herdr.collie'");
  });

  test("remote writes are tmp → verify → rename", () => {
    const install = installScript({ root: "/r", commit: "c", version: "v" });
    // `git bundle verify` needs *a* repository, and cwd over ssh is $HOME — not one. A scratch repo
    // under $WORK is init'd first, and verify runs `-C` into it rather than bare from cwd.
    expect(install).toContain('"$GIT" init -q "$WORK/verify"');
    expect(install).toContain('"$GIT" -C "$WORK/verify" bundle verify "$WORK/bundle.part"');
    // The old bare-cwd verify swallowed stderr entirely; the new one captures it into the error.
    expect(install).not.toContain('"$GIT" bundle verify "$WORK/bundle.part" >/dev/null 2>&1');
    expect(install).toContain("did not verify: $VMSG");
    expect(install).toContain('mv "$WORK/bundle.part" "$WORK/bundle"');
    const configure = configureScript({ configDir: "/cfg", host: "h", port: 1, instance: null });
    expect(configure).toContain('[ -s "$TMP" ]');
    expect(configure).toContain('mv "$TMP" "$ENVFILE"');
  });

  test("the build is the shim's own bootstrap, not a second build path", () => {
    expect(installScript({ root: "/r", commit: "c", version: "v" })).toContain(
      '"$BUN" run cli/main.ts build',
    );
  });

  test("configure preserves values Collie did not set, and publishes no front door", () => {
    const script = configureScript({ configDir: "/cfg", host: "h", port: 1, instance: null });
    expect(script).toContain("grep -v -E");
    expect(script).not.toContain("tailscale");
    expect(script).not.toContain("serve");
  });

  test("`--insecure` is never passed on the operator's behalf", () => {
    for (const [, script] of GOLDEN) expect(script).not.toContain("insecure");
  });

  test("shq closes a single quote rather than trusting the value", () => {
    expect(shq("a'b")).toBe(`'a'\\''b'`);
    expect(shq("; rm -rf /")).toBe(`'; rm -rf /'`);
  });
});

// ── The transport contract ───────────────────────────────────────────────────

describe("the ssh options", () => {
  test("one multiplexed control socket, batch mode, keepalives", () => {
    const opts = sshOptions("/tmp/x/s").join(" ");
    expect(opts).toContain("ControlMaster=auto");
    expect(opts).toContain("ControlPath=/tmp/x/s");
    expect(opts).toContain("ControlPersist=60");
    expect(opts).toContain("BatchMode=yes");
    expect(opts).toContain("ServerAliveInterval=15");
    expect(opts).toContain("ServerAliveCountMax=4");
  });

  test("the host-key policy is never touched, in either direction", () => {
    // The operator's `known_hosts` is ridden, never reimplemented (ADR 0015). A host whose key
    // changed must fail the way `ssh` fails.
    expect(sshOptions("/tmp/x/s").join(" ")).not.toContain("StrictHostKeyChecking");
    expect(readFileSync(join(import.meta.dir, "remote.ts"), "utf8")).not.toContain("StrictHostKeyChecking");
  });
});

describe("composeStdin", () => {
  test("splices the payload in at the marker", () => {
    expect(composeStdin(`a\n${STDIN_MARKER}\nb\n`, "PAYLOAD")).toBe("a\nPAYLOAD\nb\n");
  });

  test("a script with no marker may not be given a payload, and vice versa", () => {
    expect(() => composeStdin("a\n", "P")).toThrow();
    expect(() => composeStdin(`a\n${STDIN_MARKER}\n`, undefined)).toThrow();
  });

  test("a payload that could close the heredoc early is refused, not trusted", () => {
    expect(() => composeStdin(`${STDIN_MARKER}\n`, "x\n__COLLIE_PAYLOAD__\nrm -rf /")).toThrow();
  });
});

// ── Parsers ──────────────────────────────────────────────────────────────────

describe("parseProbe", () => {
  test("reads the fields and requires the end sentinel", () => {
    const probe = parseProbe(probeOut({ checkout: "/x", commit: "deadbeef" }));
    expect(probe?.checkout).toBe("/x");
    expect(probe?.commit).toBe("deadbeef");
    expect(probe?.home).toBe(REMOTE_HOME);
  });

  test("a half-finished answer is unparseable, not a probe that said no", () => {
    expect(parseProbe("collie-probe:git=/usr/bin/git\n")).toBeNull();
    expect(parseProbe("bash: line 1: syntax error")).toBeNull();
  });

  test("an absent field reads as empty, never as undefined", () => {
    expect(parseProbe("collie-probe:probe=ok")?.address).toBe("");
  });
});

describe("parseMembership", () => {
  test("solo", () => {
    expect(parseMembership(SOLO_STATUS)).toEqual({ packId: null, packName: null, memberId: null });
  });

  test("a member of a pack", () => {
    const status = ["pack   the herd  (pack-1)", "mode   peer", "self   nas  abcd…"].join("\n");
    expect(parseMembership(status)).toEqual({ packId: "pack-1", packName: "the herd", memberId: "nas" });
  });

  test("a shape this build cannot read fails rather than assuming solo", () => {
    expect(parseMembership("who knows")).toBeNull();
  });
});

// ── The verb ─────────────────────────────────────────────────────────────────

describe("collie pack add", () => {
  test("no host is a usage error", async () => {
    const h = harness();
    expect(await run(h, [])).toBe(EXIT.USAGE);
    expect(h.calls).toHaveLength(0);
  });

  test("a peer refuses: peers are added from the lead", async () => {
    const h = harness({ store: leadStore({ lead: member({ memberId: "desk", role: "lead" }) }) });
    expect(await run(h)).toBe(EXIT.STATE);
    expect(text(h.io)).toContain("peers are added from the lead");
  });

  test("green-field: four legs, in order, and a non-provisional member at the end", async () => {
    const h = harness();
    expect(await run(h)).toBe(EXIT.OK);
    expect(h.calls.map((c) => c.leg)).toEqual(["probe", "install", "configure", "membership", "enroll"]);
    expect(text(h.io)).toContain('✓ "nas" is a member of "the herd"');
    // The bind the lead will dial, written from a value READ off the remote (ADR 0015).
    expect(h.calls[2]!.script).toContain("printf 'COLLIE_HOST=%s\\n' '100.64.0.9'");
    expect(h.calls[4]!.script).toContain("'--address' '100.64.0.9:8787'");
  });

  // Q2: the probe is one `ss -ltn` at one instant. Over a unit that crash-loops on a five-second
  // timer the port is genuinely idle for most of every cycle, so `free` claimed a durable property
  // the probe never observed. It now reports what it saw, and when.
  test("an idle port is reported as an observation, not as a property", async () => {
    const h = harness();
    expect(await run(h)).toBe(EXIT.OK);
    expect(text(h.io)).toContain("nothing was listening just now");
    expect(text(h.io)).not.toContain("8787 free");
  });

  test("a COLLIE_PUBLIC_URL lead address is used, and named once so it is not a silent steer", async () => {
    const h = harness({ env: { COLLIE_PUBLIC_URL: "https://collie.example.com" } });
    expect(await run(h)).toBe(EXIT.OK);
    expect(text(h.io)).toContain("lead address https://collie.example.com (from COLLIE_PUBLIC_URL)");
    // …and it is what the peer is actually told to dial, not just what was printed.
    expect(h.calls.find((c) => c.leg === "enroll")!.script).toContain("'https://collie.example.com'");
  });

  test("the control socket is torn down on every exit path, including a failure", async () => {
    const ok = harness();
    await run(ok);
    expect(ok.closed).toBe(1);
    const bad = harness({ answers: { probe: { spawned: false, code: 127, stderr: "no ssh" } } });
    await run(bad);
    expect(bad.closed).toBe(1);
  });

  test("the minted token appears ONLY in stdin — never in a script, never in the transcript", async () => {
    const h = harness();
    expect(await run(h)).toBe(EXIT.OK);
    const enroll = h.calls.find((c) => c.leg === "enroll")!;
    const [token, fingerprint] = enroll.stdin!.split(".");
    expect(fingerprint).toBe(fp("desk"));
    expect(token).toBeTruthy();
    for (const call of h.calls) {
      expect(call.script).not.toContain(token!);
      if (call.leg !== "enroll") expect(call.stdin ?? "").not.toContain(token!);
    }
    expect(text(h.io)).not.toContain(token!);
  });

  // F8: `--peer-address 192.168.77.2:8787` was concatenated with `--port`, printed as
  // `192.168.77.2:8787:8787`, and written into the member's COLLIE_HOST — an address `Bun.serve` can
  // never bind. The member was left half-enrolled with a dead service.
  test("a --peer-address that is not a bare host is refused BEFORE any ssh runs", async () => {
    for (const bad of [
      "192.168.77.2:8787",
      "https://192.168.77.2",
      "192.168.77.2/collie",
      "op@192.168.77.2",
      "[fd7a::1]:8787",
      "[fd7a::1]",
      " 192.168.77.2 ",
    ]) {
      const h = harness();
      expect(await run(h, ["nas.example", "--peer-address", bad])).toBe(EXIT.USAGE);
      // The whole point of the finding: nothing was pushed, built, written or restarted.
      expect(h.calls).toHaveLength(0);
      expect(h.restarts).toBe(0);
      expect(text(h.io)).toContain("is not a bind address");
      expect(text(h.io)).toContain("Give a BARE HOST");
      expect(text(h.io)).toContain("--port");
    }
  });

  test("a bare host — name, IPv4 or an unbracketed IPv6 literal — is accepted", async () => {
    for (const good of ["192.168.77.2", "collie-2.tail1234.ts.net", "fd7a::1"]) {
      const h = harness();
      expect(await run(h, ["nas.example", "--peer-address", good])).toBe(EXIT.OK);
      expect(h.calls[2]!.script).toContain(`printf 'COLLIE_HOST=%s\\n' '${good}'`);
    }
  });

  // F9: the refusal came from `collie join` on the FAR machine, after the bundle push, the remote
  // build, the .env write and two lead restarts — and it named `--insecure`, which `pack add` does
  // not accept. Re-running with the flag produced the identical refusal: a closed loop with no exit.
  test("an http:// lead address is refused at parse time, naming a remedy that exists", async () => {
    for (const [args, env] of [
      [["nas.example", "--address", "http://192.168.77.1:8787"], {}],
      [["nas.example"], { COLLIE_PUBLIC_URL: "http://192.168.77.1:8787" }],
    ] as const) {
      const h = harness({ env });
      expect(await run(h, [...args])).toBe(EXIT.USAGE);
      expect(h.calls).toHaveLength(0);
      expect(h.restarts).toBe(0);
      const said = text(h.io);
      expect(said).toContain("in the clear");
      expect(said).toContain("`pack add` has no --insecure and will not get one");
      expect(said).toContain("collie join <lead-address> <token> --insecure` THERE");
      expect(said).toContain("Nothing was pushed, built or restarted.");
    }
  });

  test("https:// and a scheme-less address are untouched", async () => {
    const flagged = harness();
    expect(await run(flagged, ["nas.example", "--address", "https://collie.example.com"])).toBe(EXIT.OK);
    const bare = harness();
    expect(await run(bare, ["nas.example", "--address", "collie.example.com:8787"])).toBe(EXIT.OK);
  });

  test("a value typed at the prompt is held to the same rule", async () => {
    const h = harness({ prompt: "192.168.77.2:8787", answers: { probe: { stdout: probeOut({ address: "" }) } } });
    expect(await run(h)).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("is not a bind address");
    // The prompt comes after leg 1, so the probe has run — but nothing was installed or written.
    expect(h.calls.map((c) => c.leg)).toEqual(["probe"]);
  });

  test("the lead is restarted so its running bridge can answer the invite", async () => {
    const h = harness();
    await run(h);
    // Once for the invite, once so the new member takes effect. Both are the same reason the other
    // pack verbs restart: the trust store is read once per process.
    expect(h.restarts).toBe(2);
  });
});

// ── Error families ───────────────────────────────────────────────────────────

describe("the three error families", () => {
  test("ssh never started is UNREACHABLE, and says so", async () => {
    const h = harness({ answers: { probe: { spawned: false, code: 127, stderr: "no `ssh` on this machine" } } });
    expect(await run(h)).toBe(EXIT.UNREACHABLE);
    expect(text(h.io)).toContain("could not start ssh");
  });

  test("ssh's own 255 is UNREACHABLE", async () => {
    const h = harness({ answers: { probe: { code: 255, stderr: "ssh: connect to host nas.example port 22: No route to host" } } });
    expect(await run(h)).toBe(EXIT.UNREACHABLE);
    expect(text(h.io)).toContain("No route to host");
    expect(text(h.io)).not.toContain("ssh-add");
  });

  test("a publickey refusal adds the `ssh-add` hint — keyed off ssh's actual stderr", async () => {
    const h = harness({
      answers: { probe: { code: 255, stderr: "pat@nas.example: Permission denied (publickey,password)." } },
    });
    expect(await run(h)).toBe(EXIT.UNREACHABLE);
    expect(text(h.io)).toContain("`ssh-add`");
  });

  test("an answer this build cannot read is FAIL, not a probe that said no", async () => {
    const h = harness({ answers: { probe: { code: 0, stdout: "sh: 1: Syntax error" } } });
    expect(await run(h)).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("something this build cannot read");
  });

  test("a missing prerequisite is FAIL with one install hint each", async () => {
    for (const [tool, needle] of [
      ["git", "no `git`"],
      ["bun", "https://bun.sh"],
      ["herdr", "discussion #67"],
    ] as const) {
      const h = harness({ answers: { probe: { stdout: probeOut({ [tool]: "" }) } } });
      expect(await run(h)).toBe(EXIT.FAIL);
      expect(text(h.io)).toContain(needle);
      expect(h.calls).toHaveLength(1);
    }
  });

  test("Herdr present but no config dir stops legibly, naming what was asked", async () => {
    const h = harness({ answers: { probe: { stdout: probeOut({ configdir: "" }) } } });
    expect(await run(h)).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("plugin config-dir herdr.collie");
    expect(text(h.io)).toContain("never invents a path it did not observe");
  });

  test("a failed remote build is FAIL, and the checkout is left in place", async () => {
    const h = harness({ answers: { install: { code: 24, stderr: "error: the build failed on this machine" } } });
    expect(await run(h)).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("was left in place");
    expect(h.calls.map((c) => c.leg)).toEqual(["probe", "install"]);
  });

  test("the quoted line is the install script's own verdict, not git's first warning", async () => {
    // The field shape: `git fetch` warns harmlessly on the way in, and the build dies further down.
    // Quoting the first line said "updateshallow is ignored", which is not why anything failed.
    const h = harness({
      answers: {
        install: {
          code: 24,
          stderr: [
            'warning: option "updateshallow" is ignored for a bundle',
            "error: Cannot find package 'commander' from '/home/pat/.collie/cli/main.ts'",
            "error: the build failed on this machine",
          ].join("\n"),
        },
      },
    });
    expect(await run(h)).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("the install failed on nas.example — error: the build failed on this machine");
    expect(text(h.io)).not.toContain("updateshallow");
  });

  test("a leg that died before its own verdict is still quoted", async () => {
    const h = harness({ answers: { install: { code: 2, stderr: "sh: line 12: syntax error near unexpected token" } } });
    expect(await run(h)).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("syntax error near unexpected token");
  });

  test("a port collision stops before anything is installed", async () => {
    const h = harness({ answers: { probe: { stdout: probeOut({ port: "busy" }) } } });
    expect(await run(h)).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("--port");
    expect(h.calls).toHaveLength(1);
  });
});

// ── Prompts ──────────────────────────────────────────────────────────────────

describe("prompts", () => {
  const AT_ANOTHER_COMMIT = probeOut({
    checkout: REMOTE_CHECKOUT,
    commit: "0000000000000000000000000000000000000000",
    dirty: "no",
    version: "1.0.0",
  });

  test("y replaces the checkout", async () => {
    const h = harness({ confirm: true, answers: { probe: { stdout: AT_ANOTHER_COMMIT } } });
    expect(await run(h)).toBe(EXIT.OK);
    expect(h.calls.map((c) => c.leg)).toContain("install");
  });

  test("N stops with STATE and changes nothing", async () => {
    const h = harness({ confirm: false, answers: { probe: { stdout: AT_ANOTHER_COMMIT } } });
    expect(await run(h)).toBe(EXIT.STATE);
    expect(h.calls.map((c) => c.leg)).toEqual(["probe"]);
  });

  test("a non-interactive run aborts legibly, naming the question — never defaulting to yes", async () => {
    const h = harness({ confirm: null, answers: { probe: { stdout: AT_ANOTHER_COMMIT } } });
    expect(await run(h)).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("this run is not interactive, and it would have asked");
    expect(text(h.io)).toContain("replace it with");
    expect(h.calls.map((c) => c.leg)).toEqual(["probe"]);
  });

  test("a dirty remote checkout is REFUSED rather than prompted", async () => {
    const h = harness({
      confirm: true,
      answers: {
        probe: {
          stdout: probeOut({
            checkout: REMOTE_CHECKOUT,
            commit: "0000000000000000000000000000000000000000",
            dirty: "yes",
            dirtyfiles: " M bridge/index.ts",
          }),
        },
      },
    });
    expect(await run(h)).toBe(EXIT.STATE);
    expect(text(h.io)).toContain("git stash");
    expect(text(h.io)).toContain("will not");
    expect(h.calls.map((c) => c.leg)).toEqual(["probe"]);
  });

  // ── F23: what an UNSET bind means, and what it does not ───────────────────
  // `collie leave` removes COLLIE_HOST and keeps COLLIE_PORT, so a machine torn down properly reads
  // back `envhost=""`, `envport="8787"`. That used to prompt `configured to bind (unset):8787` and
  // hard-stop every non-interactive run — `ssh -tt` included, since a piped `y` is not a terminal.
  describe("the bind confirmation guards an operator's value, not the absence of one", () => {
    const probed = (over: Record<string, string>): string =>
      probeOut({ checkout: REMOTE_CHECKOUT, commit: COMMIT, ...over });

    test("re-adding a machine that LEFT needs no terminal at all", async () => {
      // `confirm: null` is exactly a run with nowhere to ask — the shape that hard-stopped.
      const h = harness({ confirm: null, answers: { probe: { stdout: probed({ envport: "8787" }) } } });
      expect(await run(h)).toBe(EXIT.OK);
      expect(h.calls.map((c) => c.leg)).toContain("configure");
      const rendered = text(h.io);
      expect(rendered).toContain("no COLLIE_HOST");
      expect(rendered).not.toContain("(unset)");
    });

    test("an operator's own non-loopback bind is still guarded, port agreeing or not", async () => {
      const h = harness({ confirm: null, answers: { probe: { stdout: probed({ envhost: "10.9.9.9", envport: "8787" }) } } });
      expect(await run(h)).toBe(EXIT.FAIL);
      expect(h.calls.map((c) => c.leg)).not.toContain("configure");
    });

    test("the predicate, case by case", () => {
      const probe = (over: Record<string, string>) => parseProbe(probed(over))!;
      // Nothing there to preserve — the post-leave state, and a fresh machine's.
      expect(bindOverwriteConfirmation(probe({ envport: "8787" }), "100.64.0.9", 8787)).toBeNull();
      expect(bindOverwriteConfirmation(probe({}), "100.64.0.9", 8787)).toBeNull();
      // Already where this run would put it: nothing changes, so nothing is asked.
      expect(bindOverwriteConfirmation(probe({ envhost: "100.64.0.9" }), "100.64.0.9", 8787)).toBeNull();
      // A value somebody chose, about to be replaced by a different one.
      expect(bindOverwriteConfirmation(probe({ envhost: "127.0.0.1", envport: "8787" }), "100.64.0.9", 8787)).toBe(
        "127.0.0.1:8787",
      );
      // The port is a decision too, and it is named without a placeholder for the host.
      expect(bindOverwriteConfirmation(probe({ envport: "9000" }), "100.64.0.9", 8787)).toBe("100.64.0.9:9000");
    });
  });

  test("a disagreeing bind is a prompt; N is STATE", async () => {
    const stdout = probeOut({ checkout: REMOTE_CHECKOUT, commit: COMMIT, envhost: "127.0.0.1", envport: "8787" });
    const yes = harness({ confirm: true, answers: { probe: { stdout } } });
    expect(await run(yes)).toBe(EXIT.OK);
    expect(yes.calls.map((c) => c.leg)).toEqual(["probe", "configure", "membership", "enroll"]);
    const no = harness({ confirm: false, answers: { probe: { stdout } } });
    expect(await run(no)).toBe(EXIT.STATE);
    expect(text(no.io)).toContain("stays provisional forever");
  });

  test("no tailnet address and nobody to ask stops rather than guessing", async () => {
    const h = harness({ prompt: null, answers: { probe: { stdout: probeOut({ address: "" }) } } });
    expect(await run(h)).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("--peer-address");
  });

  test("no tailnet address, but the operator supplies one", async () => {
    const h = harness({ prompt: "10.0.0.4", answers: { probe: { stdout: probeOut({ address: "" }) } } });
    expect(await run(h)).toBe(EXIT.OK);
    expect(h.calls[2]!.script).toContain("'10.0.0.4'");
  });
});

// ── Idempotency ──────────────────────────────────────────────────────────────

describe("re-running against the same host", () => {
  test("already at the lead's commit skips the install entirely", async () => {
    const h = harness({
      answers: { probe: { stdout: probeOut({ checkout: REMOTE_CHECKOUT, commit: COMMIT, version: VERSION }) } },
    });
    expect(await run(h)).toBe(EXIT.OK);
    expect(h.calls.map((c) => c.leg)).not.toContain("install");
    expect(text(h.io)).toContain(`already at ${VERSION}`);
  });

  test("an already-correct bind is not rewritten", async () => {
    const h = harness({
      answers: {
        probe: {
          stdout: probeOut({
            checkout: REMOTE_CHECKOUT,
            commit: COMMIT,
            envhost: "100.64.0.9",
            envport: "8787",
          }),
        },
      },
    });
    expect(await run(h)).toBe(EXIT.OK);
    expect(h.calls.map((c) => c.leg)).toEqual(["probe", "membership", "enroll"]);
    expect(text(h.io)).toContain("✓ bind       already 100.64.0.9:8787");
  });

  test("a busy port is this collie's OWN listener when a checkout is already configured for it", async () => {
    const h = harness({
      answers: {
        probe: {
          stdout: probeOut({ checkout: REMOTE_CHECKOUT, commit: COMMIT, envhost: "100.64.0.9", port: "busy" }),
        },
      },
    });
    expect(await run(h)).toBe(EXIT.OK);
    expect(text(h.io)).toContain("already carries this collie");
    // An absent COLLIE_PORT is the default, not "unset" — so the bind is not rewritten either.
    expect(h.calls.map((c) => c.leg)).not.toContain("configure");
  });

  test("already a member of THIS pack is a ✓ and exit OK — nothing is minted", async () => {
    const h = harness({
      answers: {
        probe: { stdout: probeOut({ checkout: REMOTE_CHECKOUT, commit: COMMIT }) },
        membership: { stdout: ["pack   the herd  (pack-1)", "mode   peer", "self   nas  abcd…"].join("\n") },
      },
    });
    expect(await run(h)).toBe(EXIT.OK);
    expect(text(h.io)).toContain('✓ already a member of "the herd" as "nas"');
    expect(h.calls.map((c) => c.leg)).not.toContain("enroll");
    expect(h.restarts).toBe(0);
  });

  // ── THE FIELD BUG (2026-08-15) ────────────────────────────────────────────
  // A re-run against an ENROLLED peer whose checkout is behind: the push and the build landed, and
  // the machine kept answering with the old build because nothing restarted it — no `collie join`
  // runs on this path, and a join is the only thing that ever restarted a peer from `pack add`. The
  // operator had just consented to "replace it with 1.2.3"; `pack status` then still said 1.2.2.
  test("re-adding an enrolled peer whose build was replaced RESTARTS it there", async () => {
    const h = harness({
      // The peer is in this lead's roster already — which is what makes the `hello` below the lead's
      // own view of the machine it just rebuilt.
      store: leadStore({ peers: [member({ memberId: "nas", address: "100.64.0.9:8787" })] }),
      answers: {
        probe: {
          stdout: probeOut({
            checkout: REMOTE_CHECKOUT,
            commit: "0000feed0000feed0000feed0000feed0000feed",
            version: "1.2.2",
            envhost: "100.64.0.9",
            dirty: "no",
          }),
        },
        membership: { stdout: ["pack   the herd  (pack-1)", "mode   peer", "self   nas  abcd…"].join("\n") },
      },
    });
    expect(await run(h)).toBe(EXIT.OK);
    expect(h.calls.map((c) => c.leg)).toEqual(["probe", "install", "membership", "restart"]);
    const rendered = text(h.io);
    expect(rendered).toContain("restarting Collie on nas.example");
    // And the verdict states what it is running NOW, from the lead's own `hello` — never from the
    // probe it read before the push.
    expect(rendered).toContain(`now running ${VERSION}`);
    // The LEAD is not restarted: nothing in its own roster changed.
    expect(h.restarts).toBe(0);
  });

  test("a restart that fails there is a FAILURE, and says which machine still runs the old build", async () => {
    const h = harness({
      answers: {
        probe: {
          stdout: probeOut({
            checkout: REMOTE_CHECKOUT,
            commit: "0000feed0000feed0000feed0000feed0000feed",
            envhost: "100.64.0.9",
            dirty: "no",
          }),
        },
        membership: { stdout: ["pack   the herd  (pack-1)", "mode   peer", "self   nas  abcd…"].join("\n") },
        restart: { code: 1, stderr: "error: the unit did not come back" },
      },
    });
    expect(await run(h)).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("The new build is on disk there and the old one is still running");
  });

  test("an unchanged re-run restarts nothing — a no-op stays a no-op", async () => {
    const h = harness({
      answers: {
        probe: { stdout: probeOut({ checkout: REMOTE_CHECKOUT, commit: COMMIT, envhost: "100.64.0.9" }) },
        membership: { stdout: ["pack   the herd  (pack-1)", "mode   peer", "self   nas  abcd…"].join("\n") },
      },
    });
    expect(await run(h)).toBe(EXIT.OK);
    expect(h.calls.map((c) => c.leg)).not.toContain("restart");
    expect(text(h.io)).toContain('✓ already a member of "the herd" as "nas"');
  });

  test("a member of ANOTHER pack is STATE, naming `collie leave` there — never run for you", async () => {
    const h = harness({
      answers: {
        probe: { stdout: probeOut({ checkout: REMOTE_CHECKOUT, commit: COMMIT }) },
        membership: { stdout: ["pack   someone else  (pack-99)", "mode   peer", "self   nas  abcd…"].join("\n") },
      },
    });
    expect(await run(h)).toBe(EXIT.STATE);
    expect(text(h.io)).toContain("`collie leave` THERE first");
    expect(h.calls.map((c) => c.leg)).not.toContain("enroll");
  });
});

// ── The last line ────────────────────────────────────────────────────────────

describe("the join's outcome", () => {
  test("a refused token is REFUSED — `collie join`'s own code, passed through", async () => {
    const h = harness({ answers: { enroll: { code: EXIT.REFUSED, stderr: "error: the lead refused the token" } } });
    expect(await run(h)).toBe(EXIT.REFUSED);
    expect(text(h.io)).toContain("the lead refused the token");
  });

  test("a remote that cannot reach the lead is UNREACHABLE, and says whose ingress that is", async () => {
    const h = harness({ answers: { enroll: { code: EXIT.UNREACHABLE, stderr: "error: could not reach desk" } } });
    expect(await run(h)).toBe(EXIT.UNREACHABLE);
    expect(text(h.io)).toContain("That is the lead's ingress, not the peer's");
    // The escape hatch: an address the peer itself cannot dial (reverse proxy, one-way tailnet ACL)
    // is recoverable by re-running with an address the PEER can reach, not the lead's own view of itself.
    expect(text(h.io)).toContain("--address <an-address-the-peer-CAN-dial>");
  });

  test("joined but still provisional is FAIL, and names `collie doctor` on the remote", async () => {
    const h = harness({ reachable: false });
    expect(await run(h)).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("still PROVISIONAL");
    expect(text(h.io)).toContain("collie doctor");
  });

  test("a join that reported success but left no member in the roster is FAIL", async () => {
    const h = harness({ after: leadStore() });
    expect(await run(h)).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("does not name a new member");
  });
});

// ── Dispatch ─────────────────────────────────────────────────────────────────

describe("dispatch", () => {
  test("`collie pack add` routes here, and the help lists it", async () => {
    const h = harness();
    expect(await cmdPack(h.deps, ["add", "nas.example"])).toBe(EXIT.OK);
    expect(h.calls.map((c) => c.leg)).toContain("enroll");
    const usage = harness();
    await cmdPack(usage.deps, ["nonsense"]);
    expect(text(usage.io)).toContain("add      install and enroll a peer over SSH");
  });

  test("the pack it joins is the one this lead already leads", () => {
    expect(PACK.packId).toBe("pack-1");
  });
});

// ── `packAddDeps().gitBundle` against a REAL git ─────────────────────────────
// The fakes above stub `gitBundle` entirely, which is exactly how the field bug (a bare commit sha
// is not a REF, so `git bundle create - <sha>` refuses with "Refusing to create empty bundle")
// survived. This suite spawns a real `git` against a throwaway repo instead.

/** {@link PackDeps} whose `io` is the recording one, so a failure can print what the verb said. */
interface RepoPackDeps extends PackDeps {
  io: ReturnType<typeof capture>;
}

/** A repo-scoped env with no `PATH` surprises and no inherited `GIT_*` — see collie-cli.test.sh. */
function gitEnv(): Environment {
  return { PATH: process.env.PATH };
}

function minimalPackDeps(root: string): RepoPackDeps {
  const storeIo: TrustStoreIo = { read: async () => null, write: async () => {} };
  return {
    ctx: context(gitEnv(), { root }),
    io: capture(),
    exec: realExec(gitEnv(), root),
    files: fakeFiles(),
    store: new TrustStore("/state", storeIo),
    ops: fakeOps(),
    audit: null,
    fetch: () => Promise.reject(new Error("not used by gitBundle")),
    now: () => T0,
    random: () => "r",
    mintIdentity: () => Promise.reject(new Error("not used by gitBundle")),
    readStdin: () => Promise.resolve(""),
    restart: () => Promise.resolve(EXIT.OK),
    serve: () => Promise.resolve(EXIT.OK),
    unserve: () => EXIT.OK,
    clearNotifications: () => Promise.resolve(),
  };
}

describe("packAddDeps().gitBundle, against a real repo", () => {
  test("bundles HEAD when the commit given is still HEAD, and refuses when it has moved", async () => {
    const root = mkdtempSync(join(tmpdir(), "collie-gitbundle-"));
    try {
      const env = gitEnv();
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8" });
      git("init", "-q");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      writeFileSync(join(root, "file.txt"), "one\n");
      git("add", "file.txt");
      git("commit", "-q", "-m", "first");
      const first = git("rev-parse", "HEAD").trim();

      writeFileSync(join(root, "file.txt"), "two\n");
      git("add", "file.txt");
      git("commit", "-q", "-m", "second");
      const second = git("rev-parse", "HEAD").trim();

      const staleDeps = minimalPackDeps(root);
      const staleBundle = await packAddDeps(staleDeps).gitBundle(first, staleDeps.io);
      expect(staleBundle).toBeNull();

      const freshDeps = minimalPackDeps(root);
      const encoded = await packAddDeps(freshDeps).gitBundle(second, freshDeps.io);
      if (encoded === null) {
        throw new Error(`gitBundle returned null; stderr: ${freshDeps.io.stderr.join("\n")}`);
      }
      const bundlePath = join(root, "bundle.out");
      writeFileSync(bundlePath, Buffer.from(encoded, "base64"));
      // `bundle verify` exits 0 (throws on non-zero) — the bundle is well-formed and self-contained.
      expect(() => execFileSync("git", ["-C", root, "bundle", "verify", bundlePath], { env })).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Field bug: `git bundle verify` refuses outside a repository ("need a repository to verify a
  // bundle"), and `installScript`'s leg runs over `ssh host /bin/sh -s`, whose cwd is the remote
  // user's $HOME — not generally a repo. This pins that a bare `-C`-less verify from a non-repo cwd
  // fails, and that `installScript`'s actual remedy — `git init -q` a scratch repo, then verify with
  // `-C` into it — succeeds against the very same complete bundle.
  test("bundle verify needs a repository; a scratch `git init` under $WORK supplies one", async () => {
    const root = mkdtempSync(join(tmpdir(), "collie-gitbundle-src-"));
    const nonRepoCwd = mkdtempSync(join(tmpdir(), "collie-gitbundle-nonrepo-"));
    try {
      const env = gitEnv();
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8" });
      git("init", "-q");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      writeFileSync(join(root, "file.txt"), "one\n");
      git("add", "file.txt");
      git("commit", "-q", "-m", "first");
      const head = git("rev-parse", "HEAD").trim();

      const deps = minimalPackDeps(root);
      const encoded = await packAddDeps(deps).gitBundle(head, deps.io);
      if (encoded === null) {
        throw new Error(`gitBundle returned null; stderr: ${deps.io.stderr.join("\n")}`);
      }
      const bundlePath = join(nonRepoCwd, "bundle.part");
      writeFileSync(bundlePath, Buffer.from(encoded, "base64"));

      // Bare verify, run with cwd = a non-repo directory (as the field bug had it): refuses.
      expect(() =>
        execFileSync("git", ["bundle", "verify", bundlePath], { env, cwd: nonRepoCwd }),
      ).toThrow(/need a repository/);

      // installScript's remedy: init an empty scratch repo, verify `-C` into it. Succeeds, because
      // the bundle pushed by `pack add` is complete (bundle of HEAD, no prerequisites).
      const scratch = join(nonRepoCwd, "verify");
      execFileSync("git", ["init", "-q", scratch], { env });
      expect(() =>
        execFileSync("git", ["-C", scratch, "bundle", "verify", bundlePath], { env }),
      ).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(nonRepoCwd, { recursive: true, force: true });
    }
  });
});
