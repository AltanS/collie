import { describe, expect, test } from "bun:test";

import type { CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import {
  cmdLogs,
  cmdStart,
  cmdStatus,
  cmdStop,
  cmdUrl,
  isOurBridge,
  type LifecycleDeps,
  serviceDescription,
  statusBanner,
  stopPidfileProcess,
  supervisionTier,
} from "./lifecycle.ts";
import type { Exec, ExecResult, Files } from "./sys.ts";

// The lifecycle, driven end to end against fakes for the two seams. The shell could only reach this
// coverage by `source`-ing itself and redefining functions in a heredoc; here `start` on all three
// supervision tiers, the launchd retry, the pidfile guard and the banner are ordinary unit tests.

const ROOT = "/opt/collie";
const BINARY = "/opt/collie/bin/collie";
const CONFIG = "/cfg";
const HOME = "/home/pat";

interface FakeExec extends Exec {
  /** `<tool> <args…>` for every call, in order. */
  calls: string[];
  killed: number[];
  spawned: { command: string[]; env: Record<string, string>; logPath: string }[];
}

interface Scripted {
  /** Tools that are not installed. */
  absent?: string[];
  /** Per-call answers, by `<tool> <args…>` prefix match; the first matching entry wins. */
  answers?: [prefix: string, answer: Partial<ExecResult> | ((n: number) => Partial<ExecResult>)][];
  /** The process table, for `ps -p <pid> -o command=`. */
  ps?: Record<number, string>;
  /** pid handed back by a detached spawn. */
  spawnPid?: number | null;
}

function fakeExec(scripted: Scripted = {}): FakeExec {
  const calls: string[] = [];
  const killed: number[] = [];
  const spawned: { command: string[]; env: Record<string, string>; logPath: string }[] = [];
  const absent = new Set(scripted.absent ?? []);
  const seen = new Map<string, number>();
  const answer = (tool: string, args: readonly string[]): ExecResult => {
    const line = [tool, ...args].join(" ");
    calls.push(line);
    if (absent.has(tool)) return { code: 127, stdout: "", stderr: "", found: false };
    for (const [prefix, a] of scripted.answers ?? []) {
      if (!line.startsWith(prefix)) continue;
      const n = (seen.get(prefix) ?? 0) + 1;
      seen.set(prefix, n);
      const resolved = typeof a === "function" ? a(n) : a;
      return { code: 0, stdout: "", stderr: "", found: true, ...resolved };
    }
    return { code: 0, stdout: "", stderr: "", found: true };
  };
  return {
    calls,
    killed,
    spawned,
    which: (tool) => (absent.has(tool) ? null : `/fake/${tool}`),
    capture: answer,
    inherit: answer,
    spawnDetached(command, opts) {
      spawned.push({ command: [...command], env: opts.env, logPath: opts.logPath });
      return scripted.spawnPid === undefined ? 4242 : scripted.spawnPid;
    },
    processCommand: (pid) => scripted.ps?.[pid] ?? null,
    kill: (pid) => void killed.push(pid),
  };
}

interface FakeFiles extends Files {
  entries: Map<string, { text: string; mode?: number }>;
}

function fakeFiles(seed: Record<string, string> = {}): FakeFiles {
  const entries = new Map<string, { text: string; mode?: number }>();
  for (const [p, text] of Object.entries(seed)) entries.set(p, { text });
  return {
    entries,
    exists: (p) => entries.has(p),
    read: (p) => entries.get(p)?.text ?? null,
    write: (p, text, mode) => void entries.set(p, { text, mode }),
    mkdirp: () => {},
    remove: (p) => void entries.delete(p),
  };
}

function capture(): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => stdout.push(l), err: (l) => stderr.push(l) };
}

function context(env: Record<string, string | undefined> = {}): CliContext {
  return {
    root: ROOT,
    configDir: CONFIG,
    home: HOME,
    env,
    port: 8787,
    serveMode: "https",
    socket: "/home/pat/.config/herdr/herdr.sock",
    handlerFile: `${CONFIG}/tailscale-managed-handler`,
  };
}

