import { describe, expect, test } from "bun:test";

import { leadStore, member, peerStore } from "../bridge/crew/fixtures.ts";
import type { OpsRecord } from "../bridge/crew/ops-store.ts";
import type { TrustStoreData } from "../bridge/crew/trust-store.ts";
import {
  capture,
  context,
  type FakeExec,
  fakeExec,
  type FakeFiles,
  fakeFiles,
  fakeLinkFs,
  HOME,
  ROOT,
  type Scripted,
  type SeededFiles,
} from "./fakes.ts";
import type { InstallKind } from "./install-kind.ts";
import type { Finding } from "./finding.ts";
import { EXIT } from "./io.ts";
import { COMMANDS } from "./program.ts";
import type { RemoteResult, RemoteRunner } from "./remote.ts";
import type { Net } from "./sys.ts";
import { unitFilePath } from "./unit.ts";
import {
  bunCheck,
  checkLine,
  classifyTagFailure,
  cmdUpdateCheck,
  parseDfAvailableKb,
  parseReport,
  preflight,
  PREFLIGHT_SCHEMA,
  type PreflightCheck,
  type PreflightReport,
  skewCheck,
  type UpdateCheckDeps,
  wantsCheck,
  wantsLocal,
  worst,
} from "./update-check.ts";

// `collie update --check` against fakes. Nothing here reaches a disk, a network, a service manager
// or an ssh — which is the point: the preflight the phone polls has to be provable without any of
// them. Every case asserts on the REASON text as well as the verdict, because a red with a generic
// message is the defect this spec exists to prevent.

const GIT = `git -C ${ROOT}`;
const UNIT = unitFilePath(HOME, null);

/** A remote with `v1.0.0` as its newest major-1 release and a `v2.0.0` sitting above it. */
const LS_REMOTE = [
  "a1a1a1a1\trefs/tags/v0.32.0",
  "cccccccc\trefs/tags/v1.0.0",
  "",
].join("\n");
const LS_REMOTE_WITH_MAJOR = `${LS_REMOTE}f0f0f0f0\trefs/tags/v2.0.0\n`;

/** `df -Pk` as POSIX prints it: a header, then one row whose fourth field is the free 1K blocks. */
const df = (availableKb: number): string =>
  ["Filesystem 1024-blocks Used Available Capacity Mounted on", `/dev/sda1 100000000 1 ${availableKb} 1% /`, ""].join(
    "\n",
  );

/** A checkout that is healthy in every respect: clean, current, supervised, roomy, with Bun. */
const HEALTHY: NonNullable<Scripted["answers"]> = [
  [`${GIT} rev-parse --git-dir`, { stdout: ".git\n" }],
  [`${GIT} symbolic-ref -q HEAD`, { code: 1 }],
  [`${GIT} remote get-url origin`, { stdout: "https://github.com/AltanS/collie.git\n" }],
  [`${GIT} status --porcelain --untracked-files=no`, { stdout: "" }],
  [`${GIT} ls-remote --tags`, { stdout: LS_REMOTE }],
  [`${GIT} rev-parse HEAD`, { stdout: "cccccccc\n" }],
  ["df -Pk", { stdout: df(50_000_000) }],
  // `fakeExec.which` answers `/fake/<tool>`, and `bunCheck` now runs the RESOLVED path — so the
  // version answer is keyed on that path, not on the bare name it used to spawn.
  ["/fake/bun --version", { stdout: "1.3.14\n" }],
  ["systemctl --user show-environment", { code: 0 }],
  ["systemctl --user is-active collie", { stdout: "active\n" }],
];

const deadNet: Net = {
  getJson: () => Promise.resolve({ ok: false, failure: { status: null, message: "no network in tests" } }),
  download: () => Promise.resolve({ ok: false, failure: { status: null, message: "no network in tests" } }),
  probe: () => Promise.resolve({ ok: false, failure: { status: null, message: "no network in tests" } }),
};

const NOT_SPAWNED: RemoteResult = { code: 255, stdout: "", stderr: "ssh: connect: timed out", spawned: false };

/** One remote turn, scripted by which script it was handed: the probe, then the preflight ask. */
interface FakeRunner extends RemoteRunner {
  scripts: string[];
  closed: number;
}

function fakeRunner(answers: (script: string) => RemoteResult): FakeRunner {
  const scripts: string[] = [];
  const runner = {
    scripts,
    closed: 0,
    run: (script: string) => {
      scripts.push(script);
      return Promise.resolve(answers(script));
    },
    close: () => void (runner.closed += 1),
  };
  return runner;
}

/** The fields the probe script prints, on a member that is healthy in every respect. */
const PROBE_FIELDS = {
  home: "/home/pat",
  git: "/usr/bin/git",
  bun: "/usr/bin/bun",
  herdr: "",
  configdir: "",
  envhost: "",
  envport: "",
  checkout: "/home/pat/collie",
  commit: "cccccccc",
  branch: "",
  dirty: "no",
  dirtyfiles: "",
  version: "1.0.0",
  address: "",
  port: "free",
};

/** `collie-probe:` lines as the far machine prints them, with the sentinel last. */
function probeOut(over: Partial<typeof PROBE_FIELDS> = {}): string {
  return `${Object.entries({ ...PROBE_FIELDS, ...over })
    .map(([k, v]) => `collie-probe:${k}=${v}`)
    .join("\n")}\ncollie-probe:probe=ok\n`;
}

const ok = (stdout: string): RemoteResult => ({ code: 0, stdout, stderr: "", spawned: true });

