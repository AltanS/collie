import { describe, expect, test } from "bun:test";

import {
  BINARY,
  capture,
  CONFIG,
  context,
  type FakeExec,
  fakeExec,
  type FakeFiles,
  fakeFiles,
  HOME,
  ROOT,
  STATE,
  type Scripted,
} from "./fakes.ts";
import { leadStore, member, peerStore } from "../bridge/pack/fixtures.ts";
import { serializeTrustStore } from "../bridge/pack/trust-store.ts";
import { EXIT, type Io } from "./io.ts";

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
  type LifecycleDeps,
  serviceDescription,
  statusBanner,
  stopPidfileProcess,
  resolveTailscaleHosts,
  supervisionTier,
  writeUnit,
} from "./lifecycle.ts";

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
    platform: NodeJS.Platform;
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
  const files = fakeFiles({ [BINARY]: "", ...over.files });
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
    platform: over.platform ?? "linux",
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

    const broken = harness({ answers: [[`${ROOT}/web$ bun run build --`, { code: 1 }]] });
    expect(await cmdStart(broken.deps)).toBe(EXIT.OK);
    expect(broken.io.stderr.join("\n")).toContain("the UI will 503");
    expect(broken.io.stdout.join("\n")).toContain("bridge started");
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
    expect(h.exec.spawned[0]?.logPath).toBe(`${CONFIG}/collie.log`);
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
    expect(h.io.stderr.join("\n")).toContain(`${CONFIG}/.env`);
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
    expect(said).toContain("no COLLIE_MUX is set, and 2 multiplexers are running here");
    expect(said).toContain(`fix:  printf 'COLLIE_MUX=<herdr|tmux|zellij>\\n' >> ${CONFIG}/.env && collie start`);
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
  // which on a peer is not the bind either. The pack row answers the question the tailnet row was
  // asked: where DO I point my phone.
  test("a peer's banner names the pack, not a tailnet door it does not serve", async () => {
    const h = harness({
      ready: true,
      env: { COLLIE_HOST: "192.168.77.2" },
      files: { [`${STATE}/pack-trust.json`]: serializeTrustStore(peerStore()) },
    });
    const lines = (await statusBanner(h.deps)).join("\n");
    expect(lines).toContain("local     http://192.168.77.2:8787");
    expect(lines).toContain("pack      peer — no front door here");
    expect(lines).not.toContain("tailnet");
  });

  test("a LEAD, and a solo collie, keep the tailnet row exactly as it was", async () => {
    const lead = harness({
      ready: true,
      files: { [`${STATE}/pack-trust.json`]: serializeTrustStore(leadStore({ peers: [member({ memberId: "nas" })] })) },
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

describe("uninstall", () => {
  const RECORD = `${CONFIG}/tailscale-managed-handler`;
  const UNIT_FILE = `${HOME}/.config/systemd/user/collie.service`;
  const PLIST = `${HOME}/Library/LaunchAgents/herdr.collie.plist`;
  const OWNED = '{"TCP":{"443":{"HTTPS":true}},"Web":{"host.example:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8787"}}}}}';

  test("on systemd: stops, unpublishes, removes the unit, and keeps .env and the checkout", () => {
    const h = harness({
      answers: [["tailscale serve status --json", { stdout: OWNED }]],
      files: {
        [UNIT_FILE]: "[Unit]\n",
        [`${CONFIG}/collie.pid`]: "999\n",
        [`${CONFIG}/.env`]: "COLLIE_PORT=8787\n",
        [RECORD]: "https:443|host.example:443|http://127.0.0.1:8787\n",
      },
    });
    expect(cmdUninstall(h.deps)).toBe(EXIT.OK);
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
    expect(h.io.stdout.join("\n")).toContain(`kept: ${CONFIG}/.env and the checkout`);
  });

  test("on launchd: the plist goes, then `enable` clears the disable record a reinstall would inherit", () => {
    const h = harness({
      answers: NO_SYSTEMD,
      platform: "darwin",
      files: { [PLIST]: "<plist/>" },
    });
    expect(cmdUninstall(h.deps)).toBe(EXIT.OK);
    expect(h.files.exists(PLIST)).toBe(false);
    // `stop`'s disable outlives the plist; `enable` resets it. Order matters: plist first.
    const disable = h.exec.calls.indexOf("launchctl disable gui/501/herdr.collie");
    const enable = h.exec.calls.indexOf("launchctl enable gui/501/herdr.collie");
    expect(disable).toBeGreaterThanOrEqual(0);
    expect(enable).toBeGreaterThan(disable);
  });

  test("a refused unserve aborts it — a clean report over a live front door would be a lie", () => {
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
    expect(cmdUninstall(h.deps)).toBe(EXIT.FAIL);
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

  test("the launchd label, plist and target are the instance's own", () => {
    const h = harness({ instance: "v1", answers: NO_SYSTEMD, platform: "darwin" });
    expect(cmdStop(h.deps)).toBe(EXIT.OK);
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

  test("uninstalling one instance leaves the other's unit and ownership record alone", () => {
    const SOLO_UNIT = `${HOME}/.config/systemd/user/collie.service`;
    const V1_UNIT = `${HOME}/.config/systemd/user/collie-v1.service`;
    const h = harness({
      instance: "v1",
      files: { [SOLO_UNIT]: "[Unit]\n", [V1_UNIT]: "[Unit]\n", [`${CONFIG}/tailscale-managed-handler`]: "https:443|host.example:443|http://127.0.0.1:8787\n" },
    });
    expect(cmdUninstall(h.deps)).toBe(EXIT.OK);
    expect(h.files.exists(V1_UNIT)).toBe(false);
    expect(h.files.exists(SOLO_UNIT)).toBe(true);
    // v1's handler record is `…-v1`, so the solo instance's front-door record survives untouched.
    expect(h.files.read(`${CONFIG}/tailscale-managed-handler`)).toContain("http://127.0.0.1:8787");
    expect(h.exec.calls).toContain("systemctl --user reset-failed collie-v1");
  });
});
