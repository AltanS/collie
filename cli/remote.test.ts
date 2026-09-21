import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { AuditLog, type AuditEntry } from "../bridge/audit.ts";
import { CREW_PROTOCOL_VERSION } from "../bridge/crew/enrollment.ts";
import { fp, leadStore, material, member, CREW, T0 } from "../bridge/crew/fixtures.ts";
import { serializeTrustStore, TrustStore, type TrustStoreData, type TrustStoreIo } from "../bridge/crew/trust-store.ts";
import {
  capture,
  context,
  fakeExec,
  fakeFiles,
  fakeOps,
  HOME,
  ROOT,
  type SeededFiles,
  type SeededOps,
} from "./fakes.ts";
import { sshResolveArgs } from "./candidates.ts";
import type { Environment } from "./context.ts";
import type { InstallKind } from "./install-kind.ts";
import { EXIT } from "./io.ts";
import { cmdCrew, type CrewDeps } from "./crew.ts";
import {
  bindOverwriteConfirmation,
  cmdCrewAdd,
  composeStdin,
  configureScript,
  enrollScript,
  installReleaseScript,
  memberInstallKind,
  routeOf,
  installScript,
  membershipScript,
  muxChoice,
  muxProbeScript,
  crewAddDeps,
  parseMembership,
  parseProbe,
  probeScript,
  restartScript,
  shq,
  shqPath,
  sshOptions,
  STDIN_MARKER,
  type CrewAddDeps,
  type RemoteResult,
} from "./remote.ts";
import { INSTALLER_SH } from "./installer-embed.ts";
import type { MuxProbeReport } from "./mux-probe.ts";
import { realExec } from "./sys.ts";

// `collie crew add` against fakes for every seam. **NOTHING here spawns `ssh` or reaches a network**:
// the transport is a function that records `(script, stdin)` pairs and answers from a table, the
// prompts are values, and the trust store is in memory. That is the same safety boundary
// `cli/fakes.ts` draws for the lifecycle verbs and `cli/crew.test.ts` draws for the crew verbs — a
// verb that installs software on another machine is exactly the one that must never be run for real
// by a test suite.

// ── The fake transport ───────────────────────────────────────────────────────

type Leg = "probe" | "install" | "configure" | "membership" | "enroll" | "restart" | "mux-probe";

/** Which leg a script is, read off the script itself — so a test never depends on call ordering. */
function legOf(script: string): Leg {
  if (script.includes("collie-probe:")) return "probe";
  if (script.includes("collie-install:")) return "install";
  if (script.includes("collie-configure:")) return "configure";
  if (script.includes("crew status --no-probe")) return "membership";
  if (script.includes("_mux-probe")) return "mux-probe";
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
  // A machine whose Collie has been started once: `collie start` writes `COLLIE_MUX` into the
  // config-dir `.env` and a solo collie leaves `COLLIE_HOST` unset (`cli/mux.ts`, F23). So the
  // default member has already chosen, and leg 3 asks its machine nothing — the cases that DO ask
  // seed `envmux: ""` themselves.
  envmux: "herdr",
  checkout: "",
  checkoutgit: "",
  installroot: "",
  commit: "",
  branch: "",
  dirty: "",
  dirtyfiles: "",
  version: "",
  address: "100.64.0.9",
  port: "free",
  curl: "/usr/bin/curl",
  tar: "/usr/bin/tar",
  sha256: "/usr/bin/sha256sum",
} satisfies Record<string, string>;

/** Leg 1's stdout, as the remote would print it. */
function probeOut(over: Record<string, string> = {}): string {
  const all = { ...PROBE_DEFAULTS, ...over };
  const lines = Object.entries(all).map(([k, v]) => `collie-probe:${k}=${v}`);
  return [...lines, "collie-probe:probe=ok", ""].join("\n");
}

/**
 * What the member's own `collie _mux-probe` prints — the same JSON `cli/mux-probe.ts` writes.
 *
 * Built from the names rather than hand-typed, so a case says "two multiplexers run there" and
 * nothing else about the format.
 */
function muxProbeOut(names: readonly string[], explicit: string | null = null): string {
  const found = names.map((mux) => ({ mux, evidence: `a ${mux} thing` }));
  return `${JSON.stringify({ explicit, found })}\n`;
}

const SOLO_STATUS = [
  "mode: solo — this collie is not in a crew (no trust store, or an empty one).",
  "  `collie crew invite` here makes it a lead; `collie join …` makes it a peer.",
].join("\n");

type LegAnswers = Partial<Record<Leg, Partial<RemoteResult>>>;

interface Harness {
  deps: CrewAddDeps;
  io: ReturnType<typeof capture>;
  calls: Recorded[];
  closed: number;
  data(): TrustStoreData | null;
  restarts: number;
  /** How many times the lead was asked for a `git bundle` — zero on the release route. */
  bundles: number;
  /** Every LOCAL spawn, in order — what the candidate picker asked this machine. */
  exec: { calls: string[] };
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
  /** Seed for the ops store — how `crew add` remembers a host it already reached. */
  ops?: SeededOps;
  /** `~/.ssh/config`'s contents, for the candidate picker. Absent ⇒ there is no such file. */
  sshConfig?: string;
  /** Any other file the picker may read — an ssh `Include` target, say. */
  extraFiles?: Readonly<Record<string, string>>;
  /** `herdr machine list --json`'s stdout. Absent ⇒ there is no `herdr` binary to ask. */
  machines?: string;
  /** `ssh -G <target>` output per target. Absent ⇒ there is no `ssh` to resolve with. */
  resolve?: Readonly<Record<string, string>>;
  /** This lead's install kind. Absent ⇒ a linked clone, the kind every earlier test assumed. */
  installKind?: InstallKind;
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
  let bundles = 0;