interface Harness {
  deps: UpdateCheckDeps;
  io: ReturnType<typeof capture>;
  exec: FakeExec;
  files: FakeFiles;
  runners: Map<string, FakeRunner>;
}

function harness(
  over: {
    answers?: Scripted["answers"];
    absent?: string[];
    files?: SeededFiles;
    env?: Record<string, string | undefined>;
    findings?: readonly Finding[];
    store?: TrustStoreData | null;
    ops?: Record<string, OpsRecord>;
    remote?: (host: string) => (script: string) => RemoteResult;
    installed?: string;
    net?: Net;
  } = {},
): Harness {
  const io = capture();
  // The scripted answers come FIRST, so a case's own line beats the healthy default beneath it.
  const exec = fakeExec({ answers: [...(over.answers ?? []), ...HEALTHY], absent: over.absent });
  const files = fakeFiles({
    [`${ROOT}/herdr-plugin.toml`]: `id = "herdr.collie"\nversion = "${over.installed ?? "1.0.0"}"\n`,
    [UNIT]: "[Unit]\n",
    ...over.files,
  });
  const runners = new Map<string, FakeRunner>();
  const deps: UpdateCheckDeps = {
    ctx: context(over.env ?? {}),
    io,
    exec,
    files,
    link: fakeLinkFs(),
    net: over.net ?? deadNet,
    platform: "linux",
    store: { load: () => Promise.resolve(over.store ?? null) },
    ops: { get: (id) => Promise.resolve(over.ops?.[id] ?? null) },
    remote: (host) => {
      const answers = over.remote?.(host) ?? (() => NOT_SPAWNED);
      const runner = fakeRunner(answers);
      runners.set(host, runner);
      return runner;
    },
    doctor: () => Promise.resolve(over.findings ?? []),
  };
  return { deps, io, exec, files, runners };
}