interface Harness {
  deps: LifecycleDeps;
  io: ReturnType<typeof capture>;
  exec: FakeExec;
  files: FakeFiles;
}

type HarnessOptions = Partial<
  Scripted & {
    platform: NodeJS.Platform;
    ready: boolean;
    env: Record<string, string | undefined>;
    files: Record<string, string>;
    serve: () => Promise<number>;
  }
>;

function harness(over: HarnessOptions = {}): Harness {
  const io = capture();
  const exec = fakeExec(over);
  // The binary exists unless a test deliberately removes it — every other test would otherwise be
  // asserting the "no binary" guard by accident.
  const files = fakeFiles({ [BINARY]: "", ...(over.files ?? {}) });
  const deps: LifecycleDeps = {
    ctx: context(over.env),
    io,
    exec,
    files,
    ready: () => Promise.resolve(over.ready ?? true),
    sleep: () => Promise.resolve(),
    uid: () => 501,
    platform: over.platform ?? "linux",
    serve: over.serve ?? (() => Promise.resolve(EXIT.OK)),
  };
  return { deps, io, exec, files };
}

/** The scripted answer that makes `systemctl --user show-environment` fail — no user systemd. */
const NO_SYSTEMD: Scripted["answers"] = [["systemctl --user show-environment", { code: 1 }]];