  // The candidate picker's two sources, and the resolver. All three are ABSENT by default, so every
  // test written before the picker existed sees the machine it always saw: no ssh config, no `herdr`
  // to ask for a machine list, and no `ssh` to resolve an alias with.
  const seeded: SeededFiles = { ...opts.extraFiles };
  if (opts.sshConfig !== undefined) seeded[`${HOME}/.ssh/config`] = opts.sshConfig;
  const answers: [string, Partial<ReturnType<typeof realExec>["capture"]> | { stdout: string }][] = [
    [`git -C ${ROOT} rev-parse HEAD`, { stdout: `${COMMIT}\n` }],
    [`git -C ${ROOT} status --porcelain`, { stdout: "" }],
    [`git -C ${ROOT} show ${COMMIT}:herdr-plugin.toml`, { stdout: `version = "${VERSION}"\n` }],
    ["tailscale status --json", { stdout: TAILSCALE_JSON }],
  ];
  if (opts.machines !== undefined) answers.push(["herdr machine list --json", { stdout: opts.machines }]);
  for (const [target, stdout] of Object.entries(opts.resolve ?? {})) {
    answers.push([`ssh ${sshResolveArgs(target).join(" ")}`, { stdout }]);
  }
  const exec = fakeExec({
    absent: [...(opts.machines === undefined ? ["herdr"] : []), ...(opts.resolve === undefined ? ["ssh"] : [])],
    answers,
  });