const byId = (report: PreflightReport, id: string): PreflightCheck => {
  const found = report.checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no check "${id}" in ${report.checks.map((c) => c.id).join(", ")}`);
  return found;
};

const record = (over: Partial<OpsRecord> = {}): OpsRecord => ({
  sshHost: "nas.local",
  path: "/home/pat/collie",
  port: 8787,
  recordedAt: 0,
  ...over,
});

describe("preflight — the healthy instance", () => {
  test("every instance check is green and the report is green", async () => {
    const report = await preflight(harness().deps);
    expect(report.checks.map((c) => c.id)).toEqual(["doctor", "disk", "bun", "tree", "upstream", "service"]);
    expect(report.checks.every((c) => c.verdict === "green")).toBe(true);
    expect(report.verdict).toBe("green");
    expect(report.crew).toBeUndefined();
  });

  test("read-only: it writes no file, moves nothing and starts no service", async () => {
    const h = harness();
    await preflight(h.deps);
    expect(h.files.ops).toEqual([]);
    expect(h.files.entries.has(`${ROOT}/web/dist/index.html`)).toBe(false);
    const forbidden = ["systemctl --user restart", "systemctl --user start", "git -C /opt/collie fetch", "git -C /opt/collie checkout", "git -C /opt/collie pull"];
    for (const call of h.exec.calls) {
      for (const f of forbidden) expect(call.startsWith(f)).toBe(false);
    }
  });
});

describe("preflight — the doctor check", () => {
  test("green when doctor is clean", async () => {
    const report = await preflight(harness({ findings: [{ check: "mux", status: "ok", detail: "herdr", remedy: null }] }).deps);
    expect(byId(report, "doctor").verdict).toBe("green");
  });

  test("red names the failing doctor checks", async () => {
    const report = await preflight(
      harness({
        findings: [
          { check: "bind", status: "error", detail: "wildcard", remedy: "set COLLIE_HOST" },
          { check: "web-dist", status: "error", detail: "missing", remedy: "collie build" },
        ],
      }).deps,
    );
    const check = byId(report, "doctor");
    expect(check.verdict).toBe("red");
    expect(check.reason).toContain("bind");
    expect(check.reason).toContain("web-dist");
    expect(check.remedy).toContain("collie doctor");
  });

  test("a doctor warning is amber, and amber never blocks", async () => {
    const h = harness({ findings: [{ check: "acl", status: "warn", detail: "…", remedy: "…" }] });
    const report = await preflight(h.deps);
    expect(byId(report, "doctor").verdict).toBe("amber");
    expect(report.verdict).toBe("amber");
    expect(await cmdUpdateCheck(h.deps, ["--json"])).toBe(EXIT.OK);
  });
});

describe("preflight — the disk check", () => {
  test("`df -Pk`'s available column is read, not its used one", () => {
    expect(parseDfAvailableKb(df(2_000_000))).toBe(2_000_000);
    expect(parseDfAvailableKb("")).toBeNull();
    expect(parseDfAvailableKb("Filesystem 1024-blocks Used Available Capacity Mounted\n")).toBeNull();
  });

  test("green well above the floor", async () => {
    const report = await preflight(harness().deps);
    expect(byId(report, "disk").verdict).toBe("green");
  });

  test("amber under 1 GB", async () => {
    const report = await preflight(harness({ answers: [["df -Pk", { stdout: df(700_000) }]] }).deps);
    const check = byId(report, "disk");
    expect(check.verdict).toBe("amber");
    expect(check.reason).toContain("0.7 GB");
  });

  test("red under 500 MB, naming the directory and the floor", async () => {
    const h = harness({ answers: [["df -Pk", { stdout: df(100_000) }]] });
    const report = await preflight(h.deps);
    const check = byId(report, "disk");
    expect(check.verdict).toBe("red");
    expect(check.reason).toContain(ROOT);
    expect(check.reason).toContain("500 MB");
    expect(report.verdict).toBe("red");
  });
});

describe("preflight — the bun check", () => {
  test("green when bun is installed at a version the build was measured on", async () => {
    const report = await preflight(harness().deps);
    expect(byId(report, "bun").reason).toContain("1.3.14");
  });

  test("red when bun is absent on an install that builds from source", () => {
    const h = harness({ absent: ["bun"] });
    const check = bunCheck(h.deps);
    expect(check.verdict).toBe("red");
    expect(check.reason).toContain("rebuilds from source");
    expect(check.remedy).toContain("bun.sh");
  });

  test("an older bun is amber, never red", () => {
    const check = bunCheck(harness({ answers: [["/fake/bun --version", { stdout: "1.1.0\n" }]] }).deps);
    expect(check.verdict).toBe("amber");
  });

  // #169: PATH alone made this red on a host the shim builds on happily. A Bun at a known candidate
  // is green, and the reason names it — the operator's own shell will not show them that one.
  test("bun off PATH at a known candidate is green, and the reason names the absolute path", () => {
    const bun = `${HOME}/.bun/bin/bun`;
    const h = harness({
      absent: ["bun"],
      answers: [[`${bun} --version`, { stdout: "1.3.14\n" }]],
      files: { [bun]: "" },
    });
    const check = bunCheck(h.deps);
    expect(check.verdict).toBe("green");
    expect(check.reason).toContain(bun);
    expect(h.exec.calls).toContain(`${bun} --version`);
    // Never the bare name: that would answer for a different Bun than the update runs.
    expect(h.exec.calls).not.toContain("bun --version");
  });

  test("$BUN_INSTALL is honoured, exactly as the shim honours it", () => {
    const bun = "/opt/bun/bin/bun";
    const h = harness({
      absent: ["bun"],
      answers: [[`${bun} --version`, { stdout: "1.3.14\n" }]],
      env: { BUN_INSTALL: "/opt/bun" },
      files: { [bun]: "", [`${HOME}/.bun/bin/bun`]: "" },
    });
    expect(bunCheck(h.deps).reason).toContain(bun);
  });

  test("`bun is not installed` keeps today's red, sentence for sentence", () => {
    const check = bunCheck(harness({ absent: ["bun"] }).deps);
    expect(check.verdict).toBe("red");
    expect(check.reason).toBe(
      "bun is not installed, and this install rebuilds from source — the update would stop after the fetch",
    );
    expect(check.remedy).toBe("install Bun from https://bun.sh, then re-run this check");
  });

  test("a binary install is never asked about bun", async () => {
    // No `.git` and a `versions/<x.y.z>` root with a `current` symlink beside it = the binary kind.
    const h = harness({ answers: [[`git -C /opt/app/versions/1.0.0 rev-parse --git-dir`, { code: 128 }]] });
    const link = fakeLinkFs({ "/opt/app/current": { kind: "symlink", target: "versions/1.0.0" } });
    const deps: UpdateCheckDeps = {
      ...h.deps,
      ctx: context({}, { root: "/opt/app/versions/1.0.0" }),
      link,
      net: { ...deadNet, getJson: () => Promise.resolve({ ok: true, value: [{ name: "v1.0.0", commit: { sha: "cccccccc" } }] }) },
    };
    const report = await preflight(deps);
    expect(report.checks.map((c) => c.id)).toEqual(["doctor", "disk", "upstream", "service"]);
  });
});

describe("preflight — the clean-tree check", () => {
  test("untracked files stay green: `--untracked-files=no` is what is asked", async () => {
    const h = harness();
    const report = await preflight(h.deps);
    expect(h.exec.calls).toContain(`${GIT} status --porcelain --untracked-files=no`);
    expect(byId(report, "tree").verdict).toBe("green");
    expect(byId(report, "tree").reason).toContain("untracked");
  });

  test("a tracked modification is red and names the files", async () => {
    const h = harness({
      answers: [[`${GIT} status --porcelain --untracked-files=no`, { stdout: " M cli/update.ts\nM  bridge/server.ts\n" }]],
    });
    const report = await preflight(h.deps);
    const check = byId(report, "tree");
    expect(check.verdict).toBe("red");
    expect(check.reason).toContain("cli/update.ts");
    expect(check.reason).toContain("bridge/server.ts");
    expect(check.remedy).toContain("git stash");
    expect(await cmdUpdateCheck(h.deps, ["--json"])).toBe(EXIT.FAIL);
  });
});

describe("preflight — the upstream check", () => {
  test("a resolvable target is green and names it", async () => {
    const report = await preflight(
      harness({
        installed: "0.31.1",
        answers: [
          [`${GIT} ls-remote --tags`, { stdout: "a1a1a1a1\trefs/tags/v0.31.1\nb2b2b2b2\trefs/tags/v0.32.0\n" }],
          [`${GIT} rev-parse HEAD`, { stdout: "a1a1a1a1\n" }],
        ],
      }).deps,
    );
    const check = byId(report, "upstream");
    expect(check.verdict).toBe("green");
    expect(check.reason).toContain("v0.32.0");
  });

  test("already current is green with nothing to do", async () => {
    const check = byId(await preflight(harness().deps), "upstream");
    expect(check.verdict).toBe("green");
    expect(check.reason).toContain("already current");
    expect(check.remedy).toBeUndefined();
  });

  test("a major crossing is amber, with a remedy naming --major", async () => {
    const report = await preflight(harness({ answers: [[`${GIT} ls-remote --tags`, { stdout: LS_REMOTE_WITH_MAJOR }]] }).deps);
    const check = byId(report, "upstream");
    expect(check.verdict).toBe("amber");
    expect(check.reason).toContain("NEW MAJOR");
    expect(check.remedy).toContain("--major");
    expect(report.verdict).toBe("amber");
  });

  test("an unreachable remote is red and quotes git's own first line", async () => {
    const check = byId(
      await preflight(
        harness({
          answers: [[`${GIT} ls-remote --tags`, { code: 128, stderr: "fatal: could not read from remote\n" }]],
        }).deps,
      ),
      "upstream",
    );
    expect(check.verdict).toBe("red");
    expect(check.reason).toContain("fatal: could not read from remote");
  });

  test("a silent failure still reads as a remote that did not answer", async () => {
    const check = byId(
      await preflight(harness({ answers: [[`${GIT} ls-remote --tags`, { code: 128 }]] }).deps),
      "upstream",
    );
    expect(check.reason).toContain("did not answer");
    expect(check.remedy).toContain("network");
  });

  test("a missing ssh agent reads as itself, and its remedy is not the network one", async () => {
    const check = byId(
      await preflight(
        harness({
          answers: [
            [`${GIT} remote get-url origin`, { stdout: "git@github.com:AltanS/collie.git\n" }],
            [
              `${GIT} ls-remote --tags`,
              { code: 128, stderr: "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n" },
            ],
          ],
        }).deps,
      ),
      "upstream",
    );
    expect(check.verdict).toBe("red");
    expect(check.reason).toContain("Permission denied (publickey)");
    expect(check.remedy).toContain("git remote get-url origin");
  });

  test("a read-only tag listing needs no credential: an ssh origin is listed over https, with a timeout", async () => {
    const h = harness({
      answers: [[`${GIT} remote get-url origin`, { stdout: "git@github.com:AltanS/collie.git\n" }]],
    });
    await preflight(h.deps);
    const listing = h.exec.calls.find((c) => c.includes("ls-remote"))!;
    expect(listing).toBe(`${GIT} ls-remote --tags https::https://github.com/AltanS/collie.git`);
    expect(h.exec.timeouts.find((t) => t.call.includes("ls-remote"))?.ms).toBe(15_000);
  });

  test("the failure classifier tells a dead network from a credential", () => {
    for (const line of [
      "ssh: Could not resolve hostname github.com: Name or service not known",
      "fatal: unable to access 'https://github.com/a/b.git': Failed to connect",
      "ssh: connect to host github.com port 22: Connection timed out",
      "fatal: Network is unreachable",
      "",
    ]) {
      expect(classifyTagFailure(line)).toBe("network");
    }
    for (const line of [
      "git@github.com: Permission denied (publickey).",
      "Host key verification failed.",
      "remote: Repository not found.",
    ]) {
      expect(classifyTagFailure(line)).toBe("credentials");
    }
  });

  test("an origin that is not the configured update source is red and names both", async () => {
    const check = byId(
      await preflight(
        harness({ answers: [[`${GIT} remote get-url origin`, { stdout: "https://github.com/fork/collie.git\n" }]] }).deps,
      ),
      "upstream",
    );
    expect(check.verdict).toBe("red");
    expect(check.reason).toContain("github.com/fork/collie");
    expect(check.reason).toContain("github.com/AltanS/collie");
    expect(check.remedy).toContain("COLLIE_UPDATE_REPO=fork/collie");
  });
});