describe("supervision tiers", () => {
  test("systemd requires the user instance to answer, not just the binary to exist", () => {
    expect(supervisionTier(fakeExec(), "linux")).toBe("systemd");
    expect(supervisionTier(fakeExec({ answers: NO_SYSTEMD }), "linux")).toBe("unsupervised");
    expect(supervisionTier(fakeExec({ absent: ["systemctl"] }), "linux")).toBe("unsupervised");
  });

  test("launchd is gated on Darwin — the gui/<uid> domain is Darwin-only", () => {
    expect(supervisionTier(fakeExec({ answers: NO_SYSTEMD }), "darwin")).toBe("launchd");
    // launchctl exists on this Linux box (it doesn't, but prove the platform gate is what decides).
    expect(supervisionTier(fakeExec({ answers: NO_SYSTEMD }), "linux")).toBe("unsupervised");
    expect(supervisionTier(fakeExec({ answers: NO_SYSTEMD, absent: ["launchctl"] }), "darwin")).toBe(
      "unsupervised",
    );
  });

  test("COLLIE_SUPERVISOR pins the tier, and a typo is ignored rather than fatal", () => {
    const pin = (v: string): string => supervisionTier(fakeExec(), "linux", { COLLIE_SUPERVISOR: v });
    expect(pin("launchd")).toBe("launchd");
    expect(pin("unsupervised")).toBe("unsupervised");
    // This decides where the bridge runs; a typo must not take the host down.
    expect(pin("runit")).toBe("systemd");
    expect(pin("")).toBe("systemd");
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

  test("kills the pid only when it is still our bridge, and always drops the record", () => {
    const h = harness({
      files: { [`${CONFIG}/collie.pid`]: "4242\n" },
      ps: { 4242: `${BINARY} _exec-bridge` },
    });
    stopPidfileProcess(h.deps);
    expect(h.exec.killed).toEqual([4242]);
    expect(h.files.exists(`${CONFIG}/collie.pid`)).toBe(false);
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
    h.files.remove(BINARY);
    expect(await cmdStart(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain(`no collie binary at ${BINARY}`);
    expect(h.exec.calls).not.toContain("systemctl --user enable --now collie");
  });

  test("a failing front door prints the note and still reaches the banner, exit 0", async () => {
    // scripts/collie-ctl.sh:431-434 — the bridge is already up on loopback and the banner is what
    // the README's troubleshooting flow tells people to read.
    const h = harness({ serve: () => Promise.resolve(EXIT.FAIL) });
    expect(await cmdStart(h.deps)).toBe(EXIT.OK);
    expect(h.io.stderr.join("\n")).toContain("the tailnet front door did not come up");
    expect(h.io.stdout.join("\n")).toContain("✓ Collie is running");
  });

  test("warns, but does not fail, when the UI was never built", async () => {
    const h = harness();
    expect(await cmdStart(h.deps)).toBe(EXIT.OK);
    expect(h.io.stderr.join("\n")).toContain("web/dist is not built");
  });
});

describe("start, on launchd", () => {
  const darwin = (over: HarnessOptions = {}): Harness =>
    harness({ ...over, platform: "darwin", answers: [...NO_SYSTEMD, ...(over.answers ?? [])] });

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
      `launchctl bootstrap gui/501 ${HOME}/Library/LaunchAgents/herdr.collie.plist`,
    );
    expect(h.io.stdout).toContain("bridge started (launchd: herdr.collie)");
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
          (n) => (n > 1 ? {} : { code: 5, stderr: "Bootstrap failed: 5: Input/output error" }),
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
    expect(h.exec.spawned[0]?.logPath).toBe(`${CONFIG}/collie.log`);
    expect(h.io.stdout).toContain("bridge started (pid 4242, unsupervised)");
  });

  test("passes the merged .env through — the daemon is the only reader of a mode-600 secret", async () => {
    const h = harness({ answers: NO_SYSTEMD, env: { COLLIE_VAPID_PRIVATE: "shhh" } });
    await cmdStart(h.deps);
    expect(h.exec.spawned[0]?.env.COLLIE_VAPID_PRIVATE).toBe("shhh");
  });
});

describe("stop", () => {
  test("systemd: disable --now, so it stays down across a login", () => {
    const h = harness();
    expect(cmdStop(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls).toContain("systemctl --user disable --now collie");
    expect(h.io.stdout).toContain("bridge stopped");
  });

  test("launchd: disable AND bootout — together they are `disable --now`", () => {
    const h = harness({ platform: "darwin", answers: NO_SYSTEMD });
    expect(cmdStop(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls).toContain("launchctl disable gui/501/herdr.collie");
    expect(h.exec.calls).toContain("launchctl bootout gui/501/herdr.collie");
  });

  test("unsupervised: the pidfile process, and nothing else", () => {
    const h = harness({
      answers: NO_SYSTEMD,
      files: { [`${CONFIG}/collie.pid`]: "4242\n" },
      ps: { 4242: `${BINARY} _exec-bridge` },
    });
    expect(cmdStop(h.deps)).toBe(EXIT.OK);
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

  test("reads the unit's state, not merely that a unit exists", () => {
    const h = harness({ answers: [["systemctl --user is-active", { stdout: "active\n" }]] });
    expect(serviceDescription(h.deps)).toBe("systemd --user (collie) · active");
  });

  test("the launchd line covers loaded, loaded-but-stopped, absent, and the fallback", () => {
    const darwin = (answers: Scripted["answers"], files?: Record<string, string>): LifecycleDeps =>
      harness({ platform: "darwin", answers: [...NO_SYSTEMD, ...(answers ?? [])], files }).deps;

    expect(
      serviceDescription(
        darwin([["launchctl print", { stdout: "\tstate = running\n\tpid = 4242\n" }]]),
      ),
    ).toBe("launchd (herdr.collie) · active (pid 4242)");
    expect(
      serviceDescription(darwin([["launchctl print", { stdout: "\tstate = waiting\n" }]])),
    ).toBe("launchd (herdr.collie) · loaded, not running");
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

  test("prints the tailnet URL, or the proxy line under COLLIE_SKIP_SERVE", async () => {
    const tailnet = harness({
      answers: [["tailscale status --json", { stdout: '{"Self":{"DNSName":"host.example."}}' }]],
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
        answers: [["tailscale status --json", { stdout: '{"Self":{"DNSName":"host.example."}}' }]],
        ...over,
      });
      cmdUrl(h.deps);
      return h.io.stdout.join("");
    };
    expect(withName()).toBe("https://host.example");
    expect(withName({ env: { COLLIE_SERVE_MODE: "http" } })).toBe("https://host.example");

    const http = harness({
      answers: [["tailscale status --json", { stdout: '{"Self":{"DNSName":"host.example."}}' }]],
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
