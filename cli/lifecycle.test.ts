import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  capture,
  CONFIG,
  context,
  type FakeExec,
  fakeExec,
  type FakeFiles,
  fakeFiles,
  fakeLinkFs,
  HOME,
  ROOT,
  STATE,
  type Scripted,
} from "./fakes.ts";
import { leadStore, member, peerStore } from "../bridge/crew/fixtures.ts";
import { hostFor, type Host } from "../bridge/host.ts";
import { serializeTrustStore } from "../bridge/crew/trust-store.ts";
import { EXIT, type Io } from "./io.ts";
import { POWERSHELL_UTF8, PROCESS_QUERY_SLOW_START_MS } from "./sys.ts";
import { collieBinary, taskFilePath } from "./unit.ts";

// The binary, spelled the way the code under test spells it. `collieBinary` joins with the host
// separator, so a POSIX literal like `/opt/collie/bin/collie` never matches on a Windows host, and it
// names `bin/collie.exe` for a `win32` platform. Everything here asks for the binary of the platform
// the harness injects (`deps.host`), never the host's: `BINARY` is the one every non-Windows
// harness platform shares, and `binaryOn` is the one for a platform a test pins.
const binaryOn = (platform: NodeJS.Platform): string => collieBinary(ROOT, hostFor(platform));
const BINARY = binaryOn("linux");

/** The `Io` a nested `serve` was handed — `null` until it has been called. */
interface SeenIo {
  io: Io | null;
}
import {
  cmdLogs,
  cmdRestart,
  cmdStart,
  cmdStatus,
  cmdStop,
  cmdUninstall,
  cmdUrl,
  isOurBridge,
  KILL_SETTLE_MS,
  type LifecycleDeps,
  serviceDescription,
  statusBanner,
  STOP_SETTLE_MS,
  stopPidfileProcess,
  resolveTailscaleHosts,
  supervisionTier,
  systemdUserReachable,
  writeUnit,
} from "./lifecycle.ts";
import { formatTaskRecord, taskRecordPath, taskRestartPath } from "./task-scheduler.ts";

// The lifecycle, driven end to end against fakes for the two seams (cli/fakes.ts). The shell could
// only reach this coverage by `source`-ing itself and redefining functions in a heredoc; here
// `start` on all three supervision tiers, the launchd retry, the pidfile guard, `uninstall` and the
// banner are ordinary unit tests.

interface Harness {
  deps: LifecycleDeps;
  io: ReturnType<typeof capture>;
  exec: FakeExec;
  files: FakeFiles;
  /** Every `(port, host)` pair the banner's readiness probe was called with. */
  readyCalls: Array<{ port: number; host: string }>;
}

type HarnessOptions = Partial<
  Scripted & {
    host: Host;
    ready: boolean;
    env: Record<string, string | undefined>;
    /** The `COLLIE_INSTANCE` suffix this Collie was resolved with. Absent = the solo instance. */
    instance: string | null;
    files: Record<string, string>;
    serve: (io?: Io) => Promise<number>;
  }
>;

function harness(over: HarnessOptions = {}): Harness {
  const io = capture();
  const exec = fakeExec(over);
  // The binary exists unless a test deliberately removes it — every other test would otherwise be
  // asserting the "no binary" guard by accident.
  const files = fakeFiles({ [BINARY]: "", [`${ROOT}/web/package.json`]: "{}", [collieBinary(ROOT, over.host ?? hostFor("linux"))]: "", ...over.files });
  const readyCalls: Array<{ port: number; host: string }> = [];
  const deps: LifecycleDeps = {
    // Every fixture here is a Collie that has already chosen its multiplexer, so `start`'s first-run
    // gate (`cli/mux.ts`) returns before it probes. A supervision test must not also be a test of
    // that question — `cli/mux.test.ts` owns it, and the one case where it stops `start` is pinned
    // below in "the first-run multiplexer gate".
    ctx: context(
      { COLLIE_MUX: "herdr", ...over.env },
      over.instance === undefined ? {} : { instance: over.instance },
    ),
    io,
    exec,
    files,
    ready: (port, host) => {
      readyCalls.push({ port, host });
      return Promise.resolve(over.ready ?? true);
    },
    sleep: () => Promise.resolve(),
    uid: () => 501,
    host: over.host ?? hostFor("linux"),
    serve: over.serve ?? (() => Promise.resolve(EXIT.OK)),
  };
  return { deps, io, exec, files, readyCalls };
}

/** The scripted answer that makes `systemctl --user show-environment` fail — no user systemd. */
const NO_SYSTEMD: Scripted["answers"] = [["systemctl --user show-environment", { code: 1 }]];

// The bridge's Host gate fails closed, so this value is the difference between a Collie that answers
// on the tailnet and one that refuses every request. The shim discovered it; the binary does now.
describe("the Host allowlist discovery", () => {
  const TAILSCALE = (json: string): Scripted["answers"] => [
    ["tailscale status --json", { stdout: json }],
  ];
  const SELF = JSON.stringify({
    Self: { DNSName: "desk.tail1234.ts.net.", TailscaleIPs: ["100.64.0.1"] },
  });

  test("discovers the node's name and IPs, and bakes them into the unit", () => {
    const h = harness({ answers: TAILSCALE(SELF) });
    expect(writeUnit(h.deps)).toBe(true);
    expect(h.files.read(`${HOME}/.config/systemd/user/collie.service`)).toContain(
      "Environment=COLLIE_TAILSCALE_HOSTS=desk.tail1234.ts.net,100.64.0.1",
    );
  });

  test("the operator's own value wins and is never probed over", () => {
    const h = harness({
      env: { COLLIE_TAILSCALE_HOSTS: "collie.example.com" },
      answers: TAILSCALE(SELF),
    });
    expect(resolveTailscaleHosts(h.deps)).toBe("collie.example.com");
    expect(h.exec.calls).not.toContain("tailscale status --json");
  });

  test("COLLIE_SKIP_SERVE=1 discovers nothing — the operator's ingress names its own hosts", () => {
    const h = harness({ env: { COLLIE_SKIP_SERVE: "1" }, answers: TAILSCALE(SELF) });
    expect(resolveTailscaleHosts(h.deps)).toBe("");
    expect(h.exec.calls).not.toContain("tailscale status --json");
  });

  test("a failed probe KEEPS what the unit already carried, and says so", () => {
    const h = harness({
      answers: [["tailscale status --json", { code: 1 }]],
      files: {
        [`${HOME}/.config/systemd/user/collie.service`]:
          "Environment=COLLIE_TAILSCALE_HOSTS=desk.tail1234.ts.net\n",
      },
    });
    expect(resolveTailscaleHosts(h.deps)).toBe("desk.tail1234.ts.net");
    expect(h.io.stderr.join("\n")).toContain("keeping the one already in the unit");
  });

  test("a failed probe with nothing to keep says the gate will refuse everything", () => {
    const h = harness({ answers: [["tailscale status --json", { code: 1 }]] });
    expect(resolveTailscaleHosts(h.deps)).toBe("");
    expect(h.io.stderr.join("\n")).toContain("the Host gate will refuse every request");
    expect(h.io.stderr.join("\n")).toContain("COLLIE_TAILSCALE_HOSTS");
  });

  test("a failed probe never writes an EMPTY allowlist into the unit", () => {
    const h = harness({ answers: [["tailscale status --json", { code: 1 }]] });
    expect(writeUnit(h.deps)).toBe(true);
    expect(h.files.read(`${HOME}/.config/systemd/user/collie.service`)).not.toContain(
      "COLLIE_TAILSCALE_HOSTS",
    );
  });
});

describe("supervision tiers", () => {
  test("systemd requires the user instance to answer, not just the binary to exist", () => {
    expect(supervisionTier(fakeExec(), hostFor("linux"))).toBe("systemd");
    expect(supervisionTier(fakeExec({ answers: NO_SYSTEMD }), hostFor("linux"))).toBe("unsupervised");
    expect(supervisionTier(fakeExec({ absent: ["systemctl"] }), hostFor("linux"))).toBe("unsupervised");
  });

  test("launchd is gated on Darwin — the gui/<uid> domain is Darwin-only", () => {
    expect(supervisionTier(fakeExec({ answers: NO_SYSTEMD }), hostFor("darwin"))).toBe("launchd");
    // launchctl exists on this Linux box (it doesn't, but prove the platform gate is what decides).
    expect(supervisionTier(fakeExec({ answers: NO_SYSTEMD }), hostFor("linux"))).toBe("unsupervised");
    expect(supervisionTier(fakeExec({ answers: NO_SYSTEMD, absent: ["launchctl"] }), hostFor("darwin"))).toBe(
      "unsupervised",
    );
  });

  test("COLLIE_SUPERVISOR pins the tier, and a typo is ignored rather than fatal", () => {
    const pin = (v: string): string => supervisionTier(fakeExec(), hostFor("linux"), { COLLIE_SUPERVISOR: v });
    expect(pin("launchd")).toBe("launchd");
    expect(pin("unsupervised")).toBe("unsupervised");
    // This decides where the bridge runs; a typo must not take the host down.
    expect(pin("runit")).toBe("systemd");
    expect(pin("")).toBe("systemd");
  });
});