describe("preflight — the service check", () => {
  test("green when the unit exists and is restartable", async () => {
    const check = byId(await preflight(harness().deps), "service");
    expect(check.verdict).toBe("green");
    expect(check.reason).toContain("collie is active");
  });

  test("red when there is no unit for the update to restart", async () => {
    const h = harness();
    h.files.entries.delete(UNIT);
    const check = byId(await preflight(h.deps), "service");
    expect(check.verdict).toBe("red");
    expect(check.reason).toContain(UNIT);
    expect(check.remedy).toBe("collie start");
  });

  test("a failed unit is amber, not red — a restart still acts on it", async () => {
    const check = byId(await preflight(harness({ answers: [["systemctl --user is-active collie", { stdout: "failed\n" }]] }).deps), "service");
    expect(check.verdict).toBe("amber");
  });

  test("on macOS the LaunchAgent is what is asked about", async () => {
    const h = harness({ answers: [["systemctl --user show-environment", { code: 1 }]] });
    const deps: UpdateCheckDeps = { ...h.deps, platform: "darwin" };
    const check = byId(await preflight(deps), "service");
    expect(check.verdict).toBe("red");
    expect(check.reason).toContain("LaunchAgent");
    expect(check.reason).toContain("Library/LaunchAgents");
  });
});