  const deps: CrewAddDeps = {
    // The same reason `cli/crew.test.ts` sets this: the real `setTimeout` in `PeerClient` must never
    // fire and report a fake peer as unreachable.
    ctx: context({ COLLIE_CREW_TIMEOUT_MS: "60000", ...opts.env }),
    io: out,
    exec,
    files: fakeFiles(seeded),
    store,
    ops,
    // SAFETY: `AuditLog` hands its sink the line it just serialised from an `AuditEntry` — the
    // log's own round trip, not foreign input.
    audit: new AuditLog((l: string) => void audit.push(JSON.parse(l) as AuditEntry), { now: () => T0 }),
    fetch: async () =>
      opts.reachable === false
        ? Promise.reject(new Error("connection refused"))
        : new Response(JSON.stringify({ protocol: CREW_PROTOCOL_VERSION, member: "nas", version: VERSION }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-crew-protocol": String(CREW_PROTOCOL_VERSION),
              "x-crew-member": "nas",
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
            : leg === "mux-probe"
              ? muxProbeOut(["herdr"])
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
    gitBundle: () => {
      bundles += 1;
      return Promise.resolve("QkFTRTY0LWJ1bmRsZQ==");
    },
    installKind: () => opts.installKind ?? { kind: "linked-clone", alsoLayout: false },
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
    get bundles() {
      return bundles;
    },
    exec,
  };
}

const text = (io: ReturnType<typeof capture>): string => [...io.stdout, ...io.stderr].join("\n");
const run = (h: Harness, args: string[] = ["nas.example"]): Promise<number> => cmdCrewAdd(h.deps, args);

/** The install.sh layout a release member carries: `<root>/versions/<x.y.z>` behind `<root>/current`. */
const MEMBER_INSTALL_ROOT = `${REMOTE_HOME}/.local/share/collie`;
const MEMBER_CURRENT = `${MEMBER_INSTALL_ROOT}/current`;

/**
 * A lead with NO COMMIT — the shape #248 is about.
 *
 * Its manifest is seeded because the release route pins the member to the version this lead reports
 * (`collieVersionBare`), and that is read through `deps.files` exactly as the verb reads it.
 */
function releaseHarness(opts: HarnessOptions = {}): Harness {
  return harness({
    installKind: { kind: "binary" },
    ...opts,
    extraFiles: {
      [`${ROOT}/herdr-plugin.toml`]: `id = "herdr.collie"\nversion = "${VERSION}"\n`,
      ...opts.extraFiles,
    },
  });
}

// ── The generated scripts, pinned ────────────────────────────────────────────
// A leg script is a program that runs on someone ELSE's machine. Pinning the text is what stops a
// change to it landing invisibly; the rule tests below make "no `curl | sh`, no `PATH` assumption"
// mechanically checkable rather than a promise in a comment.

const GOLDEN: [file: string, script: string][] = [
  ["leg1-probe.sh", probeScript({ path: null, port: 8787 })],
  ["leg1-probe-path.sh", probeScript({ path: "/srv/collie", port: 9000 })],
  ["leg2-install.sh", installScript({ root: "/home/pat/.collie", commit: "abc123", version: "1.2.3" })],
  [
    "leg2-install-release.sh",
    installReleaseScript({
      installRoot: "/home/pat/.local/share/collie",
      tag: "v1.2.3",
      repo: "AltanS/collie",
      version: "1.2.3",
    }),
  ],
  [
    "leg3-configure.sh",
    configureScript({ configDir: "/cfg", host: "100.1.2.3", port: 8787, mux: null, instance: null }),
  ],
  [
    "leg3-configure-instance.sh",
    configureScript({ configDir: "/cfg", host: "100.1.2.3", port: 9000, mux: null, instance: "v1" }),
  ],
  [
    "leg3-configure-mux.sh",
    configureScript({ configDir: "/cfg", host: "100.1.2.3", port: 8787, mux: "tmux", instance: null }),
  ],
  ["leg3-mux-probe.sh", muxProbeScript("/home/pat/.collie")],
  ["leg4-membership.sh", membershipScript("/home/pat/.collie")],
  // Not one of `crew add`'s legs — `crew update` drives it, and it is pinned here with the rest
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

  test("nothing is piped into a shell, and no leg dials a URL of its own", () => {
    for (const [file, script] of GOLDEN) {
      expect(`${file}: ${script}`).not.toContain("wget");
      expect(`${file}: ${script}`).not.toMatch(/https?:\/\//);
      expect(script).not.toMatch(/\|\s*(ba)?sh\b/);
      // Two legs NAME `curl`, and both only resolve it: the probe reports where it is, and the
      // release leg puts that directory on PATH for the installer it hands to `/bin/sh`. The fetch
      // is the installer's own, pinned to a tag and verified against the release's manifest — and
      // it is still not `curl … | sh`, which is the line this test is really drawing.
      for (const line of script.split("\n")) {
        if (!line.includes("curl")) continue;
        expect(`${file}: ${line}`).toMatch(/collie_tool curl|^\S+: say curl /);
      }
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
    const configure = configureScript({ configDir: "/cfg", host: "h", port: 1, mux: null, instance: null });
    expect(configure).toContain('[ -s "$TMP" ]');
    expect(configure).toContain('mv "$TMP" "$ENVFILE"');
  });

  // The release leg's contract, in one place: the three variables that steer install.sh, the tag it
  // is pinned to, the version it must come back with, and the markers the caller reads.
  test("the release leg pins the tag, names the repo, and re-reads the version it laid down", () => {
    const script = installReleaseScript({
      installRoot: "/srv/collie",
      tag: "v1.2.3",
      repo: "me/collie",
      version: "1.2.3",
    });
    expect(script).toContain('DIR=\'/srv/collie\'');
    expect(script).toContain(
      'COLLIE_DIR="$DIR" COLLIE_UPDATE_REPO=\'me/collie\' COLLIE_TAG=\'v1.2.3\' /bin/sh "$WORK/install.sh" 1>&2',
    );
    // A pinned tag is the one path through install.sh that asks api.github.com nothing, so no
    // GitHub token matters on the far machine.
    expect(script).not.toContain("api.github.com");
    expect(script).toContain('VERSION=$("$ROOT/bin/collie" version | head -n 1)');
    expect(script).toContain('  "$EXPECT"*) ;;');
    expect(script).toContain("exit 26");
    expect(script).toContain("collie-install:root=%s");
    expect(script).toContain('"$ROOT" "$VERSION"');
    expect(script).toContain('ROOT="$DIR/current"');
    // The installer's own output goes to stderr, so this leg's stdout carries the markers alone.
    expect(script).toContain("1>&2");
  });

  test("the build is the shim's own bootstrap, not a second build path", () => {
    expect(installScript({ root: "/r", commit: "c", version: "v" })).toContain(
      '"$BUN" run cli/main.ts build',
    );
  });

  test("configure preserves values Collie did not set, and publishes no front door", () => {
    const script = configureScript({ configDir: "/cfg", host: "h", port: 1, mux: null, instance: null });
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

  test("shqPath expands a leading `~` against the REMOTE $HOME, never this machine's", () => {
    expect(shqPath("~/apps/collie-stable")).toBe(`"$HOME"/'apps/collie-stable'`);
    expect(shqPath("~")).toBe(`"$HOME"`);
  });

  test("shqPath leaves an ordinary path exactly as `shq` would", () => {
    expect(shqPath("/opt/collie")).toBe(shq("/opt/collie"));
    expect(shqPath("~notauser/x")).toBe(shq("~notauser/x"));
  });

  test("the probe script never carries a literal tilde for a `~`-rooted --path", () => {
    const script = probeScript({ path: "~/apps/collie-stable", port: 8787 });
    expect(script).toContain(`for _d in "$HOME"/'apps/collie-stable' "$HOME"/'apps/collie-stable/current'; do`);
    expect(script).not.toContain("~");
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

  test("a payload holding every JS string-replacement pattern composes byte for byte", () => {
    const before = "a\n";
    const after = "\nb\n";
    const payload = "x$' y$` z$& w$$ v$1 u$<name>\nmore text";
    expect(composeStdin(`${before}${STDIN_MARKER}${after}`, payload)).toBe(`${before}${payload}${after}`);
  });

  test("the installer's own regex ends in $', which a string replacement would misread", () => {
    expect(composeStdin(`a\n${STDIN_MARKER}\nb\n`, INSTALLER_SH)).toBe(`a\n${INSTALLER_SH}\nb\n`);
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

  // The fields the release route decides from. A probe and its parser ship together, so an older
  // probe never reaches this code — but an absent key still reads as empty, like every other one.
  test("reads what kind of install the member carries, and the installer's three tools", () => {
    const probe = parseProbe(
      probeOut({
        checkout: MEMBER_CURRENT,
        checkoutgit: "no",
        installroot: MEMBER_INSTALL_ROOT,
        curl: "/usr/bin/curl",
        tar: "/bin/tar",
        sha256: "/usr/bin/shasum",
      }),
    );
    expect(probe?.checkoutgit).toBe("no");
    expect(probe?.installroot).toBe(MEMBER_INSTALL_ROOT);
    expect(probe?.curl).toBe("/usr/bin/curl");
    expect(probe?.tar).toBe("/bin/tar");
    expect(probe?.sha256).toBe("/usr/bin/shasum");
    const bare = parseProbe("collie-probe:probe=ok")!;
    expect([bare.checkoutgit, bare.installroot, bare.curl, bare.tar, bare.sha256]).toEqual(["", "", "", "", ""]);
  });
});

describe("parseMembership", () => {
  test("solo", () => {
    expect(parseMembership(SOLO_STATUS)).toEqual({ packId: null, crewName: null, memberId: null });
  });

  test("a member of a crew", () => {
    const status = ["crew   the herd  (crew-1)", "mode   peer", "self   nas  abcd…"].join("\n");
    expect(parseMembership(status)).toEqual({ packId: "crew-1", crewName: "the herd", memberId: "nas" });
  });

  test("a 1.6.0 machine still says `crew`, and that reads the same", () => {
    const status = ["crew   the herd  (crew-1)", "mode   peer", "self   nas  abcd…"].join("\n");
    expect(parseMembership(status)).toEqual({ packId: "crew-1", crewName: "the herd", memberId: "nas" });
  });

  test("a shape this build cannot read fails rather than assuming solo", () => {
    expect(parseMembership("who knows")).toBeNull();
  });
});

// ── The verb ─────────────────────────────────────────────────────────────────

describe("routeOf (#248)", () => {
  // The one decision both verbs read. `crew add` and `crew update` must never disagree about it: a
  // member added by release and then levelled by bundle would take a commit into a layout with no
  // git checkout to receive it.
  test("a lead with no commit hands out a release; every other kind pushes its commit", () => {
    for (const kind of [{ kind: "binary" }, { kind: "packaged" }] as const) {
      expect(routeOf(kind)).toBe("release");
    }
    for (const kind of [
      { kind: "linked-clone", alsoLayout: false },
      { kind: "detached-checkout", alsoLayout: true },
      { kind: "unknown", why: "broken-checkout" },
      { kind: "unknown", why: "orphan-layout" },
      { kind: "unknown", why: "no-marker" },
      { kind: "unknown", why: "loose-binary" },
    ] as const) {
      // `unknown` too: its own git error is the right one for a broken or missing checkout.
      expect(routeOf(kind)).toBe("bundle");
    }
  });
});

describe("memberInstallKind (#248)", () => {
  const at = (over: Record<string, string>) => memberInstallKind(parseProbe(probeOut(over))!);

  test("the member's kind is read off the two shapes leg 1 reports, never guessed", () => {
    expect(at({ checkout: "", checkoutgit: "", installroot: "" })).toBe("none");
    expect(at({ checkout: REMOTE_CHECKOUT, checkoutgit: "yes" })).toBe("git");
    expect(at({ checkout: MEMBER_CURRENT, checkoutgit: "no", installroot: MEMBER_INSTALL_ROOT })).toBe("binary");
    // A Collie that is neither: `other` is a real answer, not a fallback.
    expect(at({ checkout: "/opt/collie", checkoutgit: "no", installroot: "" })).toBe("other");
  });
});

describe("collie crew add", () => {
  test("no host is a usage error", async () => {
    const h = harness();
    expect(await run(h, [])).toBe(EXIT.USAGE);
    expect(h.calls).toHaveLength(0);
  });

  // ── The candidate picker (M22/07) ───────────────────────────────────────────
  // With a target NOTHING below runs and every golden above still matches. With none, `crew add`
  // offers the machines this box already knows about and the operator picks one.

  test("an absent herdr and an absent ssh config both yield no candidates and no error", async () => {
    const h = harness();
    expect(await run(h, [])).toBe(EXIT.USAGE);
    expect(h.io.stdout).toEqual([]);
    expect(text(h.io)).toContain("usage: collie crew add <ssh-host>");
    expect(text(h.io)).not.toContain("warn:");
    expect(text(h.io)).not.toContain("Candidate hosts");
  });

  test("a target skips the picker entirely — nothing local is asked", async () => {
    const h = harness({ sshConfig: "Host attic", machines: '[{"target":"nas"}]', resolve: {} });
    expect(await run(h)).toBe(EXIT.OK);
    expect(h.exec.calls.filter((c) => c.startsWith("ssh ") || c.startsWith("herdr "))).toEqual([]);
  });

  test("no host lists the ssh config candidates and adds the one the operator picks", async () => {
    const h = harness({ sshConfig: "Host attic\nHost build-box", prompt: "2" });
    expect(await run(h, [])).toBe(EXIT.OK);
    expect(h.io.stdout).toContain("Candidate hosts on this machine:");
    // Each row states its source, so a name's origin is never a guess.
    expect(h.io.stdout.some((l) => l.includes("1  attic      ssh config"))).toBe(true);
    expect(h.io.stdout.some((l) => l.includes("2  build-box  ssh config"))).toBe(true);
    expect(text(h.io)).toContain("probing build-box…");
    expect(h.calls.map((c) => c.leg)).toEqual(["probe", "install", "configure", "membership", "enroll"]);
  });

  test("a name may be typed instead of a number, and the existing confirm still runs", async () => {
    const h = harness({ sshConfig: "Host attic", prompt: "attic" });
    expect(await run(h, [])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("probing attic…");
    expect(h.calls.map((c) => c.leg)).toEqual(["probe", "install", "configure", "membership", "enroll"]);
  });

  test("two aliases for one machine are ONE row, showing both names and both sources", async () => {
    const h = harness({
      sshConfig: "Host attic",
      machines: '[{"target":"op@attic.lan:22","label":"attic"}]',
      resolve: {
        attic: "user op\nhostname attic.lan\nport 22",
        "op@attic.lan:22": "user op\nhostname attic.lan\nport 22",
      },
      prompt: "",
    });
    expect(await run(h, [])).toBe(EXIT.STATE);
    const rows = h.io.stdout.filter((l) => l.includes("ssh config") || l.includes("herdr"));
    expect(rows).toEqual(["   1  attic  ssh config, herdr  also op@attic.lan:22"]);
    expect(h.io.stdout).toContain("Nothing was added.");
  });

  test("a candidate already in the crew is marked with its member id rather than dropped", async () => {
    const h = harness({
      store: leadStore({ peers: [member({ memberId: "nas", address: "100.64.0.9:8787" })] }),
      ops: { nas: { sshHost: "nas-box", path: REMOTE_CHECKOUT, port: 8787, recordedAt: T0 } },
      sshConfig: "Host nas-box\nHost attic",
      prompt: "1",
      after: leadStore({
        peers: [
          member({ memberId: "nas", address: "100.64.0.9:8787" }),
          member({ memberId: "attic", address: "100.64.0.9:8787" }),
        ],
      }),
    });
    expect(await run(h, [])).toBe(EXIT.OK);
    // The source tag and the mark are SEPARATE columns: "where the name came from" and "this lead
    // already has it" are different facts, and a merged column would read as one.
    expect(h.io.stdout.some((l) => l.includes('nas-box  ssh config  already enrolled as "nas"'))).toBe(true);
    // Marked, not offered: number 1 is the OTHER row.
    expect(text(h.io)).toContain("probing attic…");
  });

  test("every candidate already enrolled is a refusal, and it says which", async () => {
    const h = harness({
      store: leadStore({ peers: [member({ memberId: "nas", address: "100.64.0.9:8787" })] }),
      ops: { nas: { sshHost: "nas-box", path: REMOTE_CHECKOUT, port: 8787, recordedAt: T0 } },
      sshConfig: "Host nas-box",
    });
    expect(await run(h, [])).toBe(EXIT.USAGE);
    expect(text(h.io)).toContain("every candidate above is already a member of this crew");
    expect(h.calls).toHaveLength(0);
  });

  test("the resolver spawns nothing but `ssh -G`, over a config with ProxyCommand and Include", async () => {
    const h = harness({
      sshConfig: [
        "Host bastion",
        "  HostName bastion.example",
        "Host attic",
        "  ProxyCommand corkscrew proxy 8080 %h %p",
        "Match host attic exec \"corkscrew --probe\"",
        "  ForwardAgent yes",
        "Include work/hosts",
      ].join("\n"),
      extraFiles: { [`${HOME}/.ssh/work/hosts`]: "Host office\n  ProxyJump bastion" },
      machines: "[]",
      resolve: {},
      prompt: "",
    });
    expect(await run(h, [])).toBe(EXIT.STATE);
    // The recorded spawns, in full: the machine list, then one `ssh -G` per alias. No ProxyCommand
    // ran, no connection was made, and no leg script reached the transport.
    expect(h.exec.calls).toEqual([
      "herdr machine list --json",
      "ssh -G bastion",
      "ssh -G attic",
      "ssh -G office",
    ]);
    expect(h.exec.calls.every((c) => !c.startsWith("ssh") || c.startsWith("ssh -G "))).toBe(true);
    expect(h.exec.calls.some((c) => c.includes("corkscrew"))).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  test("a broken herdr is one warn line and no candidates, never a failure", async () => {
    const h = harness({ sshConfig: "Host attic", machines: "{ not a list }", prompt: "1" });
    expect(await run(h, [])).toBe(EXIT.OK);
    expect(h.io.stderr.filter((l) => l.startsWith("warn: `herdr machine list --json`"))).toHaveLength(1);
    expect(text(h.io)).toContain("probing attic…");
  });

  test("a non-interactive run with candidates refuses rather than picking one", async () => {
    const h = harness({ sshConfig: "Host attic", prompt: null });
    expect(await run(h, [])).toBe(EXIT.USAGE);
    expect(text(h.io)).toContain("it would have asked which host to add");
    expect(h.calls).toHaveLength(0);
  });

  test("an answer that names nothing on the list is refused, never guessed at", async () => {
    const h = harness({ sshConfig: "Host attic", prompt: "somewhere-else" });
    expect(await run(h, [])).toBe(EXIT.USAGE);
    expect(text(h.io)).toContain('error: "somewhere-else" is not one of the candidates above.');
    expect(h.calls).toHaveLength(0);
  });

  test("a peer refuses: peers are added from the lead", async () => {
    const h = harness({ store: leadStore({ lead: member({ memberId: "desk", role: "lead" }) }) });
    expect(await run(h)).toBe(EXIT.STATE);
    expect(text(h.io)).toContain("peers are added from the lead");
  });

  // #248, second half: a lead installed by install.sh has no commit to push, and it no longer stops
  // there. It installs the member from the release it runs itself, over the same ssh.
  test("a binary lead installs the member from its own release, and bundles nothing", async () => {
    const h = releaseHarness();
    expect(await run(h)).toBe(EXIT.OK);
    expect(h.calls.map((c) => c.leg)).toEqual(["probe", "install", "configure", "membership", "enroll"]);
    expect(h.bundles).toBe(0);
    const install = h.calls.find((c) => c.leg === "install")!;
    // The payload IS Collie's own installer, out of this binary — never fetched on the far machine.
    expect(install.stdin!.startsWith("#!/bin/sh\n")).toBe(true);
    expect(install.stdin).toContain("Collie's installer");
    expect(install.stdin).toBe(INSTALLER_SH);
    expect(install.script).toContain(`COLLIE_TAG='v${VERSION}'`);
    expect(install.script).toContain("COLLIE_DIR=\"$DIR\"");
    expect(install.script).toContain(`DIR='${REMOTE_HOME}/.local/share/collie'`);
    expect(text(h.io)).toContain(`installing v${VERSION} from AltanS/collie`);
    expect(text(h.io)).toContain('✓ "nas" is a member of "the herd"');
  });

  test("a packaged lead takes the same route — its members take releases too", async () => {
    const h = releaseHarness({ installKind: { kind: "packaged" } });
    expect(await run(h)).toBe(EXIT.OK);
    expect(h.calls.map((c) => c.leg)).toContain("install");
    expect(h.bundles).toBe(0);
  });

  test("a peer is told it is a peer before it is told what kind of install it is", async () => {
    const h = harness({
      store: leadStore({ lead: member({ memberId: "desk", role: "lead" }) }),
      installKind: { kind: "binary" },
    });
    expect(await run(h)).toBe(EXIT.STATE);
    expect(text(h.io)).not.toContain("binary install");
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
  // build, the .env write and two lead restarts — and it named `--insecure`, which `crew add` does
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
      expect(said).toContain("`crew add` has no --insecure and will not get one");
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
    // crew verbs restart: the trust store is read once per process.
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

// ── Which multiplexer the member drives (#248) ───────────────────────────────
// A member that ran two multiplexers could not restart itself: `collie join` ends in a
// `collie restart` there, and `chooseMux` refuses a non-interactive run with two sightings. The
// operator at a terminal is the LEAD's operator, so leg 3 decides and writes `COLLIE_MUX`.

describe("the mux decision", () => {
  const report = (names: readonly string[]): MuxProbeReport => ({
    explicit: null,
    found: names.map((mux) => ({ mux, evidence: `a ${mux} thing` })),
  });

  test("the pure decision, branch by branch", () => {
    // `--mux` wins outright: over a name the member already carries, and over what runs there.
    expect(muxChoice({ flag: "tmux", envmux: "herdr", answer: report(["zellij"]), leadMux: "herdr" })).toEqual({
      kind: "flag",
      mux: "tmux",
    });
    // A member that already named one is left alone, and its machine is never read.
    expect(muxChoice({ flag: null, envmux: "zellij", answer: null, leadMux: "herdr" })).toEqual({
      kind: "kept",
      mux: "zellij",
    });
    // Nothing on the lead settles it, so the member has to be asked.
    expect(muxChoice({ flag: null, envmux: "", answer: null, leadMux: "herdr" })).toEqual({ kind: "unread" });
    expect(muxChoice({ flag: null, envmux: "", answer: report([]), leadMux: null })).toEqual({ kind: "none" });
    expect(muxChoice({ flag: null, envmux: "", answer: report(["tmux"]), leadMux: "herdr" })).toEqual({
      kind: "auto",
      mux: "tmux",
    });
    // Two is the standoff. The lead's own multiplexer is carried only when it is one of them.
    expect(muxChoice({ flag: null, envmux: "", answer: report(["herdr", "tmux"]), leadMux: "herdr" })).toEqual({
      kind: "ask",
      found: report(["herdr", "tmux"]).found,
      leadDrives: "herdr",
    });
    expect(muxChoice({ flag: null, envmux: "", answer: report(["herdr", "tmux"]), leadMux: "zellij" })).toEqual({
      kind: "ask",
      found: report(["herdr", "tmux"]).found,
      leadDrives: null,
    });
  });

  test("a --mux this build cannot drive is refused BEFORE any ssh runs", async () => {
    const h = harness();
    expect(await run(h, ["nas.example", "--mux", "screen"])).toBe(EXIT.USAGE);
    expect(h.calls).toHaveLength(0);
    expect(h.restarts).toBe(0);
    expect(text(h.io)).toContain("--mux screen is not a multiplexer this build drives");
    expect(text(h.io)).toContain("herdr, tmux, zellij");
  });

  test("--mux writes the name, over one the member already carries, without reading its machine", async () => {
    const h = harness();
    expect(await run(h, ["nas.example", "--mux", "tmux"])).toBe(EXIT.OK);
    expect(h.calls.map((c) => c.leg)).not.toContain("mux-probe");
    const configure = h.calls.find((c) => c.leg === "configure")!;
    expect(configure.script).toContain("printf 'COLLIE_MUX=%s\\n' 'tmux'");
    // The name that goes away is named: replacing somebody's value is the case they have to see.
    expect(text(h.io)).toContain("mux        tmux (named with --mux, replaces herdr already set there)");
  });

  test("--mux that restates the member's own value does not read as a change", async () => {
    const h = harness();
    expect(await run(h, ["nas.example", "--mux", "herdr"])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("mux        herdr (named with --mux, already set there)");
  });

  test("--mux on a member that named none says only what it named", async () => {
    const h = harness({ answers: { probe: { stdout: probeOut({ envmux: "" }) } } });
    expect(await run(h, ["nas.example", "--mux", "zellij"])).toBe(EXIT.OK);
    expect(h.calls.map((c) => c.leg)).not.toContain("mux-probe");
    expect(text(h.io)).toContain("mux        zellij (named with --mux)");
  });

  test("a member that already names one is left alone — nothing read, nothing written", async () => {
    const h = harness();
    expect(await run(h)).toBe(EXIT.OK);
    expect(h.calls.map((c) => c.leg)).not.toContain("mux-probe");
    expect(h.calls.find((c) => c.leg === "configure")!.script).not.toContain("COLLIE_MUX");
    expect(text(h.io)).toContain("mux        herdr (already set there)");
  });

  test("exactly one running multiplexer is named and left for the member's own first start", async () => {
    const h = harness({
      answers: { probe: { stdout: probeOut({ envmux: "" }) }, "mux-probe": { stdout: muxProbeOut(["tmux"]) } },
    });
    expect(await run(h)).toBe(EXIT.OK);
    expect(h.calls.map((c) => c.leg)).toContain("mux-probe");
    expect(h.calls.find((c) => c.leg === "configure")!.script).not.toContain("COLLIE_MUX");
    expect(text(h.io)).toContain("mux        tmux (the only one running there)");
  });

  test("none running is a warning on stdout, not a stop", async () => {
    const h = harness({
      answers: { probe: { stdout: probeOut({ envmux: "" }) }, "mux-probe": { stdout: muxProbeOut([]) } },
    });
    expect(await run(h)).toBe(EXIT.OK);
    expect(h.io.stdout.join("\n")).toContain(
      "warn: no multiplexer is running on nas.example. The restart that ends this run will refuse" +
        " there until one runs, or until `--mux <name>` names one; the member is enrolled either way.",
    );
    expect(h.calls.find((c) => c.leg === "configure")!.script).not.toContain("COLLIE_MUX");
  });

  test("two running is asked at the lead's terminal, and the pick is written", async () => {
    const h = harness({
      prompt: "2",
      env: { COLLIE_MUX: "herdr" },
      answers: {
        probe: { stdout: probeOut({ envmux: "" }) },
        "mux-probe": { stdout: muxProbeOut(["herdr", "tmux"]) },
      },
    });
    expect(await run(h)).toBe(EXIT.OK);
    const said = text(h.io);
    expect(said).toContain("nas.example runs 2 multiplexers:");
    expect(said).toContain("1) herdr");
    // The lead's own multiplexer is stated as a fact before the question; it is never a default.
    expect(said).toContain("This lead drives herdr. The member does not have to match.");
    expect(h.calls.find((c) => c.leg === "configure")!.script).toContain("printf 'COLLIE_MUX=%s\\n' 'tmux'");
  });

  test("two running with nowhere to ask is STATE, and nothing is written", async () => {
    const h = harness({
      prompt: null,
      answers: {
        probe: { stdout: probeOut({ envmux: "" }) },
        "mux-probe": { stdout: muxProbeOut(["herdr", "tmux"]) },
      },
    });
    expect(await run(h)).toBe(EXIT.STATE);
    expect(h.calls.map((c) => c.leg)).not.toContain("configure");
    const said = text(h.io);
    expect(said).toContain("runs 2 multiplexers (herdr, tmux), and this run is not interactive");
    expect(said).toContain("collie crew add nas.example --mux <name>");
    expect(said).toContain("The member is installed and unchanged otherwise.");
  });

  test("an unreadable answer is the third error family — never a guess", async () => {
    const h = harness({
      answers: {
        probe: { stdout: probeOut({ envmux: "" }) },
        "mux-probe": { stdout: "Traceback: not json at all", stderr: "bad verb" },
      },
    });
    expect(await run(h)).toBe(EXIT.FAIL);
    expect(h.calls.map((c) => c.leg)).not.toContain("configure");
    expect(text(h.io)).toContain("could not read which multiplexers run on nas.example");
  });

  // The bind short-circuit used to skip the whole leg, which would now skip a COLLIE_MUX the
  // operator has just named on the command line.
  test("a bind that is already right still gets the mux written", async () => {
    const h = harness({
      answers: {
        probe: {
          stdout: probeOut({ checkout: REMOTE_CHECKOUT, commit: COMMIT, envhost: "100.64.0.9", envport: "8787" }),
        },
      },
    });
    expect(await run(h, ["nas.example", "--mux", "zellij"])).toBe(EXIT.OK);
    const configure = h.calls.find((c) => c.leg === "configure")!;
    expect(configure.script).toContain("printf 'COLLIE_MUX=%s\\n' 'zellij'");
    expect(text(h.io)).toContain("✓ bind       COLLIE_MUX=zellij written to");
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

  test("already a member of THIS crew is a ✓ and exit OK — nothing is minted", async () => {
    const h = harness({
      answers: {
        probe: { stdout: probeOut({ checkout: REMOTE_CHECKOUT, commit: COMMIT }) },
        membership: { stdout: ["crew   the herd  (crew-1)", "mode   peer", "self   nas  abcd…"].join("\n") },
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
  // runs on this path, and a join is the only thing that ever restarted a peer from `crew add`. The
  // operator had just consented to "replace it with 1.2.3"; `crew status` then still said 1.2.2.
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
        membership: { stdout: ["crew   the herd  (crew-1)", "mode   peer", "self   nas  abcd…"].join("\n") },
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
        membership: { stdout: ["crew   the herd  (crew-1)", "mode   peer", "self   nas  abcd…"].join("\n") },
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
        membership: { stdout: ["crew   the herd  (crew-1)", "mode   peer", "self   nas  abcd…"].join("\n") },
      },
    });
    expect(await run(h)).toBe(EXIT.OK);
    expect(h.calls.map((c) => c.leg)).not.toContain("restart");
    expect(text(h.io)).toContain('✓ already a member of "the herd" as "nas"');
  });

  test("a member of ANOTHER crew is STATE, naming `collie leave` there — never run for you", async () => {
    const h = harness({
      answers: {
        probe: { stdout: probeOut({ checkout: REMOTE_CHECKOUT, commit: COMMIT }) },
        membership: { stdout: ["crew   someone else  (crew-99)", "mode   peer", "self   nas  abcd…"].join("\n") },
      },
    });
    expect(await run(h)).toBe(EXIT.STATE);
    expect(text(h.io)).toContain("`collie leave` THERE first");
    expect(h.calls.map((c) => c.leg)).not.toContain("enroll");
  });
});

// ── The release route (#248) ─────────────────────────────────────────────────
// A lead with no commit installs a member from the release it runs itself. Everything below is
// decided from ONE fact about the lead (its install kind) and ONE about the member (what Collie, if
// any, is already there) — and the member's fact comes from leg 1, never from an assumption.

describe("the release route", () => {
  /** A member that already carries an install.sh layout, at `version`. */
  const installedAt = (version: string): string =>
    probeOut({
      checkout: MEMBER_CURRENT,
      checkoutgit: "no",
      installroot: MEMBER_INSTALL_ROOT,
      version,
    });

  test("a fresh member is installed at install.sh's own default, and told how to link it", async () => {
    const h = releaseHarness();
    expect(await run(h)).toBe(EXIT.OK);
    const rendered = text(h.io);
    expect(rendered).toContain(`herdr plugin link "${MEMBER_CURRENT}"`);
    // Legs 3 and 4 address the binary behind `current`, which is the one that will be running.
    expect(h.calls.find((c) => c.leg === "membership")!.script).toContain(MEMBER_CURRENT);
    expect(h.calls.find((c) => c.leg === "enroll")!.script).toContain(MEMBER_CURRENT);
  });

  test("--path names the install root, and the probe looks behind its `current` too", async () => {
    const h = releaseHarness({ answers: { probe: { stdout: probeOut() } } });
    expect(await run(h, ["nas.example", "--path", "/srv/collie"])).toBe(EXIT.OK);
    expect(h.calls[0]!.script).toContain("for _d in '/srv/collie' '/srv/collie/current'; do");
    expect(h.calls.find((c) => c.leg === "install")!.script).toContain("DIR='/srv/collie'");
  });

  test("a member already at this release is left alone — nothing sent", async () => {
    const h = releaseHarness({ answers: { probe: { stdout: installedAt(VERSION) } } });
    expect(await run(h)).toBe(EXIT.OK);
    expect(h.calls.map((c) => c.leg)).not.toContain("install");
    expect(text(h.io)).toContain(`already at ${VERSION} — nothing sent`);
  });

  // A built Collie answers `<version>+<sha>`, and the tag is the version alone.
  test("the build stamp is not a version difference", async () => {
    const h = releaseHarness({ answers: { probe: { stdout: installedAt(`${VERSION}+ab12cd3`) } } });
    expect(await run(h)).toBe(EXIT.OK);
    expect(h.calls.map((c) => c.leg)).not.toContain("install");
  });

  test("a member at another release is asked first, then laid down beside what is there", async () => {
    const h = releaseHarness({ confirm: true, answers: { probe: { stdout: installedAt("1.0.0") } } });
    expect(await run(h)).toBe(EXIT.OK);
    const install = h.calls.find((c) => c.leg === "install")!;
    expect(install.script).toContain(`DIR='${MEMBER_INSTALL_ROOT}'`);
    expect(install.script).toContain(`COLLIE_TAG='v${VERSION}'`);
  });

  test("N at that question changes nothing", async () => {
    const h = releaseHarness({ confirm: false, answers: { probe: { stdout: installedAt("1.0.0") } } });
    expect(await run(h)).toBe(EXIT.STATE);
    expect(h.calls.map((c) => c.leg)).toEqual(["probe"]);
    expect(text(h.io)).toContain("left alone — nothing was installed, configured or enrolled.");
  });

  test("a run with nowhere to ask aborts, naming the question in full", async () => {
    const h = releaseHarness({ confirm: null, answers: { probe: { stdout: installedAt("1.0.0") } } });
    expect(await run(h)).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain(
      `nas.example has Collie 1.0.0 at ${MEMBER_INSTALL_ROOT}; replace it with ${VERSION}?`,
    );
    expect(h.calls.map((c) => c.leg)).toEqual(["probe"]);
  });

  // A checkout is somebody's working tree, and the remedy is one command typed there.
  test("a member running a git checkout is refused, and told the command that moves it", async () => {
    const h = releaseHarness({
      answers: { probe: { stdout: probeOut({ checkout: REMOTE_CHECKOUT, checkoutgit: "yes", version: "1.0.0" }) } },
    });
    expect(await run(h)).toBe(EXIT.STATE);
    expect(text(h.io)).toContain(`collie update --to-tag v${VERSION}`);
    expect(text(h.io)).toContain("Nothing was installed, configured or enrolled.");
    expect(h.calls.map((c) => c.leg)).toEqual(["probe"]);
  });

  test("a member running a git checkout at this very release is enrolled, not refused", async () => {
    const h = releaseHarness({
      answers: { probe: { stdout: probeOut({ checkout: REMOTE_CHECKOUT, checkoutgit: "yes", version: VERSION }) } },
    });
    expect(await run(h)).toBe(EXIT.OK);
    expect(h.calls.map((c) => c.leg)).toEqual(["probe", "configure", "membership", "enroll"]);
  });

  test("a Collie that is neither shape is left alone and added by hand", async () => {
    const h = releaseHarness({
      answers: { probe: { stdout: probeOut({ checkout: "/opt/collie", checkoutgit: "no", version: "1.0.0" }) } },
    });
    expect(await run(h)).toBe(EXIT.STATE);
    expect(text(h.io)).toContain("neither a git checkout nor an");
    expect(text(h.io)).toContain("`collie crew invite` here");
    expect(h.calls.map((c) => c.leg)).toEqual(["probe"]);
  });

  test("a lead that follows a fork sends its own repo, or the member would install upstream", async () => {
    const h = releaseHarness({ env: { COLLIE_UPDATE_REPO: "me/collie" } });
    expect(await run(h)).toBe(EXIT.OK);
    expect(h.calls.find((c) => c.leg === "install")!.script).toContain("COLLIE_UPDATE_REPO='me/collie'");
  });

  test("the prerequisites are the installer's three, and git and Bun are not among them", async () => {
    for (const [tool, needle] of [
      ["curl", "no `curl` on nas.example — install curl there"],
      ["tar", "no `tar` on nas.example"],
      ["sha256", "install sha256sum or shasum there"],
    ] as const) {
      const h = releaseHarness({ answers: { probe: { stdout: probeOut({ [tool]: "" }) } } });
      expect(await run(h)).toBe(EXIT.FAIL);
      expect(text(h.io)).toContain(needle);
      expect(h.calls).toHaveLength(1);
    }
    const noToolchain = releaseHarness({ answers: { probe: { stdout: probeOut({ git: "", bun: "" }) } } });
    expect(await run(noToolchain)).toBe(EXIT.OK);
  });

  test("a lead whose own version cannot be read refuses before the first ssh byte", async () => {
    // No manifest seeded: `collieVersionBare` answers `unknown`, which is no release to pin to.
    const h = harness({ installKind: { kind: "binary" } });
    expect(await run(h)).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("there is no release to pin nas.example to");
    expect(h.calls).toHaveLength(0);
    expect(h.closed).toBe(0);
  });

  test("the installer's own diagnosis is what the operator is shown", async () => {
    const h = releaseHarness({
      answers: {
        install: {
          code: 1,
          stderr: [
            "Downloading Collie v1.2.3 for linux-x64…",
            "collie install: release v1.2.3 has no linux-x64 artifact",
          ].join("\n"),
        },
      },
    });
    expect(await run(h)).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("collie install: release v1.2.3 has no linux-x64 artifact");
    expect(text(h.io)).toContain("runs what it ran before");
  });

  // `crew-ops.json` is how a later `crew update --path` and the probe's candidate list find this
  // machine again, so what is banked is the path the binary really lives behind.
  test("how the member was reached is banked at the path that finds it again", async () => {
    const h = releaseHarness();
    expect(await run(h)).toBe(EXIT.OK);
    // SAFETY: `harness` builds `deps.ops` with `fakeOps` and nothing else ever assigns it, so the
    // `contents()` that fake adds is present on this value.
    const ops = h.deps.ops as ReturnType<typeof fakeOps>;
    expect(ops.contents()).toContain(MEMBER_CURRENT);
  });
});

describe("the bundle route meets a release member", () => {
  // Before the probe could see an install.sh layout, this push cloned a SECOND Collie into
  // `~/.collie` and left the first one running. It is now a refusal, on either side of the version.
  test("a checkout lead refuses a member that takes releases", async () => {
    const h = harness({
      answers: {
        probe: {
          stdout: probeOut({
            checkout: MEMBER_CURRENT,
            checkoutgit: "no",
            installroot: MEMBER_INSTALL_ROOT,
            version: VERSION,
          }),
        },
      },
    });
    expect(await run(h)).toBe(EXIT.STATE);
    const rendered = text(h.io);
    expect(rendered).toContain(`nas.example has a binary install at ${MEMBER_INSTALL_ROOT}`);
    expect(rendered).toContain("add");
    expect(rendered).toContain("from a lead that runs a release");
    expect(h.calls.map((c) => c.leg)).toEqual(["probe"]);
    expect(h.bundles).toBe(0);
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
  test("`collie crew add` routes here, and the help lists it", async () => {
    const h = harness();
    expect(await cmdCrew(h.deps, ["add", "nas.example"])).toBe(EXIT.OK);
    expect(h.calls.map((c) => c.leg)).toContain("enroll");
    const usage = harness();
    await cmdCrew(usage.deps, ["nonsense"]);
    expect(text(usage.io)).toContain("add      install and enroll a peer over SSH");
  });

  test("the crew it joins is the one this lead already leads", () => {
    expect(CREW.crewId).toBe("crew-1");
  });
});

// ── `crewAddDeps().gitBundle` against a REAL git ─────────────────────────────
// The fakes above stub `gitBundle` entirely, which is exactly how the field bug (a bare commit sha
// is not a REF, so `git bundle create - <sha>` refuses with "Refusing to create empty bundle")
// survived. This suite spawns a real `git` against a throwaway repo instead.

/** {@link CrewDeps} whose `io` is the recording one, so a failure can print what the verb said. */
interface RepoCrewDeps extends CrewDeps {
  io: ReturnType<typeof capture>;
}

/** A repo-scoped env with no `PATH` surprises and no inherited `GIT_*` — see collie-cli.test.sh. */
function gitEnv(): Environment {
  return { PATH: process.env.PATH };
}

function minimalCrewDeps(root: string): RepoCrewDeps {
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

describe("crewAddDeps().gitBundle, against a real repo", () => {
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

      const staleDeps = minimalCrewDeps(root);
      const staleBundle = await crewAddDeps(staleDeps).gitBundle(first, staleDeps.io);
      expect(staleBundle).toBeNull();

      const freshDeps = minimalCrewDeps(root);
      const encoded = await crewAddDeps(freshDeps).gitBundle(second, freshDeps.io);
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

      const deps = minimalCrewDeps(root);
      const encoded = await crewAddDeps(deps).gitBundle(head, deps.io);
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
      // the bundle pushed by `crew add` is complete (bundle of HEAD, no prerequisites).
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
