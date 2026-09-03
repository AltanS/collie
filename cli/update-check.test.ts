import { describe, expect, test } from "bun:test";

import { leadStore, member, peerStore } from "../bridge/pack/fixtures.ts";
import type { OpsRecord } from "../bridge/pack/ops-store.ts";
import type { TrustStoreData } from "../bridge/pack/trust-store.ts";
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
import type { Finding } from "./finding.ts";
import { EXIT } from "./io.ts";
import { COMMANDS } from "./program.ts";
import type { RemoteResult, RemoteRunner } from "./remote.ts";
import type { Net } from "./sys.ts";
import { unitFilePath } from "./unit.ts";
import {
  bunCheck,
  checkLine,
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
  [`${GIT} ls-remote --tags origin`, { stdout: LS_REMOTE }],
  [`${GIT} rev-parse HEAD`, { stdout: "cccccccc\n" }],
  ["df -Pk", { stdout: df(50_000_000) }],
  ["bun --version", { stdout: "1.3.14\n" }],
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
    expect(report.pack).toBeUndefined();
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
    const check = bunCheck(harness({ answers: [["bun --version", { stdout: "1.1.0\n" }]] }).deps);
    expect(check.verdict).toBe("amber");
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
          [`${GIT} ls-remote --tags origin`, { stdout: "a1a1a1a1\trefs/tags/v0.31.1\nb2b2b2b2\trefs/tags/v0.32.0\n" }],
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
    const report = await preflight(harness({ answers: [[`${GIT} ls-remote --tags origin`, { stdout: LS_REMOTE_WITH_MAJOR }]] }).deps);
    const check = byId(report, "upstream");
    expect(check.verdict).toBe("amber");
    expect(check.reason).toContain("NEW MAJOR");
    expect(check.remedy).toContain("--major");
    expect(report.verdict).toBe("amber");
  });

  test("an unreachable remote is red and says so", async () => {
    const check = byId(
      await preflight(harness({ answers: [[`${GIT} ls-remote --tags origin`, { code: 128, stderr: "could not read" }]] }).deps),
      "upstream",
    );
    expect(check.verdict).toBe("red");
    expect(check.reason).toContain("did not answer");
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

describe("preflight pack — the members of a lead", () => {
  const lead = (peers: string[]): TrustStoreData => leadStore({ peers: peers.map((id) => member({ memberId: id })) });

  test("a member with no ops record is red, with a remedy naming host and path", async () => {
    const report = await preflight(harness({ store: lead(["nas"]) }).deps);
    expect(report.pack).toHaveLength(1);
    const nas = report.pack![0]!;
    expect(nas.memberId).toBe("nas");
    expect(nas.verdict).toBe("red");
    expect(nas.checks[0]!.id).toBe("ops-record");
    expect(nas.checks[0]!.reason).toContain("no ssh record");
    expect(nas.checks[0]!.remedy).toContain("pack update nas --host");
    expect(nas.checks[0]!.remedy).toContain("--path");
    // The member's OWN verdict stays red (the card and the terminal must still show it), but this
    // does not need a route to a peer, so it must not disable the lead's own Update button — see
    // `topLevelMemberVerdict`.
    expect(report.verdict).toBe("amber");
  });

  test("ops-record: a lead with one peer lacking an ops record is amber at the top and exits 0", async () => {
    const h = harness({ store: lead(["nas"]) });
    const report = await preflight(h.deps);
    const nas = report.pack![0]!;
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
    const nas = report.pack![0]!;
    expect(nas.checks[0]!.id).toBe("reachable");
    expect(nas.verdict).toBe("red");
    expect(report.verdict).toBe("red");
    expect(await cmdUpdateCheck(h.deps, ["--json"])).toBe(EXIT.FAIL);
  });

  test("an unreachable member is red and names the host", async () => {
    const report = await preflight(
      harness({ store: lead(["nas"]), ops: { nas: record() }, remote: () => () => NOT_SPAWNED }).deps,
    );
    const nas = report.pack![0]!;
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
    const nas = report.pack![0]!;
    expect(nas.verdict).toBe("red");
    expect(nas.checks.map((c) => c.id)).toEqual(["reachable", "collie-present"]);
    expect(nas.checks[1]!.reason).toContain("/home/pat/collie");
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
    const nas = report.pack![0]!;
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
    expect(report.pack![0]!.verdict).toBe("red");
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
    const preflightCheck = report.pack![0]!.checks.find((c) => c.id === "preflight")!;
    expect(preflightCheck.verdict).toBe("amber");
    expect(preflightCheck.reason).toContain("peer predates preflight");
    expect(report.verdict).toBe("amber");
    expect(await cmdUpdateCheck(h.deps, ["--json"])).toBe(EXIT.OK);
  });

  test("skew is amber, never red (PACK_PROTOCOL §7.1)", () => {
    expect(skewCheck("1.0.0", "1.0.0").verdict).toBe("green");
    const skewed = skewCheck("0.32.0", "1.0.0");
    expect(skewed.verdict).toBe("amber");
    expect(skewed.reason).toContain("0.32.0");
    expect(skewed.reason).toContain("1.0.0");
    expect(skewCheck("", "1.0.0").verdict).toBe("amber");
  });

  test("a peer runs no pack checks — it leads nobody", async () => {
    const report = await preflight(harness({ store: peerStore() }).deps);
    expect(report.pack).toBeUndefined();
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
      harness({ answers: [[`${GIT} ls-remote --tags origin`, { code: 128 }]] }),
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