describe("preflight crew — the members of a lead", () => {
  const lead = (peers: string[]): TrustStoreData => leadStore({ peers: peers.map((id) => member({ memberId: id })) });

  test("a member with no ops record is red, with a remedy naming host and path", async () => {
    const report = await preflight(harness({ store: lead(["nas"]) }).deps);
    expect(report.crew).toHaveLength(1);
    const nas = report.crew![0]!;
    expect(nas.memberId).toBe("nas");
    expect(nas.verdict).toBe("red");
    expect(nas.checks[0]!.id).toBe("ops-record");
    expect(nas.checks[0]!.reason).toContain("no ssh record");
    expect(nas.checks[0]!.remedy).toContain("crew update nas --host");
    expect(nas.checks[0]!.remedy).toContain("--path");
    // The member's OWN verdict stays red (the card and the terminal must still show it), but this
    // does not need a route to a peer, so it must not disable the lead's own Update button — see
    // `topLevelMemberVerdict`.
    expect(report.verdict).toBe("amber");
  });

  test("ops-record: a lead with one peer lacking an ops record is amber at the top and exits 0", async () => {
    const h = harness({ store: lead(["nas"]) });
    const report = await preflight(h.deps);
    const nas = report.crew![0]!;
    // The member's own ops-record check stays red with its remedy — the card still shows it.
    expect(nas.checks[0]!.id).toBe("ops-record");
    expect(nas.checks[0]!.verdict).toBe("red");
    expect(nas.verdict).toBe("red");
    // But the top-level verdict is amber: updating the lead needs no route to this peer.
    expect(report.verdict).toBe("amber");
    expect(await cmdUpdateCheck(h.deps, ["--json"])).toBe(EXIT.OK);
  });

  test("ops-record: a lead with an unreachable peer still yields red and exits 1", async () => {
    const h = harness({ store: lead(["nas"]), ops: { nas: record() }, remote: () => () => NOT_SPAWNED });
    const report = await preflight(h.deps);
    const nas = report.crew![0]!;
    expect(nas.checks[0]!.id).toBe("reachable");
    expect(nas.verdict).toBe("red");
    expect(report.verdict).toBe("red");
    expect(await cmdUpdateCheck(h.deps, ["--json"])).toBe(EXIT.FAIL);
  });

  test("an unreachable member is red and names the host", async () => {
    const report = await preflight(
      harness({ store: lead(["nas"]), ops: { nas: record() }, remote: () => () => NOT_SPAWNED }).deps,
    );
    const nas = report.crew![0]!;
    expect(nas.verdict).toBe("red");
    expect(nas.checks[0]!.id).toBe("reachable");
    expect(nas.checks[0]!.reason).toContain("nas.local");
  });

  test("a member with no Collie at the recorded path is red", async () => {
    const report = await preflight(
      harness({
        store: lead(["nas"]),
        ops: { nas: record() },
        remote: () => (script) => (script.includes("update --check") ? ok("") : ok(probeOut({ checkout: "" }))),
      }).deps,
    );
    const nas = report.crew![0]!;
    expect(nas.verdict).toBe("red");
    expect(nas.checks.map((c) => c.id)).toEqual(["reachable", "collie-present"]);
    expect(nas.checks[1]!.reason).toContain("/home/pat/collie");
  });

  test("an override beats the record: the walk probes the path this run was given", async () => {
    // A stale record used to fail the gate before `collie crew update <member> --path …` was read,
    // so the red's remedy could never clear it. The walk takes the override, and the record's path
    // is not even mentioned.
    const h = harness({
      store: lead(["nas"]),
      ops: { nas: record({ path: "/home/pat/apps/collie-v1" }) },
      remote: () => (script) =>
        script.includes("/opt/collie") ? ok(probeOut()) : ok(probeOut({ checkout: "" })),
    });
    const report = await preflight(h.deps, { overrides: { nas: { path: "/opt/collie" } } });
    const nas = report.crew![0]!;
    expect(nas.checks.map((c) => c.id)).toContain("collie-present");
    expect(nas.verdict).not.toBe("red");
  });

  test("an override names its own path in the red, not the stale record's", async () => {
    const h = harness({
      store: lead(["nas"]),
      ops: { nas: record({ path: "/home/pat/apps/collie-v1" }) },
      remote: () => (script) => (script.includes("update --check") ? ok("") : ok(probeOut({ checkout: "" }))),
    });
    const report = await preflight(h.deps, { overrides: { nas: { sshHost: "nas.new", path: "/opt/collie" } } });
    const nas = report.crew![0]!;
    expect(nas.host).toBe("nas.new");
    expect(nas.checks[1]!.id).toBe("collie-present");
    expect(nas.checks[1]!.reason).toContain("/opt/collie");
    expect(nas.checks[1]!.reason).not.toContain("collie-v1");
  });

  test("a healthy member merges its own remote checks in, and its runner is closed", async () => {
    const remoteReport: PreflightReport = {
      schema: PREFLIGHT_SCHEMA,
      verdict: "green",
      checks: [{ id: "disk", verdict: "green", reason: "9.0 GB free at /home/pat/collie" }],
    };
    const h = harness({
      store: lead(["nas"]),
      ops: { nas: record() },
      remote: () => (script) =>
        script.includes("update --check") ? ok(JSON.stringify(remoteReport)) : ok(probeOut()),
    });
    const report = await preflight(h.deps);
    const nas = report.crew![0]!;
    expect(nas.host).toBe("nas.local");
    expect(nas.checks.map((c) => c.id)).toEqual(["reachable", "collie-present", "version", "disk"]);
    expect(nas.verdict).toBe("green");
    expect(report.verdict).toBe("green");
    expect(h.runners.get("nas.local")!.closed).toBe(1);
  });

  test("a remote red rolls up into the lead's own verdict", async () => {
    const remoteReport: PreflightReport = {
      schema: PREFLIGHT_SCHEMA,
      verdict: "red",
      checks: [{ id: "tree", verdict: "red", reason: "uncommitted changes to tracked files: web/src/app.tsx" }],
    };
    const h = harness({
      store: lead(["nas"]),
      ops: { nas: record() },
      remote: () => (script) =>
        script.includes("update --check") ? { ...ok(JSON.stringify(remoteReport)), code: 1 } : ok(probeOut()),
    });
    const report = await preflight(h.deps);
    expect(report.crew![0]!.verdict).toBe("red");
    expect(report.verdict).toBe("red");
    expect(await cmdUpdateCheck(h.deps, ["--json"])).toBe(EXIT.FAIL);
  });

  test("a peer too old for --check is amber: peer predates preflight", async () => {
    const h = harness({
      store: lead(["nas"]),
      ops: { nas: record() },
      remote: () => (script) =>
        script.includes("update --check")
          ? { code: 2, stdout: "", stderr: "usage: collie …", spawned: true }
          : ok(probeOut()),
    });
    const report = await preflight(h.deps);
    const preflightCheck = report.crew![0]!.checks.find((c) => c.id === "preflight")!;
    expect(preflightCheck.verdict).toBe("amber");
    expect(preflightCheck.reason).toContain("peer predates preflight");
    expect(report.verdict).toBe("amber");
    expect(await cmdUpdateCheck(h.deps, ["--json"])).toBe(EXIT.OK);
  });

  test("skew is amber, never red (CREW_PROTOCOL §7.1)", () => {
    expect(skewCheck("1.0.0", "1.0.0").verdict).toBe("green");
    const skewed = skewCheck("0.32.0", "1.0.0");
    expect(skewed.verdict).toBe("amber");
    expect(skewed.reason).toContain("0.32.0");
    expect(skewed.reason).toContain("1.0.0");
    expect(skewCheck("", "1.0.0").verdict).toBe("amber");
  });

  test("a peer runs no crew checks — it leads nobody", async () => {
    const report = await preflight(harness({ store: peerStore() }).deps);
    expect(report.crew).toBeUndefined();
  });
});