// A Herdr plugin action injects `HERDR_SOCKET_PATH` / `HERDR_PLUGIN_CONFIG_DIR` and nothing else —
// no login shell, so no `XDG_RUNTIME_DIR` or `DBUS_SESSION_BUS_ADDRESS` either, and the plain probe
// fails even on a host where systemd --user is running (#194).
describe("systemdUserReachable's session-env retry (#194)", () => {
  const uid = process.getuid?.() ?? 0;

  test("a failed probe retries once with a derived session env when the caller's env has neither var", () => {
    let retryEnv: Readonly<Record<string, string>> | undefined;
    const exec = fakeExec({
      answers: [
        [
          "systemctl --user show-environment",
          {
            perCall: (n, env) => {
              if (n === 2) retryEnv = env;
              return { code: env?.XDG_RUNTIME_DIR === undefined ? 1 : 0 };
            },
          },
        ],
      ],
    });
    expect(systemdUserReachable(exec, {})).toBe(true);
    expect(exec.calls.filter((c) => c === "systemctl --user show-environment")).toHaveLength(2);
    expect(retryEnv?.XDG_RUNTIME_DIR).toBe(`/run/user/${uid}`);
    expect(retryEnv?.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=/run/user/${uid}/bus`);
  });

  test("the caller's own XDG_RUNTIME_DIR wins — a failed probe is never retried over it", () => {
    const exec = fakeExec({ answers: NO_SYSTEMD });
    expect(systemdUserReachable(exec, { XDG_RUNTIME_DIR: "/run/user/9999" })).toBe(false);
    // One call, not two: a name the caller's env already carries is never overridden or retried.
    expect(exec.calls.filter((c) => c === "systemctl --user show-environment")).toHaveLength(1);
  });

  test("a probe that still fails with the derived env reports unsupervised — the container case", () => {
    const exec = fakeExec({ answers: NO_SYSTEMD });
    expect(systemdUserReachable(exec, {})).toBe(false);
    expect(supervisionTier(exec, hostFor("linux"), {})).toBe("unsupervised");
  });
});

describe("the pidfile guard", () => {
  test("recognises our own bridge by the command line ExecStart produces", () => {
    expect(isOurBridge(`${BINARY} _exec-bridge`, BINARY)).toBe(true);
    // The shell matched `bridge/index.ts`; that string is gone, and a predicate that still looked
    // for it would silently degrade to killing nothing.
    expect(isOurBridge("/opt/homebrew/bin/bun run /x/bridge/index.ts", BINARY)).toBe(false);
    expect(isOurBridge("/Applications/Something.app/Contents/MacOS/Something", BINARY)).toBe(false);
    // The binary invoked as a CLI is not the daemon.
    expect(isOurBridge(`${BINARY} status`, BINARY)).toBe(false);
  });

  test("recognises a binary install's bridge across a version flip, but not a stranger install", () => {
    const OLD = "/home/pat/.local/share/collie/versions/1.5.6/bin/collie";
    const NEW = "/home/pat/.local/share/collie/versions/1.6.0/bin/collie";
    // The post-flip restart runs as NEW (`ctx.root` resolves through `process.execPath`), and must
    // still recognise the OLD version's bridge as its own to stop it — the one case a self-update
    // wedges forever in if this predicate cannot see past the version directory.
    expect(isOurBridge(`${OLD} _exec-bridge`, NEW)).toBe(true);
    expect(isOurBridge(`${NEW} _exec-bridge`, OLD)).toBe(true);
    // A different install entirely — same version string, different root — is still refused.
    const STRANGER = "/home/pat/.local/share/collie-other/versions/1.6.0/bin/collie";
    expect(isOurBridge(`${STRANGER} _exec-bridge`, NEW)).toBe(false);
  });

  test("kills the pid only when it is still our bridge, and always drops the record", () => {
    const h = harness({
      files: { [`${CONFIG}/collie.pid`]: "4242\n" },
      ps: { 4242: `${BINARY} _exec-bridge` },
    });
    stopPidfileProcess(h.deps);
    expect(h.exec.killed).toEqual([4242]);
    expect(h.files.exists(`${CONFIG}/collie.pid`)).toBe(false);
    // A plain liveness question keeps the short default bound (#309 review).
    expect(h.exec.probed).toEqual([{ pid: 4242 }]);
  });

  test("recognises its bridge by the injected platform's binary name, `collie.exe` on win32", () => {
    const win = harness({
      host: hostFor("win32"),
      files: { [`${CONFIG}/collie.pid`]: "4242\n" },
      ps: { 4242: `${binaryOn("win32")} _exec-bridge` },
    });
    stopPidfileProcess(win.deps);
    expect(win.exec.killed).toEqual([4242]);
    // Under win32 the binary this install has is `collie.exe`; the bare name is somebody else's.
    const bare = harness({
      host: hostFor("win32"),
      files: { [`${CONFIG}/collie.pid`]: "4242\n" },
      ps: { 4242: `${binaryOn("linux")} _exec-bridge` },
    });
    stopPidfileProcess(bare.deps);
    expect(bare.exec.killed).toEqual([]);
  });

  test("never signals a pid the OS recycled to something else", () => {
    const h = harness({
      files: { [`${CONFIG}/collie.pid`]: "4243\n" },
      ps: { 4243: "/Applications/Something.app/Contents/MacOS/Something" },
    });
    stopPidfileProcess(h.deps);
    expect(h.exec.killed).toEqual([]);
    // The stale record still has to go, or it is re-examined on every future start.
    expect(h.files.exists(`${CONFIG}/collie.pid`)).toBe(false);
  });

  test("a malformed or impossible pid is dropped, never signalled", () => {
    for (const bad of ["not-a-pid", "1", "0", ""]) {
      const h = harness({ files: { [`${CONFIG}/collie.pid`]: bad } });
      stopPidfileProcess(h.deps);
      expect(h.exec.killed).toEqual([]);
      expect(h.files.exists(`${CONFIG}/collie.pid`)).toBe(false);
    }
  });
});

describe("start, on systemd", () => {
  test("writes the unit, reloads, and enables it now", async () => {
    const h = harness();
    expect(await cmdStart(h.deps)).toBe(EXIT.OK);
    const unit = h.files.read(`${HOME}/.config/systemd/user/collie.service`);
    expect(unit).toContain(`ExecStart=${BINARY} _exec-bridge`);
    expect(h.exec.calls).toContain("systemctl --user daemon-reload");
    expect(h.exec.calls).toContain("systemctl --user enable --now collie");
    expect(h.io.stdout).toContain("bridge started (systemd --user: collie)");
  });

  test("refuses to install a unit pointing at a binary that isn't there", async () => {
    const h = harness();
    h.files.remove(binaryOn("linux"));
    expect(await cmdStart(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain(`no collie binary at ${binaryOn("linux")}`);
    expect(h.exec.calls).not.toContain("systemctl --user enable --now collie");
  });

  test("a failing front door prints the note and still reaches the banner, exit 0", async () => {
    // The pre-shim collie-ctl.sh — the bridge is already up on loopback and the banner is what
    // the README's troubleshooting flow tells people to read.
    const h = harness({ serve: () => Promise.resolve(EXIT.FAIL) });
    expect(await cmdStart(h.deps)).toBe(EXIT.OK);
    expect(h.io.stderr.join("\n")).toContain("the tailnet front door did not come up");
    expect(h.io.stdout.join("\n")).toContain("✓ Collie is running");
  });

  test("hands `serve` the CURRENT `deps.io`, not whatever `io` this deps object was originally built with", async () => {
    // The seam `cli/program.ts`'s `restart: (into?: Io) => …` and `serve: (into?: Io) => …` rely on:
    // a nested restart swaps `io` on a COPY of the deps object (`{ ...deps, io: into }`), and
    // `cmdStart` must read `serve`'s argument off THAT copy's `deps.io`, never off a `serve` closure
    // that captured the original. A field-found leak (2026-08-13) shipped because `cli/program.ts`'s
    // `serve` closure ignored the swap — this pins the contract at the one place a fix has to hold:
    // `cmdStart` actually passing `deps.io` through.
    const seen: SeenIo = { io: null };
    const h = harness({
      serve: (io?: Io) => {
        seen.io = io ?? null;
        return Promise.resolve(EXIT.OK);
      },
    });
    const swapped = capture();
    expect(await cmdStart({ ...h.deps, io: swapped })).toBe(EXIT.OK);
    expect(seen.io).toBe(swapped);
    expect(seen.io).not.toBe(h.deps.io);
  });

  test("builds the UI lazily on first run, and a failed build only warns", async () => {
    // The pre-shim collie-ctl.sh — Herdr runs `[[build]]` on `plugin install` and never on
    // `plugin link`, so `start` is where an unbuilt checkout gets its UI. It warns rather than
    // fails: the API runs and the UI 503s, which is legible where a refused `start` is not.
    const h = harness();
    expect(await cmdStart(h.deps)).toBe(EXIT.OK);
    expect(h.io.stdout.join("\n")).toContain("building web UI (first run)");

    // The answer is matched against the raw call line, which spells the cwd with `join`.
    const broken = harness({ answers: [[`${join(ROOT, "web")}$ bun run build --`, { code: 1 }]] });
    expect(await cmdStart(broken.deps)).toBe(EXIT.OK);
    expect(broken.io.stderr.join("\n")).toContain("the UI will 503");
    expect(broken.io.stdout.join("\n")).toContain("bridge started");
  });
});

describe("start, on launchd", () => {
  const JOB = "launchctl print gui/501/herdr.collie";
  const RUNNING: NonNullable<Scripted["answers"]>[number] = [JOB, { stdout: "gui/501/herdr.collie = {\n\tstate = running\n\tpid = 4242\n}\n" }];
  const LOADED: NonNullable<Scripted["answers"]>[number] = [JOB, { stdout: "gui/501/herdr.collie = {\n\tstate = not running\n}\n" }];
  // A job that came up is the default, so a test names only how it differs. The first matching
  // answer wins, so a test's own `launchctl print` answer goes ahead of RUNNING.
  const darwin = (over: HarnessOptions = {}): Harness =>
    harness({ ...over, host: hostFor("darwin"), answers: [...NO_SYSTEMD, ...(over.answers ?? []), RUNNING] });

  test("installs the plist mode 644 and bootstraps it, idempotently", async () => {
    const h = darwin();
    expect(await cmdStart(h.deps)).toBe(EXIT.OK);
    const plist = h.files.entries.get(`${HOME}/Library/LaunchAgents/herdr.collie.plist`);
    expect(plist?.mode).toBe(0o644);
    expect(plist?.text).toContain("<string>_exec-bridge</string>");
    // Bootout first: bootstrap on a loaded label errors, and a second bridge running quietly is the
    // failure this branch removes.
    expect(h.exec.calls).toContain("launchctl bootout gui/501/herdr.collie");
    expect(h.exec.calls).toContain("launchctl enable gui/501/herdr.collie");
    expect(h.exec.calls).toContain(
      `launchctl bootstrap gui/501 ${join(HOME, "Library", "LaunchAgents", "herdr.collie.plist")}`,
    );
    expect(h.io.stdout).toContain("bridge started (launchd: herdr.collie)");
  });

  test("kickstarts the job after bootstrap, and says started once a pid shows", async () => {
    const h = darwin();
    expect(await cmdStart(h.deps)).toBe(EXIT.OK);
    const launchctl = h.exec.calls.filter((c) => c.startsWith("launchctl "));
    const boot = launchctl.findIndex((c) => c.startsWith("launchctl bootstrap"));
    // No `-k`: a job that is already running is left alone.
    expect(launchctl[boot + 1]).toBe("launchctl kickstart gui/501/herdr.collie");
    expect(launchctl[boot + 2]).toBe(JOB);
    expect(h.io.stdout).toContain("bridge started (launchd: herdr.collie)");
    expect(h.io.stderr.join("\n")).not.toContain("no process is running");
  });

  test("a job that never ran is a warning with the manual command, not 'started'", async () => {
    const h = darwin({ answers: [LOADED] });
    expect(await cmdStart(h.deps)).toBe(EXIT.OK);
    expect(h.io.stdout.join("\n")).not.toContain("bridge started");
    const err = h.io.stderr.join("\n");
    expect(err).toContain("warn: launchd loaded herdr.collie but no process is running");
    expect(err).toContain("launchctl kickstart gui/501/herdr.collie");
    expect(err).toContain(join(CONFIG, "collie.log"));
    // Five reads of the job, one more than the waits between them.
    expect(h.exec.calls.filter((c) => c === JOB).length).toBeGreaterThanOrEqual(5);
    // It must not fall back to a second, unsupervised bridge beside the loaded job.
    expect(h.exec.spawned).toEqual([]);
  });

  test("the read-back waits at most two seconds in total", async () => {
    const h = darwin({ answers: [LOADED] });
    const waits: number[] = [];
    h.deps.sleep = (ms) => {
      waits.push(ms);
      return Promise.resolve();
    };
    await cmdStart(h.deps);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2000);
  });

  test("a pid that shows up on a later read still counts as started", async () => {
    const h = darwin({
      answers: [[JOB, { perCall: (n) => (n < 3 ? { stdout: "state = not running\n" } : { stdout: "\tpid = 4242\n" }) }]],
    });
    expect(await cmdStart(h.deps)).toBe(EXIT.OK);
    expect(h.io.stdout).toContain("bridge started (launchd: herdr.collie)");
    expect(h.io.stderr.join("\n")).not.toContain("no process is running");
  });

  test("a failing kickstart is not fatal when the job is running anyway", async () => {
    // RunAtLoad already started it, so kickstart may refuse; the pid is what decides.
    const h = darwin({ answers: [["launchctl kickstart", { code: 113, stderr: "Could not find service" }]] });
    expect(await cmdStart(h.deps)).toBe(EXIT.OK);
    expect(h.io.stdout).toContain("bridge started (launchd: herdr.collie)");
    expect(h.io.stderr.join("\n")).not.toContain("no process is running");
  });

  test("a failing bootstrap never reaches kickstart", async () => {
    const h = darwin({ answers: [["launchctl bootstrap", { code: 5, stderr: "Bootstrap failed: 5" }]] });
    expect(await cmdStart(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls.some((c) => c.startsWith("launchctl kickstart"))).toBe(false);
    expect(h.io.stdout.join("\n")).not.toContain("bridge started (launchd:");
  });

  test("migrates an install predating launchd support by releasing the port", async () => {
    const h = darwin({
      files: { [`${CONFIG}/collie.pid`]: "4242\n" },
      ps: { 4242: `${BINARY} _exec-bridge` },
    });
    expect(await cmdStart(h.deps)).toBe(EXIT.OK);
    expect(h.exec.killed).toEqual([4242]);
    expect(h.files.exists(`${CONFIG}/collie.pid`)).toBe(false);
  });

  test("retries across the bootout drain window", async () => {
    // `bootout` doesn't wait for teardown and the bridge drains connections, so `restart` (and so
    // `update`) can reach `bootstrap` while the old job is still going: EIO.
    const h = darwin({
      answers: [
        [
          "launchctl bootstrap",
          { perCall: (n) => (n > 1 ? {} : { code: 5, stderr: "Bootstrap failed: 5: Input/output error" }) },
        ],
      ],
    });
    expect(await cmdStart(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls.filter((c) => c.startsWith("launchctl bootstrap")).length).toBe(2);
    expect(h.io.stdout).toContain("bridge started (launchd: herdr.collie)");
  });

  test("degrades to unsupervised after three failures instead of leaving no bridge at all", async () => {
    // EIO is also how launchd reports "gui/<uid> doesn't exist" — every Mac administered purely
    // over SSH. Giving up would take a working host to NO bridge, since stop already killed the
    // unsupervised one on the way in.
    const h = darwin({
      answers: [["launchctl bootstrap", { code: 5, stderr: "Bootstrap failed: 5" }]],
    });
    expect(await cmdStart(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls.filter((c) => c.startsWith("launchctl bootstrap")).length).toBe(3);
    const err = h.io.stderr.join("\n");
    expect(err).toContain("warn: launchctl bootstrap failed after 3 attempts");
    expect(err).toContain("gui/501 does not exist");
    expect(err).toContain("unsupervised");
    // It must NOT claim the agent is running — the operator has to know supervision is absent.
    expect(h.io.stdout.join("\n")).not.toContain("bridge started (launchd:");
    expect(h.io.stdout.join("\n")).toContain("unsupervised)");
    // …and it must leave a pidfile, or there is nothing to stop later.
    expect(h.files.read(`${CONFIG}/collie.pid`)).toBe("4242\n");
  });
});

describe("start, unsupervised", () => {
  test("spawns the same command the supervisors run, with paths in its environment", async () => {
    const h = harness({ answers: NO_SYSTEMD });
    expect(await cmdStart(h.deps)).toBe(EXIT.OK);
    expect(h.exec.spawned).toHaveLength(1);
    expect(h.exec.spawned[0]?.command).toEqual([BINARY, "_exec-bridge"]);
    expect(h.exec.spawned[0]?.env.COLLIE_PLUGIN_ROOT).toBe(ROOT);
    expect(h.exec.spawned[0]?.env.COLLIE_PORT).toBe("8787");
    expect(h.exec.spawned[0]?.logPath).toBe(join(CONFIG, "collie.log"));
    expect(h.io.stdout).toContain("bridge started (pid 4242, unsupervised)");
  });

  test("passes the merged .env through — the daemon is the only reader of a mode-600 secret", async () => {
    const h = harness({ answers: NO_SYSTEMD, env: { COLLIE_VAPID_PRIVATE: "shhh" } });
    await cmdStart(h.deps);
    expect(h.exec.spawned[0]?.env.COLLIE_VAPID_PRIVATE).toBe("shhh");
  });
});

// The gate itself is `cli/mux.test.ts`'s subject; what is pinned here is that it sits IN FRONT of
// `start` — before the unit is written and before anything is spawned. A bridge launched for a
// multiplexer nobody chose is the outage M14/03 removes.
describe("the first-run multiplexer gate", () => {
  /** Where the tmux adapter's own candidate list looks first — a second sighting, in one file. */
  const TMUX_BIN = "/usr/bin/tmux";
  const unchosen = (over: HarnessOptions = {}): Harness =>
    harness({ ...over, env: { ...over.env, COLLIE_MUX: undefined } });

  test("refuses `start` when nothing is configured and nothing is running", async () => {
    const h = unchosen({ answers: NO_SYSTEMD });
    expect(await cmdStart(h.deps)).toBe(EXIT.FAIL);
    expect(h.exec.spawned).toHaveLength(0);
    expect(h.io.stderr.join("\n")).toContain("no COLLIE_MUX is set");
    expect(h.io.stderr.join("\n")).toContain(join(CONFIG, ".env"));
  });

  test("auto-selects the only multiplexer running, writes it down, and hands it to the bridge", async () => {
    const socket = "/home/pat/.config/herdr/herdr.sock";
    const h = unchosen({ answers: NO_SYSTEMD, files: { [socket]: "" } });
    expect(await cmdStart(h.deps)).toBe(EXIT.OK);
    expect(h.files.read(`${CONFIG}/.env`)).toContain("COLLIE_MUX=herdr");
    // Both halves: the file a supervised bridge reads, and the environment this one is spawned with.
    expect(h.exec.spawned[0]?.env.COLLIE_MUX).toBe("herdr");
  });

  // `restart` asks the SAME question, and asks it FIRST. A refusal reached from inside `start` would
  // arrive after `stop` had already disabled the unit, so the verb that promises a running bridge
  // would end with none — the 1.0.0 outage this pins shut.
  test("`restart` refuses before it stops anything, so the bridge it cannot re-start stays up", async () => {
    const socket = "/home/pat/.config/herdr/herdr.sock";
    const h = unchosen({
      files: { [socket]: "", [TMUX_BIN]: "" },
      answers: [[`${TMUX_BIN} list-sessions`, { stdout: "work\n" }]],
    });
    expect(await cmdRestart(h.deps)).toBe(EXIT.FAIL);
    // The whole point: no service manager was touched, and the line `stop` prints was never printed.
    expect(h.exec.calls).toEqual([`${TMUX_BIN} list-sessions -F #{session_name}`]);
    expect(h.io.stdout).not.toContain("bridge stopped");
    expect(h.exec.spawned).toHaveLength(0);
    const said = h.io.stderr.join("\n");
    expect(said).toContain("no COLLIE_MUX is set, and 2 multiplexers are running");
    expect(said).toContain("  COLLIE_MUX=<herdr|tern|tmux|tuios|zellij> collie start");
  });
});

// On Windows the bridge runs under Task Scheduler: the task runs `collie _supervise`, which runs the
// bridge and records both pids in `collie-processes` (cli/task-scheduler.ts). These cases drive that
// tier with `hostFor("win32")` and fakes: they prove the logic, and the Windows VM proves Windows.
describe("the Task Scheduler tier (Windows)", () => {
  const WIN = hostFor("win32");
  const WIN_BINARY = binaryOn("win32");
  const RECORD = taskRecordPath(CONFIG, null, WIN);
  const TASK_FILE = taskFilePath(CONFIG, null, WIN);
  const OUR_LAUNCHER = `"C:${WIN_BINARY}" _supervise "COLLIE_PLUGIN_ROOT=C:${ROOT}"`;
  const OUR_BRIDGE = `"C:${WIN_BINARY}" _exec-bridge`;
  const OLD_LAUNCHER = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:${ROOT}\\contrib\\windows\\collie-ctl.ps1" -TaskConfigDir "C:\\cfg" _exec-bridge`;
  const OLD_BRIDGE = `C:\\Users\\pat\\.bun\\bin\\bun.exe run "${ROOT}/bridge/index.ts"`;
  const V2 = (launcher: number, bridge: number): string => formatTaskRecord(launcher, bridge);
  // What `Get-ScheduledTask` prints for a registered task: the state, the command, the arguments.
  // The query opens with the UTF-8 line (`POWERSHELL_UTF8`), so a non-ASCII path comes back whole.
  const QUERY = `powershell -NoProfile -NonInteractive -Command ${POWERSHELL_UTF8}$t = Get-ScheduledTask`;
  const CONHOST = "C:\\WINDOWS\\system32\\conhost.exe";
  const OUR_TASK_ARGS = `--headless ${WIN_BINARY} _supervise HERDR_SOCKET_PATH=\\\\.\\pipe\\herdr COLLIE_PORT=8787`;
  const OLD_TASK_ARGS = `--headless "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -File "${ROOT}\\contrib\\windows\\collie-ctl.ps1" -TaskConfigDir "C:\\cfg" _exec-bridge`;
  const taskAnswer = (args: string, state = "Running"): string => `${state}\r\n${CONHOST}\r\n${args}\r\n`;
  const WHOAMI: Scripted["answers"] = [
    ["whoami /groups", { stdout: "Mandatory Label\\Medium Mandatory Level Label S-1-16-8192\n" }],
    ["whoami", { stdout: "desk\\pat\r\n" }],
    [QUERY, { stdout: taskAnswer(OUR_TASK_ARGS) }],
  ];
  const windows = (over: HarnessOptions = {}): Harness =>
    harness({
      ...over,
      host: WIN,
      answers: [...(over.answers ?? []), ...WHOAMI],
      files: { [WIN_BINARY]: "", ...over.files },
    });
  const schtasks = (h: Harness): string[] => h.exec.calls.filter((c) => c.startsWith("schtasks"));

  describe("the tier", () => {
    test("Windows is Task Scheduler, and asks systemd nothing", () => {
      const exec = fakeExec();
      expect(supervisionTier(exec, WIN)).toBe("taskscheduler");
      expect(exec.calls.some((c) => c.startsWith("systemctl"))).toBe(false);
      expect(supervisionTier(fakeExec({ absent: ["schtasks"] }), WIN)).toBe("unsupervised");
      expect(supervisionTier(fakeExec(), WIN, { COLLIE_SUPERVISOR: "unsupervised" })).toBe("unsupervised");
      // Never chosen off Windows, and pinnable for a test like every other tier.
      expect(supervisionTier(fakeExec({ answers: NO_SYSTEMD }), hostFor("linux"))).toBe("unsupervised");
      expect(supervisionTier(fakeExec(), hostFor("linux"), { COLLIE_SUPERVISOR: "taskscheduler" })).toBe("taskscheduler");
    });
  });

  describe("start", () => {
    test("writes the task, registers it under herdr.collie, and runs it", async () => {
      let served = 0;
      const h = windows({
        serve: () => {
          served++;
          return Promise.resolve(EXIT.OK);
        },
      });
      expect(await cmdStart(h.deps)).toBe(EXIT.OK);
      expect(schtasks(h)).toEqual([
        `schtasks /Create /TN herdr.collie /XML ${TASK_FILE} /F`,
        "schtasks /Run /TN herdr.collie",
      ]);
      const xml = h.files.read(TASK_FILE) ?? "";
      expect(xml).toContain("<UserId>desk\\pat</UserId>");
      expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
      expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
      expect(xml).toContain("<Count>999</Count>");
      expect(xml).toContain("<Command>/fake/conhost</Command>");
      expect(xml).toContain(`<Arguments>--headless ${WIN_BINARY} _supervise HERDR_SOCKET_PATH=`);
      expect(xml).toContain(`HERDR_PLUGIN_CONFIG_DIR=${CONFIG}`);
      expect(xml).toContain(`<WorkingDirectory>${ROOT}</WorkingDirectory>`);
      expect(h.io.stdout).toContain("bridge started (Task Scheduler: herdr.collie)");
      // No unsupervised bridge beside the task, and no front door: Collie publishes none on Windows.
      expect(h.exec.spawned).toHaveLength(0);
      expect(served).toBe(0);
      expect(h.io.stdout.join("\n")).toContain("note: Collie publishes no front door here");
    });

    test("a path with a '%' is refused before the task is written: Task Scheduler would expand it", async () => {
      const h = windows();
      h.deps.ctx = { ...h.deps.ctx, configDir: "C:\\cfg%TEMP%x" };
      expect(await cmdStart(h.deps)).toBe(EXIT.FAIL);
      expect(schtasks(h)).toEqual([]);
      expect(h.files.exists(taskFilePath("C:\\cfg%TEMP%x", null, WIN))).toBe(false);
      expect(h.io.stderr.slice(-2)).toEqual([
        "error: Collie cannot start from C:\\cfg%TEMP%x, because that path has a % sign. Windows replaces %NAME% in a scheduled task's settings with the value of a variable, so the task would use the wrong path.",
        "       Move Collie, and its config folder, to a folder whose path has no % sign, for example C:\\collie. Then run: collie start",
      ]);
    });

    test("start waits for the bridge to answer, and fails loudly when none does", async () => {
      const up = windows();
      expect(await cmdStart(up.deps)).toBe(EXIT.OK);
      expect(up.readyCalls.length).toBeGreaterThan(0);

      const down = windows({ ready: false });
      down.deps.sleep = () => Promise.resolve();
      expect(await cmdStart(down.deps)).toBe(EXIT.FAIL);
      expect(schtasks(down)).toContain("schtasks /Run /TN herdr.collie");
      expect(down.io.stdout).not.toContain("bridge started (Task Scheduler: herdr.collie)");
      expect(down.io.stderr.join("\n")).toContain("error: Collie did not answer on 127.0.0.1:");
      expect(down.io.stderr.join("\n")).toContain("collie logs");
    });

    test("no secret from the environment reaches the task file", async () => {
      const h = windows({ env: { COLLIE_VAPID_PRIVATE: "s3cret-vapid", COLLIE_TRUSTED_USER: "pat@example.com" } });
      expect(await cmdStart(h.deps)).toBe(EXIT.OK);
      const xml = h.files.read(TASK_FILE) ?? "";
      expect(xml).not.toContain("s3cret-vapid");
      expect(xml).not.toContain("COLLIE_VAPID_PRIVATE");
      expect(xml).not.toContain("COLLIE_TRUSTED_USER");
    });

    test("prints one line that proves the switch to Task Scheduler", async () => {
      const h = windows();
      expect(await cmdStart(h.deps)).toBe(EXIT.OK);
      expect(h.io.stdout).toContain("Registered Task Scheduler job herdr.collie (starts at logon)");
    });

    test("refuses to take over a task that runs another install: one Collie per Windows machine", async () => {
      const h = windows({ answers: [[QUERY, { stdout: taskAnswer('--headless "D:\\other\\bin\\collie.exe" _supervise') }]] });
      expect(await cmdStart(h.deps)).toBe(EXIT.FAIL);
      expect(schtasks(h)).toEqual([]);
      expect(h.files.exists(TASK_FILE)).toBe(false);
      expect(h.io.stderr.join("\n")).toContain("runs D:\\other\\bin\\collie.exe, not this Collie");
      expect(h.io.stderr.join("\n")).toContain("run `collie uninstall` from that install first");
    });

    test("takes over its own task, the community script's task of this checkout, and no task at all", async () => {
      for (const answer of [taskAnswer(OUR_TASK_ARGS), taskAnswer(OLD_TASK_ARGS)]) {
        const h = windows({ answers: [[QUERY, { stdout: answer }]] });
        expect(await cmdStart(h.deps)).toBe(EXIT.OK);
      }
      expect(await cmdStart(windows({ answers: [[QUERY, { code: 1 }]] }).deps)).toBe(EXIT.OK);
    });

    // The hard gate from M43 spec 05 for spec 06: a binary install's task names the `current`
    // junction, so the launcher it runs survives every update and relaunches the version `current`
    // names. This process runs from a version folder; the task must not.
    test("a binary install registers the task on `current`, never on the version folder it runs from", async () => {
      const install = "C:\\Users\\pat\\.collie";
      const root = `${install}\\versions\\1.16.0`;
      const current = `${install}\\current`;
      const h = windows({
        answers: [[QUERY, { code: 1 }]],
        files: { [collieBinary(root, WIN)]: "" },
      });
      h.deps.ctx = { ...h.deps.ctx, root };
      h.deps.link = fakeLinkFs({ [current]: { kind: "symlink", target: root } });
      expect(await cmdStart(h.deps)).toBe(EXIT.OK);
      const xml = h.files.read(TASK_FILE) ?? "";
      expect(xml).toContain(`<Arguments>--headless ${current}\\bin\\collie.exe _supervise `);
      expect(xml).toContain(`COLLIE_PLUGIN_ROOT=${current}</Arguments>`);
      // The launcher runs in the install root, not in `current`: a process that runs in the junction
      // holds the version folder behind it, and no update could then remove that version.
      expect(xml).toContain(`<WorkingDirectory>${install}</WorkingDirectory>`);
      expect(xml).not.toContain("versions");

      // Registered again while that task runs: it is this install's own task, not another's.
      const again = windows({
        answers: [[QUERY, { stdout: taskAnswer(`--headless ${current}\\bin\\collie.exe _supervise`) }]],
        files: { [collieBinary(root, WIN)]: "" },
      });
      again.deps.ctx = { ...again.deps.ctx, root };
      again.deps.link = h.deps.link;
      expect(await cmdStart(again.deps)).toBe(EXIT.OK);
    });

    test("a checkout's task still runs its own `bin\\collie.exe`, with a link seam or without", async () => {
      const h = windows({ answers: [[QUERY, { code: 1 }]] });
      h.deps.link = fakeLinkFs();
      expect(await cmdStart(h.deps)).toBe(EXIT.OK);
      expect(h.files.read(TASK_FILE)).toContain(`<Arguments>--headless ${WIN_BINARY} _supervise `);
    });

    test("without conhost the task runs the launcher straight", async () => {
      const h = windows({ absent: ["conhost"] });
      expect(await cmdStart(h.deps)).toBe(EXIT.OK);
      expect(h.files.read(TASK_FILE)).toContain(`<Command>${WIN_BINARY}</Command>`);
    });

    test("a user without the batch logon right is told which right, where, and what to run after", async () => {
      // Measured on the VM for a fresh standard user: 0x80070569, ERROR_LOGON_TYPE_NOT_GRANTED.
      for (const said of [
        "ERROR: Logon failure: the user has not been granted the requested logon type at this computer.",
        "FEHLER: 0x80070569",
      ]) {
        const h = windows({ answers: [["schtasks /Create", { code: 1, stderr: said }]] });
        expect(await cmdStart(h.deps)).toBe(EXIT.FAIL);
        const err = h.io.stderr.join("\n");
        expect(err).toContain('lacks the right "Log on as a batch job"');
        expect(err).toContain("Local Security Policy > Local Policies > User Rights Assignment");
        expect(err).toContain("desk\\pat");
        expect(h.io.stderr.at(-1)).toContain("Then run: collie start");
      }
      // Any other refusal says nothing about the right.
      const other = windows({ answers: [["schtasks /Create", { code: 1, stderr: "ERROR: Access is denied." }]] });
      expect(await cmdStart(other.deps)).toBe(EXIT.FAIL);
      expect(other.io.stderr.join("\n")).not.toContain("batch job");
    });

    test("refuses to register a task pointing at a binary that isn't there", async () => {
      const h = windows();
      h.files.remove(WIN_BINARY);
      expect(await cmdStart(h.deps)).toBe(EXIT.FAIL);
      expect(schtasks(h)).toEqual([]);
      expect(h.io.stderr.join("\n")).toContain("no collie binary");
    });

    test("a refused registration fails start, and nothing is run", async () => {
      const h = windows({ answers: [["schtasks /Create", { code: 1, stderr: "ERROR: Access is denied." }]] });
      expect(await cmdStart(h.deps)).toBe(EXIT.FAIL);
      expect(schtasks(h)).toHaveLength(1);
      expect(h.io.stderr.join("\n")).toContain("Access is denied.");
      expect(h.io.stderr.join("\n")).toContain("schtasks /Create /TN herdr.collie failed");
    });

    test("COLLIE_TASK_RUN_LEVEL=highest registers an elevated task only from an elevated shell", async () => {
      const elevated = windows({
        env: { COLLIE_TASK_RUN_LEVEL: "highest" },
        answers: [["whoami /groups", { stdout: "Mandatory Label\\High Mandatory Level Label S-1-16-12288\n" }]],
      });
      expect(await cmdStart(elevated.deps)).toBe(EXIT.OK);
      expect(elevated.files.read(TASK_FILE)).toContain("<RunLevel>HighestAvailable</RunLevel>");

      const limited = windows({ env: { COLLIE_TASK_RUN_LEVEL: "highest" } });
      expect(await cmdStart(limited.deps)).toBe(EXIT.FAIL);
      expect(schtasks(limited)).toEqual([]);
      expect(limited.io.stderr.join("\n")).toContain("needs an elevated (Administrator) shell");

      // A privilege knob fails closed on a typo.
      const typo = windows({ env: { COLLIE_TASK_RUN_LEVEL: "hihgest" } });
      expect(await cmdStart(typo.deps)).toBe(EXIT.FAIL);
      expect(schtasks(typo)).toEqual([]);
      expect(typo.io.stderr.join("\n")).toContain("must be 'limited' or 'highest'");

      const explicit = windows({ env: { COLLIE_TASK_RUN_LEVEL: "Limited" } });
      expect(await cmdStart(explicit.deps)).toBe(EXIT.OK);
      expect(explicit.files.read(TASK_FILE)).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    });

    test("adopts the community script: same task name, its launcher and bridge replaced", async () => {
      const h = windows({
        files: { [RECORD]: "7100|7200" },
        ps: { 7100: OLD_LAUNCHER, 7200: OLD_BRIDGE },
      });
      expect(await cmdStart(h.deps)).toBe(EXIT.OK);
      // Registered over the old task (`/F`), never a second task beside it.
      expect(schtasks(h)).toEqual([
        `schtasks /Create /TN herdr.collie /XML ${TASK_FILE} /F`,
        "schtasks /End /TN herdr.collie",
        "schtasks /Run /TN herdr.collie",
      ]);
      // The launcher first, so it cannot relaunch the bridge in between.
      expect(h.exec.killed).toEqual([7100, 7200]);
      expect(h.files.exists(RECORD)).toBe(false);
      expect(h.io.stdout.join("\n")).toContain("replaced the contrib\\windows\\collie-ctl.ps1 launcher");
    });

    test("a community record left by a reboot is dropped quietly, and nothing is killed", async () => {
      const h = windows({ files: { [RECORD]: "1|5112" } });
      expect(await cmdStart(h.deps)).toBe(EXIT.OK);
      expect(h.exec.killed).toEqual([]);
      expect(h.files.exists(RECORD)).toBe(false);
      expect(h.io.stdout.join("\n")).not.toContain("replaced");
      expect(h.io.stdout).toContain("bridge started (Task Scheduler: herdr.collie)");
    });

    test("leaves a launcher of its own running: start is idempotent", async () => {
      const h = windows({ files: { [RECORD]: V2(7100, 7200) }, ps: { 7100: OUR_LAUNCHER, 7200: OUR_BRIDGE } });
      expect(await cmdStart(h.deps)).toBe(EXIT.OK);
      expect(h.exec.killed).toEqual([]);
      expect(schtasks(h)).toContain("schtasks /Run /TN herdr.collie");
      expect(h.files.exists(RECORD)).toBe(true);
    });

    test("releases the port from a bridge the unsupervised tier started before", async () => {
      const h = windows({
        files: { [`${CONFIG}/collie.pid`]: "4242\n" },
        ps: { 4242: `${WIN_BINARY} _exec-bridge` },
      });
      expect(await cmdStart(h.deps)).toBe(EXIT.OK);
      expect(h.exec.killed).toEqual([4242]);
    });

    test("a second instance gets its own task, record and launcher marker, and a warning", async () => {
      const h = windows({ instance: "v1" });
      expect(await cmdStart(h.deps)).toBe(EXIT.OK);
      expect(h.io.stderr.join("\n")).toContain("one Collie per Windows machine is supported; instance v1 gets its own task herdr.collie-v1");
      const file = taskFilePath(CONFIG, "v1", WIN);
      expect(schtasks(h)).toEqual([
        `schtasks /Create /TN herdr.collie-v1 /XML ${file} /F`,
        "schtasks /Run /TN herdr.collie-v1",
      ]);
      expect(h.files.read(file)).toContain("_supervise --instance v1 ");
    });
  });

  describe("stop", () => {
    test("disables the task first, which turns off its logon and five-minute triggers too", async () => {
      const h = windows();
      expect(await cmdStop(h.deps)).toBe(EXIT.OK);
      expect(schtasks(h)[0]).toBe("schtasks /Change /TN herdr.collie /DISABLE");
    });

    test("disables, ends, and kills the recorded launcher then bridge", async () => {
      const h = windows({ files: { [RECORD]: V2(7100, 7200) }, ps: { 7100: OUR_LAUNCHER, 7200: OUR_BRIDGE } });
      expect(await cmdStop(h.deps)).toBe(EXIT.OK);
      expect(schtasks(h)).toEqual(["schtasks /Change /TN herdr.collie /DISABLE", "schtasks /End /TN herdr.collie"]);
      expect(h.exec.killed).toEqual([7100, 7200]);
      expect(h.files.exists(RECORD)).toBe(false);
      expect(h.io.stdout).toContain("bridge stopped");
    });

    test("the order: disable, end, the launcher, then the bridge, then one sweep after a pause", async () => {
      const h = windows({ files: { [RECORD]: V2(7100, 7200) }, ps: { 7100: OUR_LAUNCHER, 7200: OUR_BRIDGE } });
      const timeline: string[] = [];
      const kill = h.exec.kill;
      h.exec.kill = (pid) => {
        timeline.push(`kill ${pid}`);
        kill(pid);
      };
      const realCapture = h.exec.capture;
      h.exec.capture = (tool, args, ...rest) => {
        if (tool === "schtasks") timeline.push(`schtasks ${args.join(" ")}`);
        return realCapture(tool, args, ...rest);
      };
      h.deps.sleep = (ms) => {
        timeline.push(`sleep ${ms}`);
        return Promise.resolve();
      };
      const list = h.exec.listProcesses;
      h.exec.listProcesses = (names, ms) => {
        timeline.push("list");
        return list(names, ms);
      };
      expect(await cmdStop(h.deps)).toBe(EXIT.OK);
      expect(timeline).toEqual([
        "schtasks /Change /TN herdr.collie /DISABLE",
        "schtasks /End /TN herdr.collie",
        "kill 7100",
        "kill 7200",
        `sleep ${STOP_SETTLE_MS}`,
        "list",
        // Something was killed, so the table is read once more: a refused kill must not read as stopped.
        `sleep ${STOP_SETTLE_MS}`,
        "list",
      ]);
      expect(h.exec.listed).toEqual([
        ["collie.exe", "bun.exe", "powershell.exe"],
        ["collie.exe", "bun.exe", "powershell.exe"],
      ]);
    });

    test("a launcher that wrote a fresh bridge pid between the read and the kill loses that bridge too", async () => {
      const ps: NonNullable<Scripted["ps"]> = { 7100: OUR_LAUNCHER };
      const h = windows({ files: { [RECORD]: V2(7100, 0) }, ps });
      const kill = h.exec.kill;
      h.exec.kill = (pid) => {
        // The race: the launcher had already spawned 7300 and written it down when it was killed.
        if (pid === 7100) {
          ps[7300] = OUR_BRIDGE;
          h.files.write(RECORD, V2(7100, 7300));
        }
        kill(pid);
      };
      expect(await cmdStop(h.deps)).toBe(EXIT.OK);
      expect(h.exec.killed).toEqual([7100, 7300]);
      expect(h.files.exists(RECORD)).toBe(false);
    });

    test("the sweep takes a launcher or bridge of this checkout that no record names, and nothing else", async () => {
      const h = windows({
        ps: {
          7400: OUR_BRIDGE,
          7500: OUR_LAUNCHER,
          7600: OLD_LAUNCHER,
          7700: OLD_BRIDGE,
          // Not ours: another checkout's bridge, this checkout's CLI, another instance's bridge.
          7800: '"D:\\other\\bin\\collie.exe" _exec-bridge',
          7900: `"C:${WIN_BINARY}" status`,
          8000: `"C:${WIN_BINARY}" _exec-bridge --instance v2`,
        },
      });
      expect(await cmdStop(h.deps)).toBe(EXIT.OK);
      // Launchers before bridges, so neither loop can relaunch what the sweep just took.
      expect(h.exec.killed).toEqual([7500, 7600, 7400, 7700]);
    });

    test("stops the community script's processes too", async () => {
      const h = windows({ files: { [RECORD]: "7100|7200" }, ps: { 7100: OLD_LAUNCHER, 7200: OLD_BRIDGE } });
      expect(await cmdStop(h.deps)).toBe(EXIT.OK);
      expect(h.exec.killed).toEqual([7100, 7200]);
    });

    test("never kills a recorded pid that is somebody else now, and still drops the record", async () => {
      const h = windows({
        files: { [RECORD]: V2(7100, 7200) },
        ps: { 7100: "C:\\Windows\\notepad.exe", 7200: 'bun.exe run "D:\\other\\bridge\\index.ts"' },
      });
      expect(await cmdStop(h.deps)).toBe(EXIT.OK);
      expect(h.exec.killed).toEqual([]);
      expect(h.files.exists(RECORD)).toBe(false);
    });

    test("an unreadable record is dropped with a warning, and stop still succeeds", async () => {
      const h = windows({ files: { [RECORD]: "not a record" } });
      expect(await cmdStop(h.deps)).toBe(EXIT.OK);
      expect(h.exec.killed).toEqual([]);
      expect(h.files.exists(RECORD)).toBe(false);
      expect(h.io.stderr.join("\n")).toContain("names no process");
    });

    describe("a process table that does not answer", () => {
      const unreadable = (h: { io: { stdout: string[]; stderr: string[] } }): void => {
        expect(h.io.stdout).not.toContain("bridge stopped");
        expect(h.io.stderr).toEqual([
          "error: Collie could not read the list of running programs on this PC (PowerShell did not answer within 60s).",
          "       The bridge may still be running. Collie did not change its record. Close it in Task Manager, then run `collie stop` again.",
        ]);
      };

      test("for the recorded launcher: nothing is killed, the record stays, and stop fails", async () => {
        const h = windows({ files: { [RECORD]: V2(7100, 7200) }, ps: { 7100: OUR_LAUNCHER, 7200: OUR_BRIDGE }, psUnknown: [7100] });
        expect(await cmdStop(h.deps)).toBe(EXIT.FAIL);
        expect(h.exec.killed).toEqual([]);
        expect(h.files.read(RECORD)).toBe(V2(7100, 7200));
        unreadable(h);
      });

      test("for the recorded bridge: the launcher is gone, the bridge was not seen, the record stays", async () => {
        const h = windows({ files: { [RECORD]: V2(7100, 7200) }, ps: { 7100: OUR_LAUNCHER, 7200: OUR_BRIDGE }, psUnknown: [7200] });
        expect(await cmdStop(h.deps)).toBe(EXIT.FAIL);
        expect(h.exec.killed).toEqual([7100]);
        expect(h.files.exists(RECORD)).toBe(true);
        unreadable(h);
      });

      test("for the final sweep: stop fails rather than call an unseen table empty", async () => {
        const h = windows({ files: { [RECORD]: V2(7100, 7200) }, ps: { 7100: OUR_LAUNCHER, 7200: OUR_BRIDGE }, listUnknown: true });
        expect(await cmdStop(h.deps)).toBe(EXIT.FAIL);
        expect(h.files.exists(RECORD)).toBe(true);
        expect(h.io.stdout).not.toContain("bridge stopped");
        expect(h.io.stderr[0]).toContain("(the process list did not answer)");
      });

      test("restart's stop + start and uninstall name the verb the operator ran", async () => {
        const restart = windows({ files: { [RECORD]: V2(7100, 7200) }, ps: { 7100: OUR_LAUNCHER, 7200: OUR_BRIDGE }, listUnknown: true });
        // A dead launcher sends restart to stop + start.
        restart.exec.processLookup = (pid) => (pid === 7100 ? { kind: "gone" } : { kind: "running", command: OUR_BRIDGE });
        expect(await cmdRestart(restart.deps)).toBe(EXIT.FAIL);
        expect(restart.io.stderr.at(-1)).toContain("then run `collie restart` again.");
        const uninstall = windows({ files: { [RECORD]: V2(7100, 7200) }, ps: { 7100: OUR_LAUNCHER }, psUnknown: [7100] });
        expect(await cmdUninstall(uninstall.deps)).toBe(EXIT.FAIL);
        expect(uninstall.io.stderr.at(-1)).toContain("then run `collie uninstall` again.");
      });

      test("uninstall stops there too, and removes no task", async () => {
        const h = windows({ files: { [RECORD]: V2(7100, 7200) }, ps: { 7100: OUR_LAUNCHER }, psUnknown: [7100] });
        expect(await cmdUninstall(h.deps)).toBe(EXIT.FAIL);
        expect(schtasks(h)).not.toContain("schtasks /Delete /TN herdr.collie /F");
        expect(h.files.exists(RECORD)).toBe(true);
      });
    });

    test("a launcher or bridge that survives its kill fails stop, names it, and keeps the record", async () => {
      const h = windows({ files: { [RECORD]: V2(7100, 7200) }, ps: { 7100: OUR_LAUNCHER, 7200: OUR_BRIDGE }, unkillable: [7200] });
      expect(await cmdStop(h.deps)).toBe(EXIT.FAIL);
      expect(h.io.stdout).not.toContain("bridge stopped");
      expect(h.io.stderr).toEqual([
        "error: Windows did not let Collie stop collie.exe (pid 7200). It may run as another account or as administrator.",
        "       The bridge may still be running. Collie did not change its record. Close it in Task Manager, then run `collie stop` again.",
      ]);
      expect(h.files.read(RECORD)).toBe(V2(7100, 7200));
    });

    test("nothing to kill: no second look at the table", async () => {
      const h = windows();
      expect(await cmdStop(h.deps)).toBe(EXIT.OK);
      expect(h.exec.listed).toHaveLength(1);
    });

    test("a stale launcher record (the script's `$PID|0`) is cleared", async () => {
      const h = windows({ files: { [RECORD]: "7100|0" } });
      expect(await cmdStop(h.deps)).toBe(EXIT.OK);
      expect(h.exec.killed).toEqual([]);
      expect(h.files.exists(RECORD)).toBe(false);
    });
  });

  describe("uninstall", () => {
    test("stops, deletes the task and its file and record, and exits 0", async () => {
      const h = windows({
        files: { [RECORD]: V2(7100, 7200), [TASK_FILE]: "<Task/>" },
        ps: { 7100: OUR_LAUNCHER, 7200: OUR_BRIDGE },
      });
      expect(await cmdUninstall(h.deps)).toBe(EXIT.OK);
      expect(schtasks(h)).toEqual([
        "schtasks /Change /TN herdr.collie /DISABLE",
        "schtasks /End /TN herdr.collie",
        "schtasks /Delete /TN herdr.collie /F",
      ]);
      expect(h.files.exists(TASK_FILE)).toBe(false);
      expect(h.files.exists(RECORD)).toBe(false);
      expect(h.io.stdout.join("\n")).toContain("✓ uninstalled");
    });

    test("a binary install prints how to remove its folder and its PATH entry; a checkout does not", async () => {
      const install = "C:\\Users\\o'neil\\AppData\\Local\\collie";
      const root = `${install}\\versions\\1.16.0`;
      const h = windows({ answers: [["schtasks", { code: 1, stderr: "ERROR: The system cannot find the file specified." }]] });
      h.deps.ctx = { ...h.deps.ctx, root };
      h.deps.link = fakeLinkFs({ [`${install}\\current`]: { kind: "symlink", target: root } });
      expect(await cmdUninstall(h.deps)).toBe(EXIT.OK);
      expect(h.io.stdout.slice(-3)).toEqual([
        "  To remove Collie itself too, run these two lines in PowerShell:",
        `    cmd /c rmdir /s /q "${install}"`,
        "    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true); $k.SetValue('Path', (($k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') -split ';' | Where-Object { $_.TrimEnd('\\') -ne 'C:\\Users\\o''neil\\AppData\\Local\\collie\\current\\bin' }) -join ';'), $k.GetValueKind('Path')); $k.Close()",
      ]);

      const checkout = windows({ answers: [["schtasks", { code: 1, stderr: "ERROR: The system cannot find the file specified." }]] });
      checkout.deps.link = fakeLinkFs();
      expect(await cmdUninstall(checkout.deps)).toBe(EXIT.OK);
      expect(checkout.io.stdout.join("\n")).not.toContain("rmdir");
    });

    test("an install that never registered a task still uninstalls cleanly", async () => {
      const h = windows({ answers: [["schtasks", { code: 1, stderr: "ERROR: The system cannot find the file specified." }]] });
      expect(await cmdUninstall(h.deps)).toBe(EXIT.OK);
    });
  });

  describe("restart", () => {
    const running = (over: HarnessOptions = {}): Harness =>
      windows({
        ...over,
        files: { [RECORD]: V2(7100, 7200), ...over.files },
        ps: { 7100: OUR_LAUNCHER, 7200: OUR_BRIDGE, ...over.ps },
      });

    test("kills the recorded bridge and nothing else, then leaves the relaunch to the launcher", async () => {
      const h = running();
      expect(await cmdRestart(h.deps)).toBe(EXIT.OK);
      // The bridge only: the launcher (7100) is the loop that brings it back.
      expect(h.exec.killed).toEqual([7200]);
      // The restart can wait out a slow PowerShell start, for both pids, and for the look after the kill.
      expect(h.exec.probed).toEqual([
        { pid: 7100, timeoutMs: PROCESS_QUERY_SLOW_START_MS },
        { pid: 7200, timeoutMs: PROCESS_QUERY_SLOW_START_MS },
        { pid: 7200, timeoutMs: PROCESS_QUERY_SLOW_START_MS },
      ]);
      // No second bridge, no task touched: ending the task could take the phone's update with it.
      expect(h.exec.spawned).toHaveLength(0);
      expect(schtasks(h)).toEqual([]);
      expect(h.io.stdout.join("\n")).toContain("the Task Scheduler supervisor relaunches it");
      expect(h.files.exists(RECORD)).toBe(true);
    });

    test("a kill Windows refused fails the restart in plain words, and the launcher is not told", async () => {
      const h = running({ unkillable: [7200] });
      let probes = 0;
      h.deps.ready = () => {
        probes++;
        return Promise.resolve(true);
      };
      expect(await cmdRestart(h.deps)).toBe(EXIT.FAIL);
      expect(h.exec.killed).toEqual([7200]);
      expect(h.io.stderr).toEqual([
        "error: Windows did not let Collie stop the old bridge, collie.exe (pid 7200). It may run as another account or as administrator.",
        "       Close collie.exe (pid 7200) in Task Manager, then run `collie restart` again.",
      ]);
      expect(h.io.stdout.join("\n")).not.toContain("bridge stopped");
      // The old bridge would have answered the health wait as if it were the new one.
      expect(probes).toBe(0);
      expect(h.files.exists(taskRestartPath(CONFIG, null, WIN))).toBe(false);
    });

    test("a table that does not answer after the kill is no news: the wait for the new bridge goes on", async () => {
      const h = running();
      const lookup = h.exec.processLookup.bind(h.exec);
      let n = 0;
      h.exec.processLookup = (pid, ms) => (++n === 3 ? { kind: "unknown", why: "slow" } : lookup(pid, ms));
      expect(await cmdRestart(h.deps)).toBe(EXIT.OK);
      expect(h.io.stdout.join("\n")).toContain("bridge stopped (pid 7200)");
    });

    test("tells the launcher first, so the killed bridge is not taken for a crash", async () => {
      const h = running();
      const marker = taskRestartPath(CONFIG, null, WIN);
      const before = Date.now();
      // Written BEFORE the kill: the launcher reads it the moment its bridge exits.
      const seenAtKill: boolean[] = [];
      const kill = h.exec.kill.bind(h.exec);
      h.exec.kill = (pid) => {
        seenAtKill.push(h.files.exists(marker));
        return kill(pid);
      };
      expect(await cmdRestart(h.deps)).toBe(EXIT.OK);
      expect(seenAtKill).toEqual([true]);
      const at = Number((h.files.read(marker) ?? "").trim());
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeLessThanOrEqual(Date.now());
    });

    test("over the community script: registers the task again and restarts its bridge alone", async () => {
      const h = windows({ files: { [RECORD]: "7100|7200" }, ps: { 7100: OLD_LAUNCHER, 7200: OLD_BRIDGE } });
      expect(await cmdRestart(h.deps)).toBe(EXIT.OK);
      // The next logon runs Collie's launcher, not a script this release deleted.
      expect(schtasks(h)).toEqual([`schtasks /Create /TN herdr.collie /XML ${TASK_FILE} /F`]);
      expect(h.exec.killed).toEqual([7200]);
      expect(h.io.stdout.join("\n")).toContain("from the next logon");
    });

    test("recognises a `collie.exe` install's bridge and a source checkout's bun bridge", async () => {
      for (const bridge of [OUR_BRIDGE, OLD_BRIDGE, `bun.exe run "${ROOT.toUpperCase()}\\BRIDGE\\index.ts"`]) {
        const h = running({ ps: { 7200: bridge } });
        expect(await cmdRestart(h.deps)).toBe(EXIT.OK);
        expect(h.exec.killed).toEqual([7200]);
      }
    });

    test("never kills a recorded bridge that is no longer this checkout's", async () => {
      const strangers: Record<number, string>[] = [
        { 7200: "C:\\Windows\\notepad.exe" },
        { 7200: 'bun.exe run "D:\\other\\bridge\\index.ts"' },
        { 7200: `"C:${WIN_BINARY}" _exec-bridge --instance v2` },
      ];
      for (const ps of strangers) {
        const h = running({ ps });
        expect(await cmdRestart(h.deps)).toBe(EXIT.FAIL);
        expect(h.exec.killed).toEqual([]);
        expect(h.exec.spawned).toHaveLength(0);
        expect(h.io.stderr.join("\n")).toContain("not this checkout's bridge");
      }
    });

    test("a bridge the loop is already relaunching is left to it", async () => {
      const h = running({ files: { [RECORD]: V2(7100, 0) } });
      expect(await cmdRestart(h.deps)).toBe(EXIT.OK);
      expect(h.exec.killed).toEqual([]);
      expect(schtasks(h)).toEqual([]);
      // The marker still goes down, so a launcher in a long pause relaunches now.
      expect(h.files.exists(taskRestartPath(CONFIG, null, WIN))).toBe(true);
    });

    test("a recorded bridge that has exited already is not a stranger: no kill, the marker, the wait", async () => {
      const h = windows({ files: { [RECORD]: V2(7100, 7200) }, ps: { 7100: OUR_LAUNCHER } });
      expect(await cmdRestart(h.deps)).toBe(EXIT.OK);
      expect(h.exec.killed).toEqual([]);
      expect(h.files.exists(taskRestartPath(CONFIG, null, WIN))).toBe(true);
      expect(h.io.stdout.join("\n")).toContain("the recorded bridge (pid 7200) has exited already");
      expect(h.io.stderr.join("\n")).not.toContain("not this checkout's bridge");
    });

    test("a process table that does not answer stops nothing, and says so in its own words", async () => {
      // The launcher's query, then the bridge's: either one unanswered is the same refusal.
      for (const psUnknown of [[7100], [7200]]) {
        const h = running({ psUnknown });
        expect(await cmdRestart(h.deps)).toBe(EXIT.FAIL);
        expect(h.exec.killed).toEqual([]);
        expect(schtasks(h)).toEqual([]);
        expect(h.files.exists(taskRestartPath(CONFIG, null, WIN))).toBe(false);
        const said = h.io.stderr.join("\n");
        expect(said).toContain("could not read the Windows process table (PowerShell did not answer within 60s); nothing was stopped");
        // Not the stranger's sentence, and not the wait's.
        expect(said).not.toContain("not this checkout's bridge");
        expect(said).not.toContain("did not answer on");
      }
    });

    test("the first probe comes only after the killed bridge had a second to go", async () => {
      const h = running();
      const order: string[] = [];
      const kill = h.exec.kill.bind(h.exec);
      h.exec.kill = (pid) => {
        order.push(`kill ${pid}`);
        kill(pid);
      };
      h.deps.sleep = (ms) => {
        order.push(`sleep ${ms}`);
        return Promise.resolve();
      };
      h.deps.ready = () => {
        order.push("probe");
        return Promise.resolve(true);
      };
      expect(await cmdRestart(h.deps)).toBe(EXIT.OK);
      expect(order.slice(0, 3)).toEqual(["kill 7200", `sleep ${KILL_SETTLE_MS}`, "probe"]);
    });

    test("a stale record and a live bridge: the bridge goes only with a `start` right behind it", async () => {
      // The launcher died (a recycled pid now), so nothing would relaunch a bridge killed on its own.
      const h = windows({
        files: { [RECORD]: V2(7100, 7200) },
        ps: { 7100: "C:\\Windows\\notepad.exe", 7200: OUR_BRIDGE },
      });
      const order: string[] = [];
      const kill = h.exec.kill.bind(h.exec);
      h.exec.kill = (pid) => {
        order.push(`kill ${pid}`);
        kill(pid);
      };
      const ask = h.exec.capture.bind(h.exec);
      h.exec.capture = (tool, args, ...rest) => {
        if (tool === "schtasks") order.push(`schtasks ${args[0]}`);
        return ask(tool, args, ...rest);
      };
      expect(await cmdRestart(h.deps)).toBe(EXIT.OK);
      expect(order).toEqual(["schtasks /Change", "schtasks /End", "kill 7200", "schtasks /Create", "schtasks /Run"]);
      expect(h.exec.killed).not.toContain(7100);
    });

    test("a torn or foreign record is no record: restart takes stop + start and kills by the table only", async () => {
      for (const torn of ["not a record", "", "version=2 launcher=71", "version=3 launcher=7100 bridge=7200"]) {
        const h = windows({ files: { [RECORD]: torn }, ps: { 7200: '"D:\\other\\bin\\collie.exe" _exec-bridge' } });
        expect(await cmdRestart(h.deps)).toBe(EXIT.OK);
        expect(h.exec.killed).toEqual([]);
        expect(schtasks(h)).toContain("schtasks /Run /TN herdr.collie");
        expect(h.io.stderr.join("\n")).toContain("names no process");
      }
    });

    test("with no live launcher, restart is stop + start: the task comes back, never an unsupervised bridge", async () => {
      // No record at all (a fresh host), a record whose launcher died (a reboot before logon),
      // and a recycled launcher pid.
      const cases: HarnessOptions[] = [
        {},
        { files: { [RECORD]: V2(7100, 0) } },
        { files: { [RECORD]: V2(7100, 7200) }, ps: { 7100: "C:\\Windows\\notepad.exe", 7200: OUR_BRIDGE } },
      ];
      for (const over of cases) {
        const h = windows(over);
        expect(await cmdRestart(h.deps)).toBe(EXIT.OK);
        expect(h.exec.spawned).toHaveLength(0);
        expect(schtasks(h)).toEqual([
          "schtasks /Change /TN herdr.collie /DISABLE",
          "schtasks /End /TN herdr.collie",
          `schtasks /Create /TN herdr.collie /XML ${TASK_FILE} /F`,
          "schtasks /Run /TN herdr.collie",
        ]);
        expect(h.io.stdout).toContain("bridge started (Task Scheduler: herdr.collie)");
      }
    });

    test("waits for the relaunched bridge before it reports", async () => {
      const h = running();
      let probes = 0;
      h.deps.ready = () => Promise.resolve(++probes >= 4);
      expect(await cmdRestart(h.deps)).toBe(EXIT.OK);
      // Three misses, then the answer; the banner's own probe comes after.
      expect(probes).toBeGreaterThanOrEqual(4);
    });

    // The in-place update stops on this code, so a dead bridge must not read as `✓ update complete`.
    // The detached runner ignores it and polls its own gate (pinned in cli/update.test.ts).
    test("a relaunched bridge that never answers is a failure, after the whole wait", async () => {
      const h = running({ ready: false });
      let slept = 0;
      h.deps.sleep = () => {
        slept++;
        return Promise.resolve();
      };
      expect(await cmdRestart(h.deps)).toBe(EXIT.FAIL);
      expect(h.exec.killed).toEqual([7200]);
      expect(slept).toBe(30);
      expect(h.io.stderr.join("\n")).toContain("did not answer on 127.0.0.1:8787 within 30s; it may still be starting");
      expect(h.io.stderr.join("\n")).toContain("`collie status`");
      expect(h.io.stderr.at(-1)).toContain("collie logs");
      expect(h.exec.spawned).toHaveLength(0);
    });

    test("the wait follows COLLIE_UPDATE_HEALTH_TIMEOUT_MS, the update gate's own budget", async () => {
      const h = running({ env: { COLLIE_UPDATE_HEALTH_TIMEOUT_MS: "3000" }, ready: false });
      let slept = 0;
      h.deps.sleep = () => {
        slept++;
        return Promise.resolve();
      };
      expect(await cmdRestart(h.deps)).toBe(EXIT.FAIL);
      expect(slept).toBe(3);
      expect(h.io.stderr.join("\n")).toContain("within 3s");

      // A slow bridge that answers inside the raised budget is a success, and the wait stops there.
      const late = running({ env: { COLLIE_UPDATE_HEALTH_TIMEOUT_MS: "60000" } });
      let probes = 0;
      late.deps.ready = () => Promise.resolve(++probes >= 35);
      expect(await cmdRestart(late.deps)).toBe(EXIT.OK);
      expect(probes).toBeGreaterThanOrEqual(35);
    });

    test("the wait is bounded by the clock too: a slow probe does not stretch 30 s into minutes", async () => {
      // One real `ready` probe polls for about five seconds before it says no.
      const h = running({ ready: false });
      let clock = 1_000_000;
      let probes = 0;
      h.deps.now = () => clock;
      h.deps.sleep = (ms) => {
        clock += ms;
        return Promise.resolve();
      };
      h.deps.ready = () => {
        probes++;
        clock += 5_000;
        return Promise.resolve(false);
      };
      expect(await cmdRestart(h.deps)).toBe(EXIT.FAIL);
      // 1 s after the kill, then 6 s a round: the wait stops once 30 s have passed, not after 30 rounds.
      expect(clock - 1_000_000).toBeLessThanOrEqual(30_000 + 6_000 + 5_000);
      expect(probes).toBeLessThanOrEqual(7);
      expect(h.io.stderr.join("\n")).toContain("within 30s");
    });

    test("a probe that never answers is cut off at the budget: the worst case is the budget", async () => {
      // A 2 s budget, the first second spent after the kill: the one probe left gets one second.
      const h = running({ env: { COLLIE_UPDATE_HEALTH_TIMEOUT_MS: "2000" } });
      let calls = 0;
      h.deps.ready = () => (++calls === 1 ? new Promise<boolean>(() => {}) : Promise.resolve(false));
      const started = performance.now();
      expect(await cmdRestart(h.deps)).toBe(EXIT.FAIL);
      expect(performance.now() - started).toBeLessThan(1_800);
      expect(h.io.stderr.join("\n")).toContain("within 2s");
    });

    test("the default clock is performance.now, which a change of the wall clock does not move", async () => {
      const h = running({ ready: false });
      let slept = 0;
      h.deps.sleep = () => {
        slept++;
        return Promise.resolve();
      };
      const real = performance.now.bind(performance);
      let calls = 0;
      // The monotonic clock passes the whole budget after the first probe; only it can end the wait early.
      performance.now = () => real() + (++calls > 1 ? 60_000 : 0);
      try {
        expect(await cmdRestart(h.deps)).toBe(EXIT.FAIL);
      } finally {
        performance.now = real;
      }
      // The second after the kill, then no further pause: the deadline had passed.
      expect(slept).toBe(1);
    });

    test("a probe that throws reads as no answer, not as a crashed restart", async () => {
      const h = running();
      let probes = 0;
      // Every probe of the wait throws: 29 of them, because the first second is the pause after the
      // kill. The banner's own probe after the wait answers no.
      h.deps.ready = () => {
        if (++probes <= 29) throw new Error("connect refused");
        return Promise.resolve(false);
      };
      expect(await cmdRestart(h.deps)).toBe(EXIT.FAIL);
      expect(h.io.stderr.join("\n")).toContain("did not answer");
    });

    test("off Windows the record means nothing, and restart is untouched", async () => {
      const h = harness({
        answers: NO_SYSTEMD,
        files: { [RECORD]: "7100|7200" },
        ps: { 7100: OLD_LAUNCHER, 7200: OLD_BRIDGE },
      });
      expect(await cmdRestart(h.deps)).toBe(EXIT.OK);
      expect(h.exec.killed).toEqual([]);
      expect(h.exec.spawned).toHaveLength(1);
    });
  });

  describe("status", () => {
    test("names the task, its state, and Collie's launcher as a supervised service", async () => {
      const h = windows();
      expect(serviceDescription(h.deps)).toBe("Task Scheduler (herdr.collie) · Running · launcher: Collie's");
      const banner = (await statusBanner(h.deps)).join("\n");
      expect(banner).toContain("service   Task Scheduler (herdr.collie) · Running · launcher: Collie's");
      expect(banner).not.toContain("not supervised");
    });

    test("an unregistered task, the old loop still running, and a task that still runs the old script", () => {
      const none = windows({ answers: [[QUERY, { code: 1 }]] });
      expect(serviceDescription(none.deps)).toBe("Task Scheduler (herdr.collie) · not registered");
      const loop = windows({ files: { [RECORD]: "7100|7200" } });
      expect(serviceDescription(loop.deps)).toBe(
        "Task Scheduler (herdr.collie) · Running · launcher: the legacy collie-ctl.ps1 loop, until `collie start`",
      );
      const old = windows({ answers: [[QUERY, { stdout: taskAnswer(OLD_TASK_ARGS, "Ready") }]] });
      expect(serviceDescription(old.deps)).toBe(
        "Task Scheduler (herdr.collie) · Ready · Task herdr.collie still runs the old script. Run: collie restart",
      );
      const other = windows({ answers: [[QUERY, { stdout: taskAnswer('--headless "D:\\other\\bin\\collie.exe" _supervise') }]] });
      expect(serviceDescription(other.deps)).toBe("Task Scheduler (herdr.collie) · Running · runs another install: D:\\other\\bin\\collie.exe");
    });

    test("logs reads the log file the launcher appends to", () => {
      const h = windows({ files: { [`${CONFIG}/collie.log`]: "one\ntwo\nthree\n" } });
      expect(cmdLogs(h.deps, ["2"])).toBe(EXIT.OK);
      expect(h.io.stdout).toEqual(["two", "three"]);
      expect(h.exec.calls.some((c) => c.startsWith("journalctl"))).toBe(false);
    });
  });
});

describe("stop", () => {
  test("systemd: disable --now, so it stays down across a login", async () => {
    const h = harness();
    expect(await cmdStop(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls).toContain("systemctl --user disable --now collie");
    expect(h.io.stdout).toContain("bridge stopped");
  });

  test("launchd: disable AND bootout — together they are `disable --now`", async () => {
    const h = harness({ host: hostFor("darwin"), answers: NO_SYSTEMD });
    expect(await cmdStop(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls).toContain("launchctl disable gui/501/herdr.collie");
    expect(h.exec.calls).toContain("launchctl bootout gui/501/herdr.collie");
  });

  test("unsupervised: the pidfile process, and nothing else", async () => {
    const h = harness({
      answers: NO_SYSTEMD,
      files: { [`${CONFIG}/collie.pid`]: "4242\n" },
      ps: { 4242: `${BINARY} _exec-bridge` },
    });
    expect(await cmdStop(h.deps)).toBe(EXIT.OK);
    expect(h.exec.killed).toEqual([4242]);
  });
});

describe("the status banner", () => {
  test("says running, or names the port it isn't answering on", async () => {
    expect((await statusBanner(harness({ ready: true }).deps)).join("\n")).toContain(
      "✓ Collie is running",
    );
    const cold = (await statusBanner(harness({ ready: false }).deps)).join("\n");
    expect(cold).toContain("⚠ Collie isn't answering on :8787 yet");
    expect(cold).toContain("check 'collie logs'");
  });

  test("probes loopback by default — the bridge's own resolved bind (bridge/config.ts)", async () => {
    const h = harness({ ready: true });
    await statusBanner(h.deps);
    expect(h.readyCalls).toEqual([{ port: 8787, host: "127.0.0.1" }]);
  });

  test("COLLIE_HOST set: probes that address, not loopback, and names it in the warning", async () => {
    const h = harness({ ready: true, env: { COLLIE_HOST: "100.64.0.8" } });
    await statusBanner(h.deps);
    expect(h.readyCalls).toEqual([{ port: 8787, host: "100.64.0.8" }]);

    const cold = harness({ ready: false, env: { COLLIE_HOST: "100.64.0.8" } });
    const lines = (await statusBanner(cold.deps)).join("\n");
    expect(cold.readyCalls).toEqual([{ port: 8787, host: "100.64.0.8" }]);
    expect(lines).toContain("⚠ Collie isn't answering on 100.64.0.8:8787 yet");
  });

  // F13: the probe already resolved the bind; the `local` row two lines under it did not, so a peer
  // bound to its tailnet address was reported UP with a loopback URL that refuses to connect.
  test("the `local` row is the bind, and the two halves of the banner agree", async () => {
    const solo = (await statusBanner(harness({ ready: true }).deps)).join("\n");
    expect(solo).toContain("local     http://127.0.0.1:8787");

    const moved = harness({ ready: false, env: { COLLIE_HOST: "192.168.77.1" } });
    const lines = (await statusBanner(moved.deps)).join("\n");
    expect(lines).toContain("local     http://192.168.77.1:8787");
    expect(lines).toContain("isn't answering on 192.168.77.1:8787");
    // Not "no 127.0.0.1 anywhere": the `tailnet` row's no-name fallback names loopback on purpose,
    // and says why on the same line. The `local` row is the one that claimed it silently.
    expect(lines).not.toContain("local     http://127.0.0.1");
  });

  // F22's other half: one resolution behind the probe and the `local` row. A wildcard bind means
  // EVERY interface, so loopback is one of the addresses it answers on and the only one this machine
  // can promise reaches itself — probing the literal `0.0.0.0` is a dial nobody asked for.
  test("a WILDCARD bind is probed on loopback, and the banner says so once", async () => {
    const h = harness({ ready: true, env: { COLLIE_HOST: "0.0.0.0" } });
    const lines = (await statusBanner(h.deps)).join("\n");
    expect(h.readyCalls).toEqual([{ port: 8787, host: "127.0.0.1" }]);
    expect(lines).toContain("local     http://127.0.0.1:8787");

    const cold = harness({ ready: false, env: { COLLIE_HOST: "" } });
    expect((await statusBanner(cold.deps)).join("\n")).toContain("⚠ Collie isn't answering on :8787 yet");
    expect(cold.readyCalls).toEqual([{ port: 8787, host: "127.0.0.1" }]);
  });

  // F24: the banner's other half of the same finding. A peer publishes no front door (ADR 0013), so
  // a `tailnet` row was a row about a door that is not there — and the URL it offered was loopback,
  // which on a peer is not the bind either. The crew row answers the question the tailnet row was
  // asked: where DO I point my phone.
  test("a peer's banner names the crew, not a tailnet door it does not serve", async () => {
    const h = harness({
      ready: true,
      env: { COLLIE_HOST: "192.168.77.2" },
      files: { [`${STATE}/crew-trust.json`]: serializeTrustStore(peerStore()) },
    });
    const lines = (await statusBanner(h.deps)).join("\n");
    expect(lines).toContain("local     http://192.168.77.2:8787");
    expect(lines).toContain("crew      peer — no front door here");
    expect(lines).not.toContain("tailnet");
  });

  test("a LEAD, and a solo collie, keep the tailnet row exactly as it was", async () => {
    const lead = harness({
      ready: true,
      files: { [`${STATE}/crew-trust.json`]: serializeTrustStore(leadStore({ peers: [member({ memberId: "nas" })] })) },
    });
    expect((await statusBanner(lead.deps)).join("\n")).toContain("tailnet");
    expect((await statusBanner(harness({ ready: true }).deps)).join("\n")).toContain("tailnet");
  });

  test("reads the unit's state, not merely that a unit exists", () => {
    const h = harness({ answers: [["systemctl --user is-active", { stdout: "active\n" }]] });
    expect(serviceDescription(h.deps)).toBe("systemd --user (collie) · active");
  });

  test("the launchd line covers loaded, loaded-but-stopped, absent, and the fallback", () => {
    const darwin = (answers: Scripted["answers"], files?: Record<string, string>): LifecycleDeps =>
      harness({ host: hostFor("darwin"), answers: [...NO_SYSTEMD, ...(answers ?? [])], files }).deps;

    expect(
      serviceDescription(
        darwin([["launchctl print gui/501/herdr.collie", { stdout: "\tstate = running\n\tpid = 4242\n" }]]),
      ),
    ).toBe("launchd (gui/501/herdr.collie) · active (pid 4242)");
    expect(
      serviceDescription(darwin([["launchctl print gui/501/herdr.collie", { stdout: "\tstate = waiting\n" }]])),
    ).toBe("launchd (gui/501/herdr.collie) · loaded, not running");
    expect(serviceDescription(darwin([["launchctl print", { code: 1 }]]))).toBe(
      "launchd (herdr.collie) · not loaded",
    );
    // Not loaded, but a pidfile: bootstrap was refused and a bridge IS serving. Saying "not loaded"
    // there reads as "nothing is up" while the phone is being answered.
    expect(
      serviceDescription(
        darwin([["launchctl print", { code: 1 }]], { [`${CONFIG}/collie.pid`]: "4242\n" }),
      ),
    ).toBe("pid 4242 (unsupervised — launchd bootstrap refused)");
  });

  test.each([
    ["active (pid 4242)", "\tstate = running\n\tpid = 4242\n"],
    ["loaded, not running", "\tstate = waiting\n"],
  ])("discovers background user agents: %s", (state, stdout) => {
    const h = harness({
      host: hostFor("darwin"),
      answers: [
        ...NO_SYSTEMD,
        ["launchctl print gui/501/herdr.collie", { code: 1 }],
        ["launchctl print user/501/herdr.collie", { stdout }],
      ],
      // An old fallback pidfile must not hide the now-supervised agent.
      files: { [`${CONFIG}/collie.pid`]: "9999\n" },
    });
    expect(serviceDescription(h.deps)).toBe(`launchd (user/501/herdr.collie) · ${state}`);
  });

  test("reports both domains instead of hiding a running user agent behind a stopped GUI agent", () => {
    const h = harness({
      host: hostFor("darwin"),
      answers: [
        ...NO_SYSTEMD,
        ["launchctl print gui/501/herdr.collie", { stdout: "\tstate = waiting\n" }],
        ["launchctl print user/501/herdr.collie", { stdout: "\tpid = 4242\n" }],
      ],
    });
    expect(serviceDescription(h.deps)).toBe(
      "launchd (gui/501/herdr.collie) · loaded, not running; " +
      "launchd (user/501/herdr.collie) · active (pid 4242)",
    );
  });

  test("does not treat failed launchctl output as a loaded service", () => {
    const h = harness({
      host: hostFor("darwin"),
      answers: [
        ...NO_SYSTEMD,
        ["launchctl print gui/501/herdr.collie", { code: 1, stdout: "\tpid = 9999\n" }],
        ["launchctl print user/501/herdr.collie", { stdout: "\tpid = 4242\n" }],
      ],
    });
    expect(serviceDescription(h.deps)).toBe("launchd (user/501/herdr.collie) · active (pid 4242)");
  });

  test("status of a Home Manager agent is read-only and targets only the selected instance", async () => {
    const plist = `${HOME}/Library/LaunchAgents/herdr.collie-next.plist`;
    const h = harness({
      instance: "next",
      host: hostFor("darwin"),
      env: { COLLIE_SKIP_SERVE: "1" },
      answers: [
        ...NO_SYSTEMD,
        ["launchctl print gui/501/herdr.collie-next", { code: 1 }],
        ["launchctl print user/501/herdr.collie-next", { stdout: "\tpid = 4242\n" }],
      ],
      files: { [plist]: "Home Manager owns this agent" },
    });
    h.files.readOnly.add(plist);
    const before = new Map(h.files.entries);
    expect(await cmdStatus(h.deps)).toBe(EXIT.OK);
    expect(h.io.stdout.join("\n")).toContain("launchd (user/501/herdr.collie-next) · active (pid 4242)");
    expect(h.exec.calls.filter((call) => call.startsWith("launchctl "))).toEqual([
      "launchctl print gui/501/herdr.collie-next",
      "launchctl print user/501/herdr.collie-next",
    ]);
    expect(h.files.entries).toEqual(before);
    expect(h.files.ops).toEqual([]);
    expect(h.exec.killed).toEqual([]);
    expect(h.exec.spawned).toEqual([]);
  });

  test("prints the tailnet URL, or the proxy line under COLLIE_SKIP_SERVE", async () => {
    const tailnet = harness({
      answers: [["tailscale status --json", { stdout: '{"Self":{"DNSName":"host.example."},"CertDomains":["host.example"]}' }]],
    });
    expect((await statusBanner(tailnet.deps)).join("\n")).toContain("tailnet   https://host.example");

    const proxied = harness({ env: { COLLIE_SKIP_SERVE: "1", COLLIE_PUBLIC_URL: "https://c.example" } });
    const lines = (await statusBanner(proxied.deps)).join("\n");
    expect(lines).toContain("proxy     https://c.example");
    expect(lines).not.toContain("tailnet");

    const unset = harness({ env: { COLLIE_SKIP_SERVE: "1" } });
    expect((await statusBanner(unset.deps)).join("\n")).toContain("set COLLIE_PUBLIC_URL");
  });

  test("status appends the serve config, or says it was skipped", async () => {
    const h = harness({ answers: [["tailscale serve status", { stdout: "https://host (tailnet only)\n" }]] });
    await cmdStatus(h.deps);
    expect(h.io.stdout).toContain("  serve config:");
    expect(h.io.stdout).toContain("    https://host (tailnet only)");

    const skipped = harness({ env: { COLLIE_SKIP_SERVE: "1" } });
    await cmdStatus(skipped.deps);
    expect(skipped.io.stdout).toContain("  serve config: skipped (COLLIE_SKIP_SERVE=1)");
  });
});

describe("url", () => {
  test("https by default, http+port in http mode, loopback when the tailnet has no name", () => {
    const withName = (over: HarnessOptions = {}): string => {
      const h = harness({
        answers: [["tailscale status --json", { stdout: '{"Self":{"DNSName":"host.example."},"CertDomains":["host.example"]}' }]],
        ...over,
      });
      cmdUrl(h.deps);
      return h.io.stdout.join("");
    };
    expect(withName()).toBe("https://host.example");
    expect(withName({ env: { COLLIE_SERVE_MODE: "http" } })).toBe("https://host.example");

    const http = harness({
      answers: [["tailscale status --json", { stdout: '{"Self":{"DNSName":"host.example."},"CertDomains":["host.example"]}' }]],
    });
    http.deps.ctx.serveMode = "http";
    cmdUrl(http.deps);
    expect(http.io.stdout.join("")).toBe("http://host.example:8787");

    const noTailscale = harness({ absent: ["tailscale"] });
    cmdUrl(noTailscale.deps);
    expect(noTailscale.io.stdout.join("")).toBe("http://127.0.0.1:8787 (Tailscale name unavailable)");
  });
});

describe("logs", () => {
  test("systemd: the journal, with the requested line count", () => {
    const h = harness();
    expect(cmdLogs(h.deps, ["120"])).toBe(EXIT.OK);
    expect(h.exec.calls).toContain("journalctl --user -u collie -n 120 --no-pager");
    const dflt = harness();
    cmdLogs(dflt.deps, []);
    expect(dflt.exec.calls).toContain("journalctl --user -u collie -n 50 --no-pager");
  });

  test("otherwise: the tail of the unsupervised log, or `(no log)`", () => {
    const h = harness({
      answers: NO_SYSTEMD,
      files: { [`${CONFIG}/collie.log`]: "one\ntwo\nthree\n" },
    });
    expect(cmdLogs(h.deps, ["2"])).toBe(EXIT.OK);
    expect(h.io.stdout).toEqual(["two", "three"]);

    const empty = harness({ answers: NO_SYSTEMD });
    cmdLogs(empty.deps, []);
    expect(empty.io.stdout).toEqual(["(no log)"]);
  });
});

describe("uninstall", () => {
  const RECORD = `${CONFIG}/tailscale-managed-handler`;
  const UNIT_FILE = `${HOME}/.config/systemd/user/collie.service`;
  const PLIST = `${HOME}/Library/LaunchAgents/herdr.collie.plist`;
  const OWNED = '{"TCP":{"443":{"HTTPS":true}},"Web":{"host.example:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8787"}}}}}';

  test("on systemd: stops, unpublishes, removes the unit, and keeps .env and the checkout", async () => {
    const h = harness({
      answers: [["tailscale serve status --json", { stdout: OWNED }]],
      files: {
        [UNIT_FILE]: "[Unit]\n",
        [`${CONFIG}/collie.pid`]: "999\n",
        [`${CONFIG}/.env`]: "COLLIE_PORT=8787\n",
        [RECORD]: "https:443|host.example:443|http://127.0.0.1:8787\n",
      },
    });
    expect(await cmdUninstall(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls).toContain("systemctl --user disable --now collie");
    expect(h.exec.calls).toContain("systemctl --user daemon-reload");
    expect(h.exec.calls).toContain("systemctl --user reset-failed collie");
    expect(h.exec.calls).toContain("tailscale serve --https=443 --set-path=/ off");
    expect(h.files.exists(UNIT_FILE)).toBe(false);
    expect(h.files.exists(`${CONFIG}/collie.pid`)).toBe(false);
    expect(h.files.exists(RECORD)).toBe(false);
    // `uninstall` removes only what `start` created.
    expect(h.files.exists(`${CONFIG}/.env`)).toBe(true);
    expect(h.io.stdout.join("\n")).toContain("✓ uninstalled:");
    expect(h.io.stdout.join("\n")).toContain(`kept: ${join(CONFIG, ".env")} and the checkout`);
  });

  test("on Linux and macOS a binary install's uninstall output is exactly what it was", async () => {
    for (const host of [hostFor("linux"), hostFor("darwin")]) {
      const run = async (binary: boolean): Promise<string[]> => {
        const h = harness({ answers: host.platform === "darwin" ? NO_SYSTEMD : [], host });
        if (binary) {
          const root = "/home/pat/.local/share/collie/versions/1.16.0";
          h.deps.ctx = { ...h.deps.ctx, root };
          h.deps.link = fakeLinkFs({ "/home/pat/.local/share/collie/current": { kind: "symlink", target: "versions/1.16.0" } });
        }
        expect(await cmdUninstall(h.deps)).toBe(EXIT.OK);
        return h.io.stdout.map((l) => l.replace(/\/home\/pat\/\.local\/share\/collie\/versions\/1\.16\.0/g, "<root>"));
      };
      const plain = await run(false);
      expect(await run(true)).toEqual(plain);
      expect(plain.at(-1)).toContain("kept: ");
      expect(plain.join("\n")).not.toContain("rmdir");
    }
  });

  test("on launchd: the plist goes, then `enable` clears the disable record a reinstall would inherit", async () => {
    const h = harness({
      answers: NO_SYSTEMD,
      host: hostFor("darwin"),
      files: { [PLIST]: "<plist/>" },
    });
    expect(await cmdUninstall(h.deps)).toBe(EXIT.OK);
    expect(h.files.exists(PLIST)).toBe(false);
    // `stop`'s disable outlives the plist; `enable` resets it. Order matters: plist first.
    const disable = h.exec.calls.indexOf("launchctl disable gui/501/herdr.collie");
    const enable = h.exec.calls.indexOf("launchctl enable gui/501/herdr.collie");
    expect(disable).toBeGreaterThanOrEqual(0);
    expect(enable).toBeGreaterThan(disable);
  });

  test("a refused unserve aborts it — a clean report over a live front door would be a lie", async () => {
    const h = harness({
      // The recorded root was replaced out from under us: teardown refuses and keeps the record.
      answers: [
        [
          "tailscale serve status --json",
          {
            stdout:
              '{"TCP":{"443":{"HTTPS":true}},"Web":{"host.example:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7000"}}}}}',
          },
        ],
      ],
      files: {
        [UNIT_FILE]: "[Unit]\n",
        [RECORD]: "https:443|host.example:443|http://127.0.0.1:8787\n",
      },
    });
    expect(await cmdUninstall(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("refusing to remove");
    expect(h.files.exists(RECORD)).toBe(true);
    expect(h.files.exists(UNIT_FILE)).toBe(true);
    expect(h.io.stdout.join("\n")).not.toContain("✓ uninstalled");
  });
});

// ── Two instances on one host ────────────────────────────────────────────────
// A stable Collie and a next-major one, side by side: same checkout, same binary, different unit,
// different pidfile, different log. What is asserted here is the SEPARATION — every place one
// instance could reach the other's service is a place `start` could stop the wrong bridge.

describe("the COLLIE_INSTANCE knob", () => {
  test("suffixes the unit, its file, and every systemctl call that names it", async () => {
    const h = harness({ instance: "v1" });
    expect(await cmdStart(h.deps)).toBe(EXIT.OK);
    expect(h.files.exists(`${HOME}/.config/systemd/user/collie-v1.service`)).toBe(true);
    expect(h.files.exists(`${HOME}/.config/systemd/user/collie.service`)).toBe(false);
    expect(h.exec.calls).toContain("systemctl --user enable --now collie-v1");
    expect(h.exec.calls).not.toContain("systemctl --user enable --now collie");
    expect(h.io.stdout.join("\n")).toContain("bridge started (systemd --user: collie-v1)");
  });

  test("the unit runs the binary with its instance marker, and carries COLLIE_INSTANCE", () => {
    const h = harness({ instance: "v1" });
    expect(writeUnit(h.deps)).toBe(true);
    const unit = h.files.read(`${HOME}/.config/systemd/user/collie-v1.service`)!;
    expect(unit).toContain(`ExecStart=${BINARY} _exec-bridge --instance v1`);
    expect(unit).toContain("Environment=COLLIE_INSTANCE=v1");
    expect(unit).toContain("Description=Collie (instance v1)");
  });

  test("the launchd label, plist and target are the instance's own", async () => {
    const h = harness({ instance: "v1", answers: NO_SYSTEMD, host: hostFor("darwin") });
    expect(await cmdStop(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls).toContain("launchctl bootout gui/501/herdr.collie-v1");
    expect(h.exec.calls).not.toContain("launchctl bootout gui/501/herdr.collie");
  });

  test("`logs` reads the instance's own journal unit and its own log file", () => {
    const h = harness({ instance: "v1" });
    expect(cmdLogs(h.deps, ["9"])).toBe(EXIT.OK);
    expect(h.exec.calls).toContain("journalctl --user -u collie-v1 -n 9 --no-pager");

    const solo = harness({ files: { [`${CONFIG}/collie.log`]: "solo\n" }, answers: NO_SYSTEMD });
    const v1 = harness({
      instance: "v1",
      answers: NO_SYSTEMD,
      files: { [`${CONFIG}/collie.log`]: "solo\n", [`${CONFIG}/collie-v1.log`]: "v1\n" },
    });
    expect(cmdLogs(solo.deps, [])).toBe(EXIT.OK);
    expect(solo.io.stdout).toEqual(["solo"]);
    expect(cmdLogs(v1.deps, [])).toBe(EXIT.OK);
    expect(v1.io.stdout).toEqual(["v1"]);
  });

  test("the pidfile predicate refuses the OTHER instance's bridge, both directions", () => {
    // Same checkout, so the binary path proves nothing — only the argv marker does.
    const solo = `${BINARY} _exec-bridge`;
    const v1 = `${BINARY} _exec-bridge --instance v1`;
    expect(isOurBridge(solo, BINARY, null)).toBe(true);
    expect(isOurBridge(v1, BINARY, "v1")).toBe(true);
    expect(isOurBridge(v1, BINARY, null)).toBe(false);
    expect(isOurBridge(solo, BINARY, "v1")).toBe(false);
    expect(isOurBridge(`${BINARY} _exec-bridge --instance v2`, BINARY, "v1")).toBe(false);
    // A prefix is not a match: `v1` must not adopt `v10`'s bridge.
    expect(isOurBridge(`${BINARY} _exec-bridge --instance v10`, BINARY, "v1")).toBe(false);
  });

  test("stopping one instance never kills the other's pid", () => {
    const OTHER = 7777;
    const h = harness({
      instance: "v1",
      files: { [`${CONFIG}/collie.pid`]: `${OTHER}\n`, [`${CONFIG}/collie-v1.pid`]: "8888\n" },
      ps: { [OTHER]: `${BINARY} _exec-bridge`, 8888: `${BINARY} _exec-bridge --instance v1` },
    });
    stopPidfileProcess(h.deps);
    expect(h.exec.killed).toEqual([8888]);
    // The solo instance's pidfile is untouched — it is not this instance's record to drop.
    expect(h.files.exists(`${CONFIG}/collie.pid`)).toBe(true);
    expect(h.files.exists(`${CONFIG}/collie-v1.pid`)).toBe(false);
  });

  test("the banner names the instance, and a solo banner still does not", async () => {
    const v1 = harness({ instance: "v1" });
    expect((await statusBanner(v1.deps)).join("\n")).toContain("instance  v1");
    const solo = harness();
    expect((await statusBanner(solo.deps)).join("\n")).not.toContain("instance ");
    expect(serviceDescription(v1.deps)).toContain("(collie-v1)");
    expect(serviceDescription(solo.deps)).toContain("(collie)");
  });

  test("uninstalling one instance leaves the other's unit and ownership record alone", async () => {
    const SOLO_UNIT = `${HOME}/.config/systemd/user/collie.service`;
    const V1_UNIT = `${HOME}/.config/systemd/user/collie-v1.service`;
    const h = harness({
      instance: "v1",
      files: { [SOLO_UNIT]: "[Unit]\n", [V1_UNIT]: "[Unit]\n", [`${CONFIG}/tailscale-managed-handler`]: "https:443|host.example:443|http://127.0.0.1:8787\n" },
    });
    expect(await cmdUninstall(h.deps)).toBe(EXIT.OK);
    expect(h.files.exists(V1_UNIT)).toBe(false);
    expect(h.files.exists(SOLO_UNIT)).toBe(true);
    // v1's handler record is `…-v1`, so the solo instance's front-door record survives untouched.
    expect(h.files.read(`${CONFIG}/tailscale-managed-handler`)).toContain("http://127.0.0.1:8787");
    expect(h.exec.calls).toContain("systemctl --user reset-failed collie-v1");
  });
});

// GOLDEN: the POSIX restart, whole, as it was before the Windows work of M43 spec 08. The Windows
// tier's restart has its own loop, its own clock and its own messages; none of that may reach these.
describe("restart off Windows, golden", () => {
  // The fakes model a POSIX box. Run on Windows, `join` and `resolve` spell those paths with `\` and
  // a drive; folded back, the transcript must be the same one.
  const fold = (lines: readonly string[]): string[] =>
    lines.map((l) => (process.platform === "win32" ? l.replace(/\b[A-Za-z]:(?=[\\/])/g, "").replaceAll("\\", "/") : l));
  const BUILD = [
    "/opt/collie$ bash /opt/collie/scripts/check-version.sh",
    "/opt/collie$ bun install",
    "/opt/collie/web$ bun install",
    "/opt/collie$ bun run typecheck",
    "/opt/collie/web$ bun run typecheck",
    "/opt/collie/bin/.bun-compile-1$ bun build --compile --target=bun /opt/collie/cli/main.ts --outfile /opt/collie/bin/collie.new",
    "/opt/collie/web$ bun run build -- --outDir dist-staging --emptyOutDir",
  ];
  const ENV = "systemctl --user show-environment";
  const banner = (service: string): string[] => [
    "",
    "  ✓ Collie is running  ·  vunknown",
    `    service   ${service}`,
    "    local     http://127.0.0.1:8787",
    "    tailnet   http://127.0.0.1:8787 (Tailscale name unavailable)",
    "",
  ];
  const head = ["took COLLIE_MUX=herdr from your environment; wrote COLLIE_MUX=herdr to /cfg/.env", "bridge stopped", "building web UI (first run)…", "web source: web/ (default)"];
  const noTailnet = [
    "error: 'tailscale status' named no host for this node — the allowlist was not discovered.",
    "       no allowlist is set, so the Host gate will refuse every request. Set",
    "       COLLIE_TAILSCALE_HOSTS (or COLLIE_PUBLIC_HOSTS) in .env, or fix Tailscale and retry.",
  ];

  test("systemd: disable --now, build, enable --now, the banner", async () => {
    const h = harness();
    expect(await cmdRestart(h.deps)).toBe(EXIT.OK);
    expect(fold(h.exec.calls)).toEqual([
      ENV, ENV, "systemctl --user disable --now collie", ...BUILD, ENV, "tailscale status --json",
      "systemctl --user daemon-reload", "systemctl --user enable --now collie", ENV,
      "systemctl --user is-active collie", "tailscale status --json",
    ]);
    expect(fold(h.io.stdout)).toEqual([...head, "bridge started (systemd --user: collie)", ...banner("systemd --user (collie) · unknown")]);
    expect(fold(h.io.stderr)).toEqual(noTailnet);
    expect(h.exec.killed).toEqual([]);
  });

  test("launchd: bootout, build, bootstrap, kickstart, read the pid back, the banner", async () => {
    const h = harness({
      host: hostFor("darwin"),
      answers: [...NO_SYSTEMD, ["launchctl print gui/501/herdr.collie", { stdout: "\tpid = 4242\n" }]],
    });
    expect(await cmdRestart(h.deps)).toBe(EXIT.OK);
    expect(fold(h.exec.calls)).toEqual([
      ENV, ENV, ENV, ENV, "launchctl disable gui/501/herdr.collie", "launchctl bootout gui/501/herdr.collie", ...BUILD,
      ENV, ENV, "tailscale status --json", "launchctl bootout gui/501/herdr.collie", "launchctl enable gui/501/herdr.collie",
      "launchctl bootstrap gui/501 /home/pat/Library/LaunchAgents/herdr.collie.plist",
      "launchctl kickstart gui/501/herdr.collie", "launchctl print gui/501/herdr.collie", ENV, ENV,
      "launchctl print gui/501/herdr.collie", "launchctl print user/501/herdr.collie", "tailscale status --json",
    ]);
    expect(fold(h.io.stdout)).toEqual([...head, "bridge started (launchd: herdr.collie)", ...banner("launchd (gui/501/herdr.collie) · active (pid 4242)")]);
    expect(fold(h.io.stderr)).toEqual(noTailnet);
  });

  test("unsupervised: a detached bridge, the banner", async () => {
    const h = harness({ answers: NO_SYSTEMD });
    expect(await cmdRestart(h.deps)).toBe(EXIT.OK);
    expect(fold(h.exec.calls)).toEqual([ENV, ENV, ENV, ENV, ...BUILD, ENV, ENV, "tailscale status --json", ENV, ENV, "tailscale status --json"]);
    expect(fold(h.io.stdout)).toEqual([...head, "bridge started (pid 4242, unsupervised)", ...banner("pid 4242 (unsupervised)")]);
    expect(h.exec.spawned.map((x) => fold(x.command))).toEqual([["/opt/collie/bin/collie", "_exec-bridge"]]);
  });
});