describe("preflight --local — the answer the phone's card reads", () => {
  const lead = (peers: string[]): TrustStoreData => leadStore({ peers: peers.map((id) => member({ memberId: id })) });

  test("the members are not walked at all, and the report carries no crew", async () => {
    const h = harness({ store: lead(["nas"]), ops: { nas: record() }, remote: () => () => NOT_SPAWNED });
    const report = await preflight(h.deps, { local: true });
    expect(report.crew).toBeUndefined();
    // No ssh was opened: the walk is skipped, never run and discarded.
    expect(h.runners.size).toBe(0);
  });

  test("a peer this lead cannot reach never refuses the lead's own update (ADR 0016)", async () => {
    const h = harness({ store: lead(["nas"]), ops: { nas: record() }, remote: () => () => NOT_SPAWNED });
    // Without --local the same crew turns the whole report red.
    expect((await preflight(h.deps)).verdict).toBe("red");
    const local = await preflight(h.deps, { local: true });
    expect(local.verdict).toBe("green");
    expect(local.verdict).toBe(worst(local.checks.map((c) => c.verdict)));
  });

  test("`--local` is the flag, and the terminal's default is unchanged", async () => {
    expect(wantsLocal(["--check", "--local"])).toBe(true);
    expect(wantsLocal(["--check", "--json"])).toBe(false);
    const h = harness({ store: lead(["nas"]), ops: { nas: record() }, remote: () => () => NOT_SPAWNED });
    expect(await cmdUpdateCheck(h.deps, ["--check", "--local", "--json"])).toBe(EXIT.OK);
    expect(parseReport(h.io.stdout.join("\n"))!.crew).toBeUndefined();
    const terminal = harness({ store: lead(["nas"]), ops: { nas: record() }, remote: () => () => NOT_SPAWNED });
    expect(await cmdUpdateCheck(terminal.deps, ["--check", "--json"])).toBe(EXIT.FAIL);
    expect(parseReport(terminal.io.stdout.join("\n"))!.crew).toHaveLength(1);
  });

  test("a red on this instance is still a red under --local", async () => {
    const h = harness({ store: lead(["nas"]), answers: [["df -Pk", { stdout: df(1000) }]] });
    expect((await preflight(h.deps, { local: true })).verdict).toBe("red");
  });
});

describe("the JSON contract", () => {
  test("check json — the document is versioned and every check is an object", async () => {
    const h = harness();
    const code = await cmdUpdateCheck(h.deps, ["--json"]);
    expect(code).toBe(EXIT.OK);
    const doc = parseReport(h.io.stdout.join("\n"))!;
    expect(doc.schema).toBe(1);
    expect(doc.verdict).toBe("green");
    for (const c of doc.checks) {
      expect(c.id.length).toBeGreaterThan(0);
      expect(["green", "amber", "red"]).toContain(c.verdict);
      expect(c.reason.length).toBeGreaterThan(0);
    }
    // Nothing else on stdout: a script reads this stream whole.
    expect(h.io.stdout).toHaveLength(1);
  });

  test("a schema this build does not know is not a report", () => {
    expect(parseReport('{"schema":2,"verdict":"green","checks":[]}')).toBeNull();
    expect(parseReport("collie: unknown flag --check")).toBeNull();
    expect(parseReport('{"schema":1,"verdict":"puce","checks":[]}')).toBeNull();
    expect(parseReport('{"schema":1,"checks":[]}')).toBeNull();
  });

  // REMOVE_IN_1_9_0: this document is printed by a MEMBER, over ssh, and during the roll that member
  // may still be on 1.7.0 — which spells the crew rows `pack`. Read under both names, written under
  // `crew` alone.
  test("a member still on 1.7.0 spells the rows `pack`, and they are read as `crew`", () => {
    const rows = [{ memberId: "nas", host: "nas.local", verdict: "red", checks: [] }];
    const old = parseReport(JSON.stringify({ schema: 1, verdict: "red", checks: [], pack: rows }))!;
    expect(old.crew).toHaveLength(1);
    expect(old.crew![0]!.memberId).toBe("nas");
    // The new spelling reads the same, and a document carrying both takes `crew`.
    const fresh = parseReport(JSON.stringify({ schema: 1, verdict: "red", checks: [], crew: rows }))!;
    expect(fresh.crew).toHaveLength(1);
    const both = parseReport(
      JSON.stringify({ schema: 1, verdict: "red", checks: [], crew: rows, pack: [] }),
    )!;
    expect(both.crew).toHaveLength(1);
  });

  test("exit code — 0 with no red, 1 with one", async () => {
    expect(await cmdUpdateCheck(harness().deps, ["--json"])).toBe(EXIT.OK);
    const failing = harness({ answers: [["df -Pk", { stdout: df(1000) }]] });
    expect(await cmdUpdateCheck(failing.deps, ["--json"])).toBe(EXIT.FAIL);
  });

  test("red names — no red in this suite carries a generic message", async () => {
    const reds: PreflightCheck[] = [];
    for (const h of [
      harness({ answers: [["df -Pk", { stdout: df(1000) }]] }),
      harness({ answers: [[`${GIT} status --porcelain --untracked-files=no`, { stdout: " M cli/x.ts\n" }]] }),
      harness({ answers: [[`${GIT} ls-remote --tags`, { code: 128 }]] }),
      harness({ findings: [{ check: "bind", status: "error", detail: "d", remedy: "r" }] }),
    ]) {
      const report = await preflight(h.deps);
      reds.push(...report.checks.filter((c) => c.verdict === "red"));
    }
    expect(reds.length).toBeGreaterThanOrEqual(4);
    for (const r of reds) {
      expect(r.reason.length).toBeGreaterThan(20);
      expect(r.reason).not.toBe("failed");
      expect(r.remedy).toBeDefined();
    }
  });
});

describe("the human output", () => {
  test("one line per check, doctor's layout, with the remedy closing it", async () => {
    const h = harness({ answers: [["df -Pk", { stdout: df(1000) }]] });
    await cmdUpdateCheck(h.deps, []);
    const lines = h.io.stdout;
    expect(lines[0]).toBe("collie update --check — red");
    expect(lines.filter((l) => l.includes("✓")).length).toBeGreaterThan(0);
    const disk = lines.find((l) => l.includes("disk"))!;
    expect(disk).toContain("red:");
    expect(disk).toContain("→");
  });

  test("member row names the install kind", async () => {
    const lead = (): TrustStoreData => leadStore({ peers: [member({ memberId: "nas" })] });
    const base: PreflightReport = {
      schema: PREFLIGHT_SCHEMA,
      verdict: "green",
      checks: [{ id: "disk", verdict: "green", reason: "9.0 GB free at /home/pat/collie" }],
    };
    // A member that names no kind is exactly what one older than the field puts on the wire.
    const remoteReport = (installKind?: InstallKind["kind"]): PreflightReport =>
      installKind === undefined ? base : { ...base, installKind };
    const rowFor = async (installKind?: InstallKind["kind"]): Promise<string> => {
      const h = harness({
        store: lead(),
        ops: { nas: record() },
        remote: () => (script) =>
          script.includes("update --check") ? ok(JSON.stringify(remoteReport(installKind))) : ok(probeOut()),
      });
      await cmdUpdateCheck(h.deps, []);
      return h.io.stdout.find((l) => l.startsWith("  nas ("))!;
    };

    // The kind closes the row, so the operator sees which machines a package manager owns.
    expect(await rowFor("packaged")).toBe("  nas (nas.local) — green · packaged");
    expect(await rowFor("binary")).toBe("  nas (nas.local) — green · binary");
    // A member that named no kind renders exactly as it did before the field existed.
    expect(await rowFor()).toBe("  nas (nas.local) — green");
  });

  test("colour paints the verdict only, and only when asked", () => {
    const check: PreflightCheck = { id: "disk", verdict: "red", reason: "no room" };
    expect(checkLine(check, false)).not.toContain("");
    expect(checkLine(check, true)).toContain("[31m");
    expect(checkLine(check, true)).toContain("no room");
  });

  test("worst is the summary rule", () => {
    expect(worst([])).toBe("green");
    expect(worst(["green", "amber"])).toBe("amber");
    expect(worst(["amber", "red", "green"])).toBe("red");
  });
});

describe("the dispatcher", () => {
  test("`update --check` routes to the preflight and never to cmdUpdate", async () => {
    const update = COMMANDS.find((c) => c.name === "update")!;
    expect(wantsCheck(["--check"])).toBe(true);
    expect(wantsCheck(["--json"])).toBe(false);
    // The verb's body is asserted structurally rather than run: `cmdUpdate` would reach a real
    // context, a real checkout and a real service manager, and no test in this tree may do that.
    expect(update.run.toString()).toContain("wantsCheck");
    expect(update.run.toString()).toContain("cmdUpdateCheck");
    expect(update.summary).toContain("--check");
  });
});

// ── An install whose updates are not Collie's to make ────────────────────────
// The shape that started this: `herdr plugin install` leaves a git checkout, so `buildsFromSource`
// said yes, so the phone asked for Bun on a host whose service could not see it. A packaged install
// is the honest end of that thread — nothing here compiles, and nothing here is even writable.

describe("preflight — a folder a package manager owns", () => {
  /** A Collie in a folder a package manager owns, with a release listing that answers. */
  function packaged(over: Parameters<typeof harness>[0] = {}) {
    const h = harness({
      answers: [[`${GIT} rev-parse --git-dir`, { code: 128 }]],
      net: {
        ...deadNet,
        getJson: () => Promise.resolve({ ok: true, value: [{ name: "v1.0.0", commit: { sha: "cccccccc" } }] }),
      },
      ...over,
    });
    h.files.rootOwned.add(ROOT);
    return h;
  }

  test("the list is shorter, and every omission is a fact", async () => {
    // No bun: nothing compiles. No tree: there is no working tree. No disk: the floor exists for a
    // staged payload, and a red over free space nobody can act on is worse than no line at all.
    const report = await preflight(packaged().deps);
    expect(report.checks.map((c) => c.id)).toEqual(["doctor", "package", "upstream", "service"]);
  });

  test("bun is never asked about, even when it is genuinely missing", async () => {
    const report = await preflight(packaged({ absent: ["bun"] }).deps);
    expect(report.checks.some((c) => c.id === "bun")).toBe(false);
    expect(report.verdict).not.toBe("red");
  });

  test("the `package` check says why the others are absent, in one sentence", async () => {
    const check = byId(await preflight(packaged().deps), "package");
    expect(check.verdict).toBe("green");
    expect(check.reason).toBe("updates come from your package manager");
    // `/opt/collie` is where `collie-bin` installs, so the command is named beside the sentence.
    expect(check.remedy).toBe("sudo pacman -Syu collie-bin");
  });

  test("a root no manager claims gets the sentence and no command", async () => {
    // The other half of the same rule: an unrecognised prefix costs the operator a command, never a
    // wrong kind, and Collie never invents one it cannot run.
    const NAMELESS = "/srv/collie";
    const h = packaged({ answers: [[`git -C ${NAMELESS} rev-parse --git-dir`, { code: 128 }]] });
    h.files.entries.set(`${NAMELESS}/herdr-plugin.toml`, { text: 'id = "herdr.collie"\nversion = "1.0.0"\n' });
    const check = byId(await preflight({ ...h.deps, ctx: { ...h.deps.ctx, root: NAMELESS } }), "package");
    expect(check.verdict).toBe("green");
    expect(check.reason).toBe("updates come from your package manager");
    expect(check.remedy).toBeUndefined();
  });

  test("the report names the kind, which is what the crew flow branches on", async () => {
    expect((await preflight(packaged().deps)).installKind).toBe("packaged");
  });

  test("a prefix we publish to names its command, on the check and on the upstream remedy", async () => {
    // The prefix is NOT what decided the kind — clause 4 did, before this runs. It only chooses the
    // words, which is why an unrecognised prefix costs a command and never a misclassification.
    const AUR = "/usr/lib/collie";
    const h = packaged({
      installed: "1.0.0",
      answers: [[`git -C ${AUR} rev-parse --git-dir`, { code: 128 }]],
      net: {
        ...deadNet,
        getJson: () =>
          Promise.resolve({
            ok: true,
            value: [
              { name: "v1.0.0", commit: { sha: "cccccccc" } },
              { name: "v2.0.0", commit: { sha: "dddddddd" } },
            ],
          }),
      },
    });
    h.files.entries.set(`${AUR}/herdr-plugin.toml`, { text: 'id = "herdr.collie"\nversion = "1.0.0"\n' });
    const report = await preflight({ ...h.deps, ctx: { ...h.deps.ctx, root: AUR } });
    expect(byId(report, "package").remedy).toBe("sudo pacman -Syu collie-bin");
    expect(byId(report, "upstream").remedy).toBe("sudo pacman -Syu collie-bin");
  });

  test("an upstream remedy never tells this install to run `collie update`", async () => {
    // A major sitting above the installed version is the case that carries a remedy, and its default
    // wording is `collie update --major` — the one command this install must not run.
    const h = packaged({
      installed: "1.0.0",
      net: {
        ...deadNet,
        getJson: () =>
          Promise.resolve({
            ok: true,
            value: [
              { name: "v1.0.0", commit: { sha: "cccccccc" } },
              { name: "v2.0.0", commit: { sha: "dddddddd" } },
            ],
          }),
      },
    });
    const check = byId(await preflight(h.deps), "upstream");
    // Replaced by the package manager's own command, never by prose: a remedy is the one command
    // that clears a check, not a paragraph pretending to be one.
    expect(check.remedy).toBe("sudo pacman -Syu collie-bin");
    expect(check.remedy).not.toContain("collie update");
    expect(check.selfUpdateRemedy).toBeUndefined();
    // The REASON is untouched: that a release exists is true however it gets applied.
    expect(check.reason).toContain("2.0.0");
  });

  test("a remedy that has nothing to do with `collie update` is left ALONE", async () => {
    // The regression this pins. The first cut replaced EVERY upstream remedy, so an offline
    // packaged host was told to run its package manager instead of "check this machine's network" —
    // and because that check is red, the clobbered sentence became the blocking reason the phone
    // displayed, hiding the real fault behind advice that fixes nothing.
    const h = packaged({
      net: {
        ...deadNet,
        getJson: () => Promise.resolve({ ok: false, failure: { status: null, message: "no route to host" } }),
      },
    });
    const check = byId(await preflight(h.deps), "upstream");
    expect(check.verdict).toBe("red");
    expect(check.remedy).toContain("network");
    expect(check.remedy).not.toContain("package manager");
  });

  test("the rate-limit remedy survives too — same rule, different sentence", async () => {
    const h = packaged({
      net: {
        ...deadNet,
        getJson: () => Promise.resolve({ ok: false, failure: { status: 429, message: "rate limited" } }),
      },
    });
    const check = byId(await preflight(h.deps), "upstream");
    expect(check.remedy).toContain("wait an hour");
  });
});
