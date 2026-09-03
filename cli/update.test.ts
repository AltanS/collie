import { describe, expect, test } from "bun:test";

import {
  BINARY,
  capture,
  STATE,
  context,
  type FakeExec,
  fakeExec,
  type FakeFiles,
  fakeFiles,
  type FakeLinkFs,
  fakeLinkFs,
  HOME,
  ROOT,
  type Scripted,
  type SeededFiles,
} from "./fakes.ts";
import type { Net } from "./sys.ts";
import { parseUpdateRun, STALE_AFTER_MS, UPDATE_RUN_SCHEMA } from "../bridge/update-run.ts";
import {
  boundTail,
  healthTimeoutMs,
  idleRun,
  launchPlan,
  lockVerdict,
  LOG_TAIL_LINES,
  REDACTED,
  reduce,
  scrubSecrets,
} from "./update-run.ts";
import { EXIT } from "./io.ts";
import type { JsonObject } from "../bridge/json.ts";
import { latestUpdateInMajor } from "../bridge/update.ts";
import {
  type ApplyArgs,
  applyArgv,
  checkoutLayout,
  cmdApplyUpdate,
  cmdUpdate,
  isManagedCheckout,
  majorVerdict,
  nextMajorRelease,
  parseApiTags,
  parseRemoteTags,
  planToTag,
  planUpdate,
  platformId,
  pruneVersions,
  refreshRegistry,
  releaseInMajor,
  trainInMajor,
  updateCheckout,
  type UpdateDeps,
  wantsMajor,
  wantsRunId,
  wantsToTag,
} from "./update.ts";

// `update` against fakes. The shell suite proves the git grammar against REAL throwaway repos
// (scripts/collie-cli.test.sh) — what is proved here is the branching: one predicate, two strategies,
// the target selection that keeps a routine update inside its major (ADR 0020), and the rule that a
// managed checkout is never re-linked.

const GIT = `git -C ${ROOT}`;
const DIST = `${ROOT}/web/dist`;

// `git ls-remote --tags origin` as the remote actually answers: an ANNOTATED tag appears twice, and
// the peeled (`^{}`) line is the one naming a commit. `nightly` is the ref the anchor must drop;
// `v1.1.0-rc.1` is parsed but reachable only by an install that is itself on a major-1 prerelease.
const LS_REMOTE = [
  "a1a1a1a1\trefs/tags/v0.31.1",
  "b2b2b2b2\trefs/tags/v0.32.0",
  "b2peeled\trefs/tags/v0.32.0^{}",
  "cccccccc\trefs/tags/v1.0.0",
  "dddddddd\trefs/tags/v1.1.0-rc.1",
  "eeeeeeee\trefs/tags/nightly",
  "",
].join("\n");
/** The same remote before v1.0.0 was ever tagged. */
const ONLY_0X = "a1a1a1a1\trefs/tags/v0.31.1\nb2peeled\trefs/tags/v0.32.0\n";
/** A remote mid-beta-train: the 1.x line exists only as prereleases. */
const BETA_TRAIN = [
  "a1a1a1a1\trefs/tags/v0.32.0",
  "b9b9b9b9\trefs/tags/v1.0.0-beta.9",
  "c0c0c0c0\trefs/tags/v1.0.0-beta.10",
  "",
].join("\n");
/** The same train once v1.0.0 was cut. */
const TRAIN_DONE = `${BETA_TRAIN}d0d0d0d0\trefs/tags/v1.0.0\n`;

interface Harness {
  deps: UpdateDeps;
  io: ReturnType<typeof capture>;
  exec: FakeExec;
  files: FakeFiles;
  link: FakeLinkFs;
  restarts: number;
}

// The detached updater's three new seams (M15/04), faked once for every harness in this file: a
// clock a test moves by sleeping, a sleep that moves it, and a pid the fake process table does not
// know — so a lock this suite writes always reads as "the updater is gone".
export const FAKE_PID = 4242;
/** The release every checkout fixture in this file updates TO — what its health gate expects back. */
const STAGED_TARGET = "0.32.0";
let NOW = 1_700_000_000_000;
const clock = () => ({
  now: () => NOW,
  sleep: (ms: number) => {
    NOW += ms;
    return Promise.resolve();
  },
  pid: FAKE_PID,
  execPath: BINARY,
});

/** A `Net` that reaches nothing: every case scripts the two GETs it expects. */
const deadNet: Net = {
  getJson: () => Promise.resolve({ ok: false, failure: { status: null, message: "no network in tests" } }),
  download: () => Promise.resolve({ ok: false, failure: { status: null, message: "no network in tests" } }),
  probe: () => Promise.resolve({ ok: false, failure: { status: null, message: "no network in tests" } }),
};

/** `git symbolic-ref -q HEAD` answering non-zero is what "detached, i.e. Herdr-managed" means. */
const MANAGED: Scripted["answers"] = [[`${GIT} symbolic-ref -q HEAD`, { code: 1 }]];
/** What `git remote get-url origin` answers on a checkout of Collie itself. Every case needs one:
 *  `update` refuses to fetch a remote that is not the configured update source, so a fixture with no
 *  origin would be refused before it reached the strategy under test. */
const ORIGIN: NonNullable<Scripted["answers"]> = [
  [`${GIT} remote get-url origin`, { stdout: "https://github.com/AltanS/collie.git\n" }],
];
const LINKED: Scripted["answers"] = [[`${GIT} symbolic-ref -q HEAD`, { code: 0, stdout: "refs/heads/main\n" }]];
const SHALLOW: Scripted["answers"] = [
  [`${GIT} rev-parse --is-shallow-repository`, { stdout: "true\n" }],
];
const FULL: Scripted["answers"] = [
  [`${GIT} rev-parse --is-shallow-repository`, { stdout: "false\n" }],
];

function harness(
  over: Partial<
    Scripted & {
      env: Record<string, string | undefined>;
      restart: number;
      /** The version in the checkout's `herdr-plugin.toml` — where the installed MAJOR is read from. */
      installed: string;
      /** What `/api/health` answers the detached runner's gate, in order. */
      health: readonly HealthReply[];
    }
  > = {},
): Harness {
  const io = capture();
  const exec = fakeExec({ ...over, answers: [...(over.answers ?? []), ...ORIGIN] });
  const seed: SeededFiles = { [`${DIST}/index.html`]: "OLD", [BINARY]: "OLD BINARY" };
  if (over.installed !== undefined) {
    seed[`${ROOT}/herdr-plugin.toml`] = `id = "herdr.collie"\nversion = "${over.installed}"\n`;
  }
  const files = fakeFiles(seed);
  const link = fakeLinkFs();
  const health = healthNet(over.health, STAGED_TARGET);
  const h: Harness = {
    io,
    exec,
    files,
    link,
    restarts: 0,
    deps: {
      ctx: context(over.env ?? {}),
      io,
      exec,
      files,
      link,
      net: { ...deadNet, getJson: (url) => (url.includes("/api/health") ? health() : deadNet.getJson(url)) },
      platform: "linux",
      arch: "x64",
      restart: () => {
        h.restarts++;
        return Promise.resolve(over.restart ?? EXIT.OK);
      },
      ...clock(),
    },
  };
  return h;
}

/** Only the mutating git calls — `runIn` records its cwd, the predicates use `capture`. */
const gitRuns = (exec: FakeExec): string[] =>
  exec.calls.filter((c) => c.startsWith(`${ROOT}$ git `)).map((c) => c.slice(`${ROOT}$ `.length));

describe("one predicate, both decisions", () => {
  test("no branch means Herdr-managed", () => {
    expect(isManagedCheckout(fakeExec({ answers: MANAGED }), ROOT)).toBe(true);
    expect(isManagedCheckout(fakeExec({ answers: LINKED }), ROOT)).toBe(false);
    // git missing entirely reads as managed, and `updateCheckout` refuses before it matters.
    expect(isManagedCheckout(fakeExec({ absent: ["git"] }), ROOT)).toBe(true);
  });
});

// ── Target selection (ADR 0020) ──────────────────────────────────────────────
// Pure over the remote's tag list, so the whole decision is provable without a remote.

describe("parseRemoteTags", () => {
  test("keeps releases AND prereleases, and prefers the peeled commit of an annotated tag", () => {
    expect(parseRemoteTags(LS_REMOTE)).toEqual([
      { tag: "v0.31.1", version: "0.31.1", major: 0, prerelease: null, commit: "a1a1a1a1" },
      // b2peeled, NOT b2b2b2b2: the peeled line is the one that names a commit.
      { tag: "v0.32.0", version: "0.32.0", major: 0, prerelease: null, commit: "b2peeled" },
      { tag: "v1.0.0", version: "1.0.0", major: 1, prerelease: null, commit: "cccccccc" },
      // Parsed and carried — WHO may take it is `planUpdate`'s question, not the parser's.
      { tag: "v1.1.0-rc.1", version: "1.1.0-rc.1", major: 1, prerelease: "rc.1", commit: "dddddddd" },
    ]);
    // A non-version ref is invisible to the verb, exactly as it is to the banner.
    expect(parseRemoteTags("y\trefs/heads/main\n")).toEqual([]);
    expect(parseRemoteTags("")).toEqual([]);
  });

  test("a malformed prerelease ref is dropped, not guessed at", () => {
    const junk = [
      "1\trefs/tags/v1.0.0-",
      "2\trefs/tags/v1.0.0-beta..1",
      "3\trefs/tags/v1.0.0-beta.1/x",
      "4\trefs/tags/release-v1.0.0-beta.1",
      "",
    ].join("\n");
    expect(parseRemoteTags(junk)).toEqual([]);
  });
});

describe("releaseInMajor / nextMajorRelease", () => {
  const tags = parseRemoteTags(
    ["1\trefs/tags/v0.32.0", "2\trefs/tags/v1.0.0", "3\trefs/tags/v1.2.0", "4\trefs/tags/v3.0.0"].join("\n"),
  );

  test("the routine target is the highest release inside the installed major", () => {
    expect(releaseInMajor(tags, 1)?.tag).toBe("v1.2.0");
    expect(releaseInMajor(tags, 2)).toBeNull();
  });

  test("releaseInMajor is strict; trainInMajor is the fallback that counts prereleases", () => {
    const train = parseRemoteTags(TRAIN_DONE);
    expect(releaseInMajor(train, 1)?.tag).toBe("v1.0.0");
    expect(trainInMajor(train, 1)?.tag).toBe("v1.0.0"); // the release outranks its own betas
    const mid = parseRemoteTags(BETA_TRAIN);
    expect(releaseInMajor(mid, 1)).toBeNull(); // nothing strict in major 1 yet
    expect(trainInMajor(mid, 1)?.tag).toBe("v1.0.0-beta.10"); // …10 above …9, numerically
  });

  test("--major crosses ONE major at a time — the next one that has a release", () => {
    // Two behind, so the highest available (3.0.0) is deliberately not the target: each crossing is
    // the one the operator consented to, with the release notes that apply to it.
    expect(nextMajorRelease(tags, 0)?.tag).toBe("v1.2.0");
    expect(nextMajorRelease(tags, 1)?.tag).toBe("v3.0.0");
    expect(nextMajorRelease(tags, 3)).toBeNull();
  });
});

describe("planUpdate", () => {
  const tags = parseRemoteTags(LS_REMOTE);
  const plan = (installed: string | null, head: string, crossMajor = false) =>
    planUpdate({ tags, installed, head, crossMajor });

  test("a routine update takes the newest release of its own major and names the one above", () => {
    expect(plan("0.31.1", "a1a1a1a1")).toEqual({
      kind: "advance",
      target: { tag: "v0.32.0", version: "0.32.0", major: 0, prerelease: null, commit: "b2peeled" },
      crossesMajor: false,
      higher: { tag: "v1.0.0", version: "1.0.0", major: 1, prerelease: null, commit: "cccccccc" },
    });
  });

  test("already on the newest release of the major → nothing to do, major still announced", () => {
    const done = plan("0.32.0", "b2peeled");
    expect(done.kind).toBe("current");
    expect(done.kind === "current" && done.higher?.version).toBe("1.0.0");
    // Also "current" by version alone, whatever commit the checkout happens to sit on.
    expect(plan("0.32.0", "somewhere-else").kind).toBe("current");
  });

  test("no tag of the installed major at all (a beta before any 1.x tag) → do nothing", () => {
    // The 0.x tags are not a 1.x install's to take, and its own major has nothing tagged yet.
    expect(
      planUpdate({ tags: parseRemoteTags(ONLY_0X), installed: "1.0.0-beta.5", head: "zzz", crossMajor: false }),
    ).toEqual({ kind: "no-release", major: 1, higher: null });
  });

  test("a STABLE install is offered nothing when only newer prereleases exist", () => {
    // THE regression. `v1.1.0-rc.1` sits above `v1.0.0` in the fixture and must stay invisible here.
    const done = plan("1.0.0", "cccccccc");
    expect(done.kind).toBe("current");
    expect(done.kind === "current" && done.at.tag).toBe("v1.0.0");
  });

  test("a PRERELEASE install takes the train only as a FALLBACK", () => {
    const mid = parseRemoteTags(BETA_TRAIN); // no strict 1.x tag exists yet
    // Fallback: offered the next beta…
    const next = planUpdate({ tags: mid, installed: "1.0.0-beta.9", head: "b9b9b9b9", crossMajor: false });
    expect(next.kind === "advance" && next.target.tag).toBe("v1.0.0-beta.10");
    expect(next.kind === "advance" && next.crossesMajor).toBe(false);
    // …already on the newest beta → nothing to take, and it says so as a train, not as a release.
    const at = planUpdate({ tags: mid, installed: "1.0.0-beta.10", head: "c0c0c0c0", crossMajor: false });
    expect(at.kind).toBe("current");
    expect(at.kind === "current" && at.at.prerelease).toBe("beta.10");
    // Supersede: once v1.0.0 exists it wins, and the beta above the install is skipped entirely.
    const out = planUpdate({
      tags: parseRemoteTags(TRAIN_DONE),
      installed: "1.0.0-beta.9",
      head: "b9b9b9b9",
      crossMajor: false,
    });
    expect(out.kind === "advance" && out.target.tag).toBe("v1.0.0");
  });

  test("a beta install's consent ends at the release — a later minor's rc stays invisible", () => {
    // LS_REMOTE holds v1.0.0 AND v1.1.0-rc.1. A 1.0.0-beta.5 install takes the release, not the rc:
    // the consent taken with a beta was to the road TO its release, not to major 1's prereleases
    // forever. From v1.0.0 on it is a stable install, and blind to the rc like any other.
    const out = plan("1.0.0-beta.5", "zzz");
    expect(out.kind === "advance" && out.target.tag).toBe("v1.0.0");
    expect(out.kind === "advance" && out.crossesMajor).toBe(false);
  });

  test("banner and verb resolve the SAME target from the same inputs", () => {
    // The coupling ADR 0020 relies on: the verb can never land where the banner would not have
    // announced. Both read `bridge/update.ts` — one over ref names, one over parsed tags. The three
    // cases the rule turns on are all in here: fallback, supersede, and consent-ended.
    const sets = [
      ["v0.32.0", "v1.0.0-beta.44", "v1.0.0-beta.45", "nightly"], // fallback: no strict 1.x
      ["v1.0.0-beta.45", "v1.0.0"], // supersede: beta.44 skips beta.45
      ["v0.32.0", "v1.0.0", "v1.1.0-rc.1"], // consent-ended: the rc is invisible
    ];
    for (const names of sets) {
      const tagList = parseRemoteTags(names.map((n, i) => `c${i}\trefs/tags/${n}`).join("\n"));
      for (const installed of ["0.32.0", "1.0.0-beta.5", "1.0.0-beta.44", "1.0.0", "1.1.0-rc.1"]) {
        const major = Number(installed.split(".")[0]);
        const verb = planUpdate({ tags: tagList, installed, head: "nowhere", crossMajor: false });
        const banner = latestUpdateInMajor(names, major, installed);
        const target =
          verb.kind === "advance" ? verb.target.version : verb.kind === "current" ? verb.at.version : null;
        expect(target).toBe(banner);
      }
    }
  });

  test("--major targets the next major; without one, it says so and acts on nothing", () => {
    const cross = plan("0.31.1", "a1a1a1a1", true);
    expect(cross.kind === "advance" && cross.target.tag).toBe("v1.0.0");
    expect(cross.kind === "advance" && cross.crossesMajor).toBe(true);
    expect(plan("1.0.0", "cccccccc", true)).toEqual({ kind: "no-higher-major", major: 1 });
  });

  test("an unreadable version falls back to the newest RELEASE, never to origin HEAD", () => {
    const newest = { tag: "v1.0.0", version: "1.0.0", major: 1, prerelease: null, commit: "cccccccc" };
    expect(plan(null, "zzz")).toEqual({ kind: "unknown-version", newest });
    expect(plan("unknown", "zzz")).toEqual({ kind: "unknown-version", newest });
  });

  test("an unreadable version with no releases on the remote has nothing to pin to", () => {
    expect(planUpdate({ tags: [], installed: null, head: "zzz", crossMajor: false })).toEqual({
      kind: "unknown-version",
      newest: null,
    });
  });
});

describe("majorVerdict / wantsMajor", () => {
  test("compares the fetched manifest against the installed one", () => {
    expect(majorVerdict("0.31.1", "1.0.0")).toBe("crosses");
    expect(majorVerdict("0.31.1", "0.32.0")).toBe("same");
    expect(majorVerdict("1.0.0", "0.32.0")).toBe("same"); // going BACK is not a crossing to gate
    expect(majorVerdict("0.31.1", null)).toBe("unknown");
  });

  test("the flag is the consent, wherever it sits in argv", () => {
    expect(wantsMajor(["--major"])).toBe(true);
    expect(wantsMajor([])).toBe(false);
    expect(wantsMajor(["--plain", "--major"])).toBe(true);
  });
});

describe("updateCheckout", () => {
  /** A managed checkout on 0.31.1 with the tag list above upstream. */
  const managed = (over: Scripted["answers"] = [], installed = "0.31.1") =>
    harness({
      installed,
      answers: [
        ...MANAGED,
        [`${GIT} ls-remote --tags origin`, { stdout: LS_REMOTE }],
        [`${GIT} rev-parse HEAD`, { stdout: "a1a1a1a1\n" }],
        ...SHALLOW,
        [`${GIT} log -1`, { stdout: "abc1234 the newest release\n" }],
        ...over,
      ],
    });

  /**
   * A linked clone on `branch`, whose upstream manifest names `upstreamVersion`. The manifest is
   * answered AT THE UPSTREAM REF, never at the remote's default tip — that distinction is the whole
   * point of the gate (see below).
   */
  const linked = (branch: string, upstreamVersion: string, installed = "0.31.1") =>
    harness({
      installed,
      answers: [
        ...LINKED,
        [`${GIT} rev-parse --abbrev-ref --symbolic-full-name @{u}`, { stdout: `origin/${branch}\n` }],
        [`${GIT} show origin/${branch}:herdr-plugin.toml`, { stdout: `version = "${upstreamVersion}"\n` }],
        // The remote's DEFAULT branch is a major ahead. Reading the gate off it would refuse a pull
        // that never leaves the major — so nothing may ever consult it.
        [`${GIT} show FETCH_HEAD:herdr-plugin.toml`, { stdout: 'version = "9.0.0"\n' }],
      ],
    });

  test("a linked clone fast-forwards its branch, after reading the manifest it would land on", () => {
    const h = linked("main", "0.32.0");
    expect(updateCheckout(h.deps).code).toBe(EXIT.OK);
    // Plain `fetch origin` (the configured refspec), so the remote-tracking ref the pull uses is the
    // one that advanced — `fetch origin HEAD` would only have moved FETCH_HEAD.
    expect(gitRuns(h.exec)).toEqual([`${GIT} fetch origin`, `${GIT} pull --ff-only`]);
    expect(h.io.stdout.join("\n")).toContain("git pull --ff-only");
  });

  test("the gate reads the BRANCH'S OWN upstream, not the remote's default tip", () => {
    // The regression: this repo's own deployment host is a clone on `v1`, and after 1.0 lands on
    // `main` a clone kept on a 0.x maintenance branch would see main's major and refuse a pull that
    // only ever fast-forwards within major 0.
    const h = linked("v0.x", "0.32.0");
    expect(updateCheckout(h.deps).code).toBe(EXIT.OK);
    expect(gitRuns(h.exec)).toEqual([`${GIT} fetch origin`, `${GIT} pull --ff-only`]);
    expect(h.exec.calls).toContain(`${GIT} show origin/v0.x:herdr-plugin.toml`);
    expect(h.exec.calls.some((c) => c.includes("FETCH_HEAD:herdr-plugin.toml"))).toBe(false);
    expect(h.io.stdout.join("\n")).not.toContain("MAJOR");
  });

  test("a linked clone refuses to be pulled across a major, and pulls NOTHING", () => {
    const h = linked("main", "1.0.0");
    expect(updateCheckout(h.deps).code).toBe(EXIT.OK);
    expect(gitRuns(h.exec)).toEqual([`${GIT} fetch origin`]); // fetched to look; never pulled
    expect(h.io.stdout.join("\n")).toContain("crosses a MAJOR version");
    expect(h.io.stdout.join("\n")).toContain("(origin/main)");
    expect(h.io.stdout.join("\n")).toContain("update-major --plugin herdr.collie");
  });

  test("--major lets the same clone through, on its branch and with its ff-only pull", () => {
    const h = linked("main", "1.0.0");
    expect(updateCheckout(h.deps, { crossMajor: true }).code).toBe(EXIT.OK);
    expect(gitRuns(h.exec)).toEqual([`${GIT} fetch origin`, `${GIT} pull --ff-only`]);
  });

  test("a branch with no upstream is left to git: no gate, and the pull reports its own refusal", () => {
    // Nothing to judge and nothing to take — `git pull --ff-only` fails with "no tracking
    // information", which says more about the checkout than we could. A pull that cannot happen
    // cannot cross a major.
    const h = harness({
      installed: "0.31.1",
      answers: [
        ...LINKED,
        [`${GIT} rev-parse --abbrev-ref --symbolic-full-name @{u}`, { code: 128 }],
        [`${ROOT}$ ${GIT} pull`, { code: 1 }],
      ],
    });
    expect(updateCheckout(h.deps).code).toBe(EXIT.FAIL);
    expect(gitRuns(h.exec)).toEqual([`${GIT} fetch origin`, `${GIT} pull --ff-only`]);
    expect(h.exec.calls.some((c) => c.includes("herdr-plugin.toml"))).toBe(false);
  });

  test("a managed checkout detaches onto the newest TAG of its major, shallow and forced", () => {
    const h = managed();
    expect(updateCheckout(h.deps).code).toBe(EXIT.OK);
    // A STORING refspec, not the bare ref: the bare form writes FETCH_HEAD and stores no local tag,
    // after which `vite.config.ts` finds no `refs/tags/v0.32.0` at HEAD and stamps the build `-dev`.
    expect(gitRuns(h.exec)).toEqual([
      `${GIT} fetch --depth 1 origin +refs/tags/v0.32.0:refs/tags/v0.32.0`,
      `${GIT} checkout -q --detach --force FETCH_HEAD`,
    ]);
    expect(h.io.stdout.join("\n")).toContain("detach onto v0.32.0");
    expect(h.io.stdout.join("\n")).toContain("→ now at abc1234 the newest release");
    // The major upstream is named — announced, never taken.
    expect(h.io.stdout.join("\n")).toContain("Collie 1.0.0 is out — a NEW MAJOR");
  });

  test("a managed checkout already on the newest tag of its major moves nothing", () => {
    const h = harness({
      installed: "0.32.0",
      answers: [
        ...MANAGED,
        [`${GIT} ls-remote --tags origin`, { stdout: LS_REMOTE }],
        [`${GIT} rev-parse HEAD`, { stdout: "b2peeled\n" }],
      ],
    });
    expect(updateCheckout(h.deps).code).toBe(EXIT.OK);
    expect(gitRuns(h.exec)).toEqual([]);
    expect(h.io.stdout.join("\n")).toContain("already current");
    expect(h.io.stdout.join("\n")).toContain("update-major --plugin herdr.collie");
  });

  test("--major on a managed checkout detaches onto the next major's tag", () => {
    const h = managed([], "0.31.1");
    expect(updateCheckout(h.deps, { crossMajor: true }).code).toBe(EXIT.OK);
    expect(gitRuns(h.exec)[0]).toBe(`${GIT} fetch --depth 1 origin +refs/tags/v1.0.0:refs/tags/v1.0.0`);
    expect(h.io.stdout.join("\n")).toContain("crossing to Collie 1.0.0");
  });

  test("--major with nothing above the installed major acts on nothing", () => {
    const h = managed([], "1.0.0");
    expect(updateCheckout(h.deps, { crossMajor: true }).code).toBe(EXIT.OK);
    expect(gitRuns(h.exec)).toEqual([]);
    expect(h.io.stdout.join("\n")).toContain("no release above major 1");
  });

  test("a beta checkout takes the RELEASE once it exists, over a newer beta", () => {
    const h = harness({
      installed: "1.0.0-beta.9",
      answers: [
        ...MANAGED,
        [`${GIT} ls-remote --tags origin`, { stdout: TRAIN_DONE }],
        [`${GIT} rev-parse HEAD`, { stdout: "b9b9b9b9\n" }],
        ...SHALLOW,
        [`${GIT} log -1`, { stdout: "d0d0d0d the release\n" }],
      ],
    });
    expect(updateCheckout(h.deps).code).toBe(EXIT.OK);
    // v1.0.0, NOT v1.0.0-beta.10: the release supersedes every beta that led to it.
    expect(gitRuns(h.exec)[0]).toBe(`${GIT} fetch --depth 1 origin +refs/tags/v1.0.0:refs/tags/v1.0.0`);
    expect(h.io.stdout.join("\n")).toContain("detach onto v1.0.0");
  });

  test("a beta checkout detaches onto the next beta tag while its release is unpublished", () => {
    const h = harness({
      installed: "1.0.0-beta.9",
      answers: [
        ...MANAGED,
        [`${GIT} ls-remote --tags origin`, { stdout: BETA_TRAIN }],
        [`${GIT} rev-parse HEAD`, { stdout: "b9b9b9b9\n" }],
        ...SHALLOW,
        [`${GIT} log -1`, { stdout: "c0c0c0c the next beta\n" }],
      ],
    });
    expect(updateCheckout(h.deps).code).toBe(EXIT.OK);
    // A prerelease tag name reaches `refs/tags/` untouched — it is a ref like any other.
    expect(gitRuns(h.exec)).toEqual([
      `${GIT} fetch --depth 1 origin +refs/tags/v1.0.0-beta.10:refs/tags/v1.0.0-beta.10`,
      `${GIT} checkout -q --detach --force FETCH_HEAD`,
    ]);
    expect(h.io.stdout.join("\n")).toContain("detach onto v1.0.0-beta.10");
  });

  test("a beta checkout already on the newest beta names the train, and moves nothing", () => {
    const h = harness({
      installed: "1.0.0-beta.10",
      answers: [
        ...MANAGED,
        [`${GIT} ls-remote --tags origin`, { stdout: BETA_TRAIN }],
        [`${GIT} rev-parse HEAD`, { stdout: "c0c0c0c0\n" }],
      ],
    });
    expect(updateCheckout(h.deps).code).toBe(EXIT.OK);
    expect(gitRuns(h.exec)).toEqual([]);
    expect(h.io.stdout.join("\n")).toContain(
      "already current — v1.0.0-beta.10 is the newest on the major 1 prerelease train.",
    );
    expect(h.io.stdout.join("\n")).not.toContain("no release of major 1 yet");
  });

  test("a stable checkout is never pulled onto a prerelease", () => {
    // v1.1.0-rc.1 is in LS_REMOTE and above v1.0.0. A 1.0.0 install must not see it.
    const h = harness({
      installed: "1.0.0",
      answers: [
        ...MANAGED,
        [`${GIT} ls-remote --tags origin`, { stdout: LS_REMOTE }],
        [`${GIT} rev-parse HEAD`, { stdout: "cccccccc\n" }],
      ],
    });
    expect(updateCheckout(h.deps).code).toBe(EXIT.OK);
    expect(gitRuns(h.exec)).toEqual([]);
    expect(h.io.stdout.join("\n")).toContain("already current — v1.0.0 is the newest release of major 1.");
  });

  test("a major with no tag of its own yet leaves the checkout alone", () => {
    // A 1.0.0-beta install before ANY v1 tag is cut: the 0.x tags are not its to take.
    const h = harness({
      installed: "1.0.0-beta.5",
      answers: [
        ...MANAGED,
        [`${GIT} ls-remote --tags origin`, { stdout: ONLY_0X }],
        [`${GIT} rev-parse HEAD`, { stdout: "zzz\n" }],
      ],
    });
    expect(updateCheckout(h.deps).code).toBe(EXIT.OK);
    expect(gitRuns(h.exec)).toEqual([]);
    expect(h.io.stdout.join("\n")).toContain("no release of major 1 yet");
  });

  test("an unreadable manifest pins to the newest release tag, never to origin HEAD", () => {
    const h = harness({
      answers: [
        ...MANAGED,
        [`${GIT} ls-remote --tags origin`, { stdout: LS_REMOTE }],
        [`${GIT} rev-parse HEAD`, { stdout: "zzz\n" }],
        ...SHALLOW,
        [`${GIT} log -1`, { stdout: "abc1234 tip\n" }],
      ],
    });
    expect(updateCheckout(h.deps).code).toBe(EXIT.OK);
    expect(gitRuns(h.exec)).toEqual([
      `${GIT} fetch --depth 1 origin +refs/tags/v1.0.0:refs/tags/v1.0.0`,
      `${GIT} checkout -q --detach --force FETCH_HEAD`,
    ]);
    expect(h.io.stdout.join("\n")).toContain("pinning to newest release tag v1.0.0");
  });

  test("an unreadable manifest with no releases upstream refuses rather than guess", () => {
    const h = harness({
      answers: [
        ...MANAGED,
        [`${GIT} ls-remote --tags origin`, { stdout: "" }],
        [`${GIT} rev-parse HEAD`, { stdout: "zzz\n" }],
      ],
    });
    expect(updateCheckout(h.deps).code).toBe(EXIT.FAIL);
    expect(gitRuns(h.exec)).toEqual([]);
    expect(h.io.stderr.join("\n")).toContain("no release tags on origin");
  });

  test("--depth 1 ONLY when the repo is already shallow", () => {
    // Otherwise an update would truncate the history of a full clone someone happens to have
    // detached — a destruction the operator never asked for and cannot undo.
    const h = harness({ installed: "0.31.1", answers: [
      ...MANAGED,
      [`${GIT} ls-remote --tags origin`, { stdout: LS_REMOTE }],
      [`${GIT} rev-parse HEAD`, { stdout: "a1a1a1a1\n" }],
      ...FULL,
    ] });
    expect(updateCheckout(h.deps).code).toBe(EXIT.OK);
    // …and the storing refspec rides along on the full-clone variant too.
    expect(gitRuns(h.exec)[0]).toBe(`${GIT} fetch origin +refs/tags/v0.32.0:refs/tags/v0.32.0`);
  });

  test("a non-git checkout names the reinstall command and fails", () => {
    const h = harness({ answers: [[`${GIT} rev-parse --git-dir`, { code: 128 }]] });
    expect(updateCheckout(h.deps).code).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("herdr plugin install AltanS/collie --yes");
    expect(gitRuns(h.exec)).toEqual([]);
  });

  test("an unreachable remote fails before anything moves", () => {
    const h = harness({
      installed: "0.31.1",
      answers: [...MANAGED, [`${GIT} ls-remote --tags origin`, { code: 128 }]],
    });
    expect(updateCheckout(h.deps).code).toBe(EXIT.FAIL);
    expect(gitRuns(h.exec)).toEqual([]);
    expect(h.io.stderr.join("\n")).toContain("could not list the upstream release tags");
  });

  test("a failed fetch stops before the checkout", () => {
    const h = managed([[`${ROOT}$ ${GIT} fetch`, { code: 1 }]]);
    expect(updateCheckout(h.deps).code).toBe(EXIT.FAIL);
    expect(gitRuns(h.exec)).toEqual([`${GIT} fetch --depth 1 origin +refs/tags/v0.32.0:refs/tags/v0.32.0`]);
  });
});

describe("refreshRegistry", () => {
  test("never re-links a Herdr-managed checkout, and says why", () => {
    // `plugin link` re-registers as source.kind=local, after which Herdr REFUSES `plugin install` —
    // the operator's only other way to refresh (ADR 0006).
    const h = harness({ answers: MANAGED });
    refreshRegistry(h.deps);
    expect(h.io.stdout.join("\n")).toContain("registry left alone");
    expect(h.exec.calls.some((c) => c.includes("plugin link"))).toBe(false);
  });

  test("re-links a linked clone", () => {
    const h = harness({ answers: LINKED });
    refreshRegistry(h.deps);
    expect(h.exec.calls).toContain(`herdr plugin link ${ROOT}`);
    expect(h.io.stdout.join("\n")).toContain("re-linked");
  });

  test("is best-effort: no herdr, or a herdr that refuses, never fails the update", () => {
    const none = harness({ absent: ["herdr"], answers: LINKED });
    refreshRegistry(none.deps);
    expect(none.io.stdout).toEqual([]);

    const down = harness({ answers: [...LINKED, ["herdr plugin link", { code: 1 }]] });
    refreshRegistry(down.deps);
    expect(down.io.stdout.join("\n")).toContain(`run: herdr plugin link "${ROOT}"`);
  });
});

describe("_apply-update", () => {
  test("build → restart → refresh registry → ✓", async () => {
    const h = harness({ answers: [...LINKED, ...SHALLOW] });
    expect(await cmdApplyUpdate(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls).toContain(`${ROOT}$ bash ${ROOT}/scripts/check-version.sh`);
    expect(h.restarts).toBe(1);
    expect(h.io.stdout.join("\n")).toContain("✓ update complete");
  });

  test("a failed build does not restart, and says the running service is unchanged", async () => {
    // The checkout has already advanced: this is the skew shape ADR 0006 exists to prevent, and the
    // only safe answer is to swap nothing and say so.
    const h = harness({ answers: [...LINKED, [`${ROOT}/web$ bun run build --`, { code: 1 }]] });
    expect(await cmdApplyUpdate(h.deps)).toBe(EXIT.FAIL);
    expect(h.restarts).toBe(0);
    expect(h.files.entries.get(`${DIST}/index.html`)?.text).toBe("OLD");
    expect(h.io.stderr.join("\n")).toContain("the checkout advanced but the build failed");
    expect(h.io.stdout.join("\n")).not.toContain("update complete");
  });
});

describe("update", () => {
  test("advances the checkout, then hands the rest to the code it just fetched", async () => {
    // The post-advance half MUST run the new build logic, and the new binary does not exist yet —
    // `build` is what produces it. So the handoff re-execs the fetched SOURCE with Bun. This is the
    // MANAGED shape: a linked clone stages instead (M15/02), and ADR 0006's in-place advancement is
    // what a Herdr-managed checkout keeps.
    const h = harness({
      installed: "0.31.1",
      answers: [
        ...MANAGED,
        [`${GIT} ls-remote --tags origin`, { stdout: LS_REMOTE }],
        [`${GIT} rev-parse HEAD`, { stdout: "a1a1a1a1\n" }],
        ...SHALLOW,
      ],
    });
    expect(await cmdUpdate(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls).toContain(`${ROOT}$ bun ${ROOT}/cli/main.ts _apply-update`);
    // Nothing of the second half ran in THIS process.
    expect(h.restarts).toBe(0);
    expect(h.exec.calls.some((c) => c.includes("check-version.sh"))).toBe(false);
  });

  test("a checkout that would not advance never reaches the rebuild", async () => {
    const h = harness({ answers: [[`${GIT} rev-parse --git-dir`, { code: 128 }]] });
    expect(await cmdUpdate(h.deps)).toBe(EXIT.FAIL);
    expect(h.exec.calls.some((c) => c.includes("_apply-update"))).toBe(false);
  });

  test("no Bun: the checkout advanced, and the failure says exactly that", async () => {
    const h = harness({
      absent: ["bun"],
      installed: "0.31.1",
      answers: [
        ...MANAGED,
        [`${GIT} ls-remote --tags origin`, { stdout: LS_REMOTE }],
        [`${GIT} rev-parse HEAD`, { stdout: "a1a1a1a1\n" }],
        ...SHALLOW,
      ],
    });
    expect(await cmdUpdate(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("the checkout advanced, but rebuilding needs Bun");
  });

  // ── Nothing to take + an intact install ⇒ no build, no restart ────────────
  // The verdict alone is NOT the rule. A half-crossed checkout — advanced onto the new tag by an
  // update whose build then failed — reports "already current" on the very re-run the operator was
  // told to make, so the second half of the rule (is there a whole install on disk?) is what keeps
  // that recovery path repairing.

  /** A managed checkout already on the newest tag of major 0, with 1.0.0 published above it. */
  const noop = () =>
    harness({
      installed: "0.32.0",
      answers: [
        ...MANAGED,
        [`${GIT} ls-remote --tags origin`, { stdout: LS_REMOTE }],
        [`${GIT} rev-parse HEAD`, { stdout: "b2peeled\n" }],
      ],
    });
  /** Stamp the built bundle as `version` — what `web/dist/build-info.json` carries after a build. */
  const stamp = (h: Harness, version: string): void =>
    void h.files.entries.set(`${DIST}/build-info.json`, {
      text: JSON.stringify({ version, sha: "ab12cd3" }),
    });
  const built = (h: Harness): boolean => h.exec.calls.some((c) => c.includes("_apply-update"));

  test("nothing to take and the install is intact: no build, no restart, and the verdict stands", async () => {
    const h = noop();
    stamp(h, "0.32.0");
    expect(await cmdUpdate(h.deps)).toBe(EXIT.OK);
    expect(built(h)).toBe(false);
    expect(h.restarts).toBe(0);
    expect(h.io.stdout.join("\n")).toContain("already current");
    // …and the transcript never claims otherwise.
    expect(h.io.stdout.join("\n")).not.toContain("update complete");
  });

  test("a `-dev` stamp is still the same version — the marker is stripped before comparing", async () => {
    // True of every managed install made before the tag fetch started STORING the tag, and of any
    // linked clone built mid-development. It says "not a tagged release", not "a different version".
    const h = noop();
    stamp(h, "0.32.0-dev");
    expect(await cmdUpdate(h.deps)).toBe(EXIT.OK);
    expect(built(h)).toBe(false);
  });

  test("nothing to take but no bin/collie: build anyway — this is the half-crossed checkout", async () => {
    const h = noop();
    stamp(h, "0.32.0");
    h.files.entries.delete(BINARY);
    expect(await cmdUpdate(h.deps)).toBe(EXIT.OK);
    expect(built(h)).toBe(true);
  });

  test("nothing to take but the bundle is of another version: build anyway", async () => {
    const h = noop();
    stamp(h, "0.31.1");
    expect(await cmdUpdate(h.deps)).toBe(EXIT.OK);
    expect(built(h)).toBe(true);
  });

  test("nothing to take and nothing built at all: build anyway", async () => {
    const h = noop(); // no build-info.json seeded
    expect(await cmdUpdate(h.deps)).toBe(EXIT.OK);
    expect(built(h)).toBe(true);
  });

  test("a checkout that MOVED always builds, however intact the old install looked", async () => {
    const h = harness({
      installed: "0.31.1",
      answers: [
        ...MANAGED,
        [`${GIT} ls-remote --tags origin`, { stdout: LS_REMOTE }],
        [`${GIT} rev-parse HEAD`, { stdout: "a1a1a1a1\n" }],
        ...SHALLOW,
      ],
    });
    stamp(h, "0.31.1"); // matches the manifest — the install was whole before the checkout advanced
    expect(await cmdUpdate(h.deps)).toBe(EXIT.OK);
    expect(built(h)).toBe(true);
  });

  test("a linked clone with nothing to take stages nothing — it is the same no-op", async () => {
    // The staged path asks the same second question the in-place one does: a verdict of "already
    // current" ends the verb only when what is on disk is whole. Nothing is fetched, no worktree is
    // added, and an in-place clone is NOT migrated by an update that has nothing to take.
    const h = harness({
      installed: "0.32.0",
      answers: [
        ...LINKED,
        [`${GIT} ls-remote --tags origin`, { stdout: LS_REMOTE }],
        [`${GIT} rev-parse HEAD`, { stdout: "b2peeled\n" }],
      ],
    });
    stamp(h, "0.32.0");
    expect(await cmdUpdate(h.deps)).toBe(EXIT.OK);
    expect(h.io.stdout.join("\n")).toContain("already current");
    expect(gitRuns(h.exec)).toEqual([]);
    expect(built(h)).toBe(false);
  });
  // ── The major notice closes the transcript (F5) ───────────────────────────

  test("the major notice is REPEATED as the last line, after the status block", async () => {
    // It prints early too, where the decision is made — but ~70 lines of build output follow it and
    // the operator reads the tail. This is the notice the whole 1.0 migration depends on.
    const h = harness({
      installed: "0.31.1",
      answers: [
        ...MANAGED,
        [`${GIT} ls-remote --tags origin`, { stdout: LS_REMOTE }],
        [`${GIT} rev-parse HEAD`, { stdout: "a1a1a1a1\n" }],
        ...SHALLOW,
      ],
    });
    expect(await cmdUpdate(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls).toContain(`${ROOT}$ bun ${ROOT}/cli/main.ts _apply-update`);
    // Twice: once at the decision, once at the end.
    expect(h.io.stdout.filter((l) => l.includes("update-major --plugin herdr.collie"))).toHaveLength(2);
    expect(h.io.stdout.at(-1)).toContain("Collie 1.0.0 is out — a NEW MAJOR. Take it with:");
  });

  test("no major above: nothing is appended to the transcript", async () => {
    const h = harness({
      installed: "0.31.1",
      answers: [
        ...MANAGED,
        [`${GIT} ls-remote --tags origin`, { stdout: ONLY_0X }],
        [`${GIT} rev-parse HEAD`, { stdout: "a1a1a1a1\n" }],
        ...SHALLOW,
      ],
    });
    expect(await cmdUpdate(h.deps)).toBe(EXIT.OK);
    expect(h.io.stdout.join("\n")).not.toContain("NEW MAJOR");
  });

  test("a consented crossing does not advertise the release it just took", async () => {
    const h = harness({
      installed: "0.31.1",
      answers: [
        ...MANAGED,
        [`${GIT} ls-remote --tags origin`, { stdout: LS_REMOTE }],
        [`${GIT} rev-parse HEAD`, { stdout: "a1a1a1a1\n" }],
        ...SHALLOW,
      ],
    });
    expect(await cmdUpdate(h.deps, ["--major"])).toBe(EXIT.OK);
    expect(h.io.stdout.join("\n")).toContain("crossing to Collie 1.0.0");
    expect(h.io.stdout.join("\n")).not.toContain("NEW MAJOR");
  });

});

// ── The fork guard (M14/02 amendment §1) ─────────────────────────────────────
// `update` talks to a hardcoded `origin` and one of its two strategies force-checks-out onto that
// remote's tags. On a fork that discards local work — measured on youngsecurity/collie at
// 0.35.0+ys.2 — so the remote is asserted BEFORE anything is fetched.

describe("the origin assertion", () => {
  const forked: Scripted["answers"] = [
    [`${GIT} remote get-url origin`, { stdout: "git@github.com:youngsecurity/collie.git\n" }],
  ];

  test("a fork's origin is refused before any fetch, and the refusal names the fork docs", async () => {
    const h = harness({ answers: [...forked, ...MANAGED], installed: "1.0.0" });
    expect(await cmdUpdate(h.deps)).toBe(EXIT.FAIL);
    const said = h.io.stderr.join("\n");
    expect(said).toContain("youngsecurity/collie");
    expect(said).toContain("AltanS/collie");
    expect(said).toContain("COLLIE_UPDATE_REPO=youngsecurity/collie");
    expect(said).toContain("docs/upgrading.md");
    // Nothing was fetched and nothing was checked out — the whole point of asserting first.
    expect(gitRuns(h.exec).join("\n")).not.toContain("fetch");
    expect(gitRuns(h.exec).join("\n")).not.toContain("checkout");
  });

  test("a checkout that cannot say where it came from is refused too", async () => {
    const h = harness({
      answers: [[`${GIT} remote get-url origin`, { code: 2 }], ...MANAGED],
      installed: "1.0.0",
    });
    expect(await cmdUpdate(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("unreadable");
    expect(gitRuns(h.exec).join("\n")).not.toContain("fetch");
  });

  test("COLLIE_UPDATE_REPO moves the assertion — one override, banner and updater together", async () => {
    const h = harness({
      answers: [...forked, ...MANAGED, [`${GIT} ls-remote --tags origin`, { stdout: LS_REMOTE }]],
      installed: "1.0.0",
      env: { COLLIE_UPDATE_REPO: "youngsecurity/collie" },
    });
    // A self-consistent fork operator gets a working updater: already current, not a refusal.
    expect(await cmdUpdate(h.deps)).toBe(EXIT.OK);
    expect(h.io.stdout.join("\n")).toContain("already current");
  });
});

// ── The binary install path (M14/01 §3) ──────────────────────────────────────

describe("parseApiTags", () => {
  test("produces exactly what parseRemoteTags produces, from the other document", () => {
    expect(
      parseApiTags([
        { name: "v0.32.0", sha: "b2peeled" },
        { name: "nightly", sha: "eeeeeeee" },
        { name: "v1.0.0", sha: "cccccccc" },
        { name: "v1.0.0-", sha: "junk" },
      ]),
    ).toEqual([
      { tag: "v0.32.0", version: "0.32.0", major: 0, prerelease: null, commit: "b2peeled" },
      { tag: "v1.0.0", version: "1.0.0", major: 1, prerelease: null, commit: "cccccccc" },
    ]);
    // The same anchor as the git path and the banner: a tag one would drop, all three drop.
    expect(parseApiTags([{ name: "release-v1.0.0", sha: "x" }])).toEqual([]);
  });
});

describe("platformId", () => {
  test("names the four designed targets and refuses everything else", () => {
    expect(platformId("linux", "x64")).toBe("linux-x64");
    expect(platformId("linux", "arm64")).toBe("linux-arm64");
    expect(platformId("darwin", "arm64")).toBe("macos-arm64");
    expect(platformId("darwin", "x64")).toBe("macos-x64");
    expect(platformId("win32", "x64")).toBeNull();
    expect(platformId("linux", "riscv64")).toBeNull();
  });
});

const INST = "/inst";
const BROOT = `${INST}/versions/1.0.0`;
const NEW = "1.1.0";
const PAYLOAD = `collie-${NEW}-linux-x64`;
const DIGEST = "3f786850e387550fdab836ed7e6dc881de23001b9d9dbb3b9b2b0b0f1a2c3d4e";

/** The `/tags` payload as GitHub actually answers it — the document `parseTagsResponse` reads. */
const apiTags = (...names: string[]) => names.map((name) => ({ name, commit: { sha: `sha-${name}` } }));

const manifestDoc = (over: JsonObject = {}) => ({
  schemaVersion: 1,
  repo: "AltanS/collie",
  tag: `v${NEW}`,
  version: NEW,
  artifacts: [
    {
      name: `${PAYLOAD}.tar.gz`,
      platform: "linux-x64",
      sha256: DIGEST,
      size: 4,
      payloadRoot: PAYLOAD,
    },
  ],
  ...over,
});

interface BinaryOptions {
  tags?: readonly { name: string; commit: { sha: string } }[];
  manifest?: JsonObject | null;
  /** The digest the download reports — a different one is the corruption case. */
  digest?: string;
  tagsFailure?: { status: number | null; message: string };
  downloadFailure?: { status: number | null; message: string };
  restart?: number;
  smoke?: { pre?: boolean; post?: boolean };
  /** What `<root>/current/bin/collie version` answers — the post-flip check reads it. */
  currentSays?: string;
  env?: Record<string, string | undefined>;
  /** Versions already on disk beside the running one. */
  others?: readonly string[];
  /** What `current/bin/collie hooks status --check` answers. Default: exit 0, i.e. nothing to say. */
  hooksCheck?: Partial<import("./sys.ts").ExecResult>;
  /** What `/api/health` answers, in order — the detached runner's gate polls it (M15/04). */
  health?: readonly HealthReply[];
}

/** One `/api/health` answer for the fake net: down, deposed, or up as some version. */
type HealthReply = { down: true } | { version: string; deposed?: boolean };

/**
 * `/api/health` over the same `Net` seam every other GET goes through, answering `replies` in order
 * and repeating the last one for ever — so a gate that polls sees "down, down, up" without a clock.
 */
function healthNet(replies: readonly HealthReply[] | undefined, fallback: string) {
  const queue = [...(replies ?? [{ version: fallback }])];
  return () => {
    const reply = queue.length > 1 ? queue.shift()! : (queue[0] ?? { version: fallback });
    if ("down" in reply) {
      return Promise.resolve({ ok: false as const, failure: { status: null, message: "connection refused" } });
    }
    return Promise.resolve({
      ok: true as const,
      value: { version: reply.version, deposed: reply.deposed === true },
    });
  };
}

function binaryHarness(over: BinaryOptions = {}): Harness {
  const io = capture();
  const version = (v: string, out = v): [string, Partial<import("./sys.ts").ExecResult>] => [
    `/inst/versions/${v}/bin/collie version`,
    { stdout: `${out}\n` },
  ];
  const answers: NonNullable<Scripted["answers"]> = [
    // Not a git checkout: the whole point of this shape.
    [`git -C ${BROOT} rev-parse --git-dir`, { code: 1 }],
    [`/inst/versions/${NEW}/bin/collie version`, { stdout: over.smoke?.pre === false ? "boom\n" : `${NEW}\n` }],
    [
      `${INST}/current/bin/collie version`,
      { stdout: over.smoke?.post === false ? "boom\n" : `${over.currentSays ?? NEW}\n` },
    ],
    version("1.0.0"),
    [`${INST}/current/bin/collie hooks status --check`, over.hooksCheck ?? { code: EXIT.OK }],
  ];
  const exec = fakeExec({ answers });
  const seed: SeededFiles = {
    [`${BROOT}/herdr-plugin.toml`]: 'id = "herdr.collie"\nversion = "1.0.0"\n',
    [`${BROOT}/bin/collie`]: "OLD BINARY",
    [`${BROOT}/web/dist/index.html`]: "OLD",
  };
  for (const v of over.others ?? []) seed[`${INST}/versions/${v}/bin/collie`] = "OLDER BINARY";
  const files = fakeFiles(seed);
  const link = fakeLinkFs({ [`${INST}/current`]: { kind: "symlink", target: BROOT } });
  const health = healthNet(over.health, NEW);
  const net: Net = {
    probe: () => Promise.resolve({ ok: false, failure: { status: null, message: "no probe in this case" } }),
    getJson: (url) => {
      if (url.includes("/api/health")) return health();
      if (url.includes("api.github.com")) {
        return Promise.resolve(
          over.tagsFailure === undefined
            ? { ok: true as const, value: over.tags ?? apiTags("v1.0.0", `v${NEW}`) }
            : { ok: false as const, failure: over.tagsFailure },
        );
      }
      const manifest = over.manifest === undefined ? manifestDoc() : over.manifest;
      return Promise.resolve(
        manifest === null
          ? { ok: false as const, failure: { status: 404, message: "HTTP 404" } }
          : { ok: true as const, value: manifest },
      );
    },
    download: (_url, dest) => {
      if (over.downloadFailure !== undefined) {
        return Promise.resolve({ ok: false as const, failure: over.downloadFailure });
      }
      files.write(dest, "tarball bytes");
      // The fake `tar` cannot write, so the unpacked payload is seeded here — after the scratch
      // sweep, which is the only ordering that matters to the code under test.
      const at = `${INST}/.staging/x/${PAYLOAD}`;
      files.write(`${at}/bin/collie`, "NEW BINARY");
      files.write(`${at}/web/dist/index.html`, "NEW");
      files.write(`${at}/herdr-plugin.toml`, `version = "${NEW}"\n`);
      files.write(`${at}/package.json`, `{"version":"${NEW}"}`);
      return Promise.resolve({ ok: true as const, sha256: over.digest ?? DIGEST, size: 4 });
    },
  };
  const h: Harness = {
    io,
    exec,
    files,
    link,
    restarts: 0,
    deps: {
      ctx: context(over.env ?? {}, { root: BROOT }),
      io,
      exec,
      files,
      link,
      net,
      platform: "linux",
      arch: "x64",
      restart: () => {
        h.restarts++;
        return Promise.resolve(over.restart ?? EXIT.OK);
      },
      ...clock(),
    },
  };
  return h;
}

/**
 * The DETACHED RUNNER, driven directly — `collie update` stages and hands off to exactly this
 * (M15/04), so the flip, the restart, the health gate and the rollback are all proved here rather
 * than through the verb that no longer performs them.
 */
const runner = (h: Harness, a: Omit<ApplyArgs, "handoff">): Promise<number> =>
  cmdApplyUpdate(h.deps, applyArgv({ ...a, handoff: FAKE_PID }));

/** The runner's argv for the binary fixture: 1.0.0 is on disk, 1.1.0 is being made live. */
const BINARY_APPLY: Omit<ApplyArgs, "handoff"> = {
  to: NEW,
  from: "1.0.0",
  version: NEW,
  commit: "",
  kind: "binary",
};

describe("collie update on a binary install", () => {
  test("lays the version down, then hands the swap to the detached updater with systemd-run", async () => {
    const h = binaryHarness({ others: ["0.9.0"] });
    expect(await cmdUpdate(h.deps)).toBe(EXIT.OK);
    // The payload landed as ONE rename into versions/<version>…
    expect(h.files.ops).toContain(`mv ${INST}/.staging/x/${PAYLOAD} ${INST}/versions/${NEW}`);
    // …and then this process stopped. No flip, no restart: the restart would kill the bridge that
    // asked for the update, and a killed updater cannot roll anything back.
    expect(h.link.ops).toEqual([]);
    expect(h.restarts).toBe(0);
    expect(h.io.stdout.join("\n")).toContain("Watch it with: collie update --status");
    // Nothing was compiled and nothing re-exec'd: no `bun` anywhere on this path.
    expect(h.exec.calls.join("\n")).not.toContain("bun ");
    // The state file says `staging`, so a bridge that comes up now reports a run in flight.
    expect(JSON.parse(h.files.read(`${STATE}/update.json`) ?? "{}").state).toBe("staging");
  });

  test("the runner flips `current` with one rename, restarts through it, and only then prunes", async () => {
    const h = binaryHarness({ others: ["0.9.0"] });
    expect(await runner(h, BINARY_APPLY)).toBe(EXIT.OK);
    // The symlink was built beside `current` and renamed ONTO it, never removed first.
    expect(h.link.ops).toContain(`symlink versions/${NEW} ${INST}/.current.new`);
    expect(h.files.ops).toContain(`mv ${INST}/.current.new ${INST}/current`);
    // The restart goes through the name that was just switched, never through this old process.
    expect(h.exec.calls).toContain(`${INST}$ ${INST}/current/bin/collie restart`);
    expect(h.restarts).toBe(0);
    expect(h.io.stdout.join("\n")).toContain(`✓ updated to ${NEW}`);
    // GC: `current` plus one older is kept, so 0.9.0 goes and 1.0.0 stays.
    expect(h.files.ops.join("\n")).toContain(`${INST}/.trash/0.9.0.`);
    expect(h.files.ops.join("\n")).not.toContain(`${INST}/versions/1.0.0 ${INST}/.trash`);
  });

  test("a checksum mismatch changes nothing — no version directory, no flip", async () => {
    const h = binaryHarness({ digest: "9c1a04".padEnd(64, "0") });
    expect(await cmdUpdate(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("checksum mismatch");
    expect(h.io.stderr.join("\n")).toContain("Nothing was changed");
    expect(h.link.ops).toEqual([]);
    expect(h.files.exists(`${INST}/versions/${NEW}`)).toBe(false);
    expect(h.restarts).toBe(0);
  });

  test("a manifest schemaVersion it cannot read stops the update loudly", async () => {
    const h = binaryHarness({ manifest: manifestDoc({ schemaVersion: 2 }) });
    expect(await cmdUpdate(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("schemaVersion 2");
    expect(h.link.ops).toEqual([]);
  });

  test("a release with no artifact for this platform sends the operator to the source build", async () => {
    const h = binaryHarness({
      manifest: manifestDoc({ artifacts: [{ name: "x", platform: "macos-arm64", sha256: DIGEST, size: 1, payloadRoot: "x" }] }),
    });
    expect(await cmdUpdate(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("no artifact for linux-x64");
    expect(h.io.stderr.join("\n")).toContain("From source");
  });

  test("a rate-limited tag check says so and stops — it never falls back to another endpoint", async () => {
    const h = binaryHarness({ tagsFailure: { status: 403, message: "HTTP 403" } });
    expect(await cmdUpdate(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("rate-limited");
    expect(h.link.ops).toEqual([]);
  });

  test("already current reads exactly as it does on a checkout — the paths are indistinguishable", async () => {
    const h = binaryHarness({ tags: apiTags("v1.0.0") });
    expect(await cmdUpdate(h.deps)).toBe(EXIT.OK);
    expect(h.io.stdout.join("\n")).toContain("already current — v1.0.0 is the newest release of major 1.");
    expect(h.restarts).toBe(0);
  });

  test("a version that answers as the OLD one is rolled-back, and the prune never runs", async () => {
    // The health gate's second failure mode: the service is up, and it is up on the wrong code.
    const h = binaryHarness({
      others: ["0.9.0"],
      env: { COLLIE_UPDATE_HEALTH_TIMEOUT_MS: "2000" },
      health: [{ version: "1.0.0" }],
    });
    expect(await runner(h, BINARY_APPLY)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("rolled back to 1.0.0");
    // Two flips (forward, then back) and two restarts through `current`.
    expect(h.link.ops.filter((o) => o.startsWith("symlink")).length).toBe(2);
    expect(h.exec.calls.filter((c) => c.endsWith("current/bin/collie restart")).length).toBe(2);
    const run = JSON.parse(h.files.read(`${STATE}/update.json`) ?? "{}");
    expect(run.state).toBe("rolled-back");
    expect(run.reason).toContain("came back as 1.0.0, not 1.1.0");
    // A rolled-back run prunes NOTHING: 0.9.0 is still where it was.
    expect(h.files.ops.join("\n")).not.toContain(`${INST}/.trash/0.9.0.`);
  });

  test("a version that does not even run is discarded BEFORE the flip", async () => {
    const h = binaryHarness({ smoke: { pre: false } });
    expect(await cmdUpdate(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("did not run here");
    expect(h.link.ops).toEqual([]);
    expect(h.restarts).toBe(0);
  });

  test("every smoke run is bounded — a candidate that hangs on `version` fails, not hangs, the update", async () => {
    const h = binaryHarness();
    expect(await cmdUpdate(h.deps)).toBe(EXIT.OK);
    const smokes = h.exec.timeouts.filter((t) => t.call.endsWith("bin/collie version"));
    // One, on the laid payload and BEFORE the flip. What used to be the post-flip smoke is now the
    // detached runner's `/api/health` gate, which asks a running service rather than a binary.
    expect(smokes.length).toBe(1);
    for (const s of smokes) expect(s.ms).toBe(20_000);
  });

  test("COLLIE_UPDATE_REPO is announced before the first fetch — a redirected updater is never silent", async () => {
    const h = binaryHarness({ env: { COLLIE_UPDATE_REPO: "my/collie" } });
    await cmdUpdate(h.deps);
    expect(h.io.stdout[0]).toBe("update source: github.com/my/collie (COLLIE_UPDATE_REPO)");
  });
});

describe("collie update --rollback", () => {
  test("flips back to the newest older version, restarts, and never collects", async () => {
    const h = binaryHarness({ others: ["0.9.0"], currentSays: "0.9.0" });
    expect(await cmdUpdate(h.deps, ["--rollback"])).toBe(EXIT.OK);
    expect(h.link.ops).toContain(`symlink versions/0.9.0 ${INST}/.current.new`);
    expect(h.restarts).toBe(1);
    // The version rolled away from is the one the operator is most likely to want back.
    expect(h.files.ops.join("\n")).not.toContain(".trash");
  });

  test("with nothing older, it says so rather than doing something", async () => {
    const h = binaryHarness();
    expect(await cmdUpdate(h.deps, ["--rollback"])).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("nothing to roll back to");
    expect(h.link.ops).toEqual([]);
  });

  test("on a Herdr-managed checkout it is refused, and the refusal names the reason", async () => {
    // ADR 0006 (amended 2026-09-03) keeps a managed checkout advancing in place, so there is no
    // `versions/` layout and no previous version on disk to flip back to.
    const h = harness({ answers: MANAGED, installed: "1.0.0" });
    expect(await cmdUpdate(h.deps, ["--rollback"])).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("advances in place (ADR 0006)");
  });
});

// ── The hooks nudge after a successful update ────────────────────────────────
// The gap it closes: a new build registers a beacon hook event, the operator's `settings.json` does
// not carry it, and until now only a manual `doctor` or `hooks status` ever said so. What is pinned
// here is WHO ANSWERS — the newly installed binary, through the name that was just switched, because
// the running process is the OLD build and its `BEACON_HOOKS` is the stale list.

const NUDGE = "beacon hooks your settings do not carry yet";
const CHECK = `${INST}/current/bin/collie hooks status --check`;

describe("the hooks nudge", () => {
  test("asks the NEW binary through `current`, and prints one line naming the command", async () => {
    const h = binaryHarness({ hooksCheck: { code: EXIT.STATE } });
    expect(await runner(h, BINARY_APPLY)).toBe(EXIT.OK);
    // Through `current`, never this process and never the version directory — the pin `hooks
    // install` itself writes, and the only name that stays valid across the next update.
    expect(h.exec.calls).toContain(CHECK);
    expect(h.io.stdout.join("\n")).toContain(NUDGE);
    expect(h.io.stdout.join("\n")).toContain("collie hooks install claude");
  });

  test("stays silent when the new binary reports nothing to do", async () => {
    const h = binaryHarness();
    expect(await runner(h, BINARY_APPLY)).toBe(EXIT.OK);
    expect(h.exec.calls).toContain(CHECK);
    expect(h.io.stdout.join("\n")).not.toContain(NUDGE);
  });

  test("a check that cannot run leaves the update successful and silent", async () => {
    const h = binaryHarness({ hooksCheck: { found: false, code: 127 } });
    expect(await runner(h, BINARY_APPLY)).toBe(EXIT.OK);
    expect(h.io.stdout.join("\n")).toContain(`✓ updated to ${NEW}`);
    expect(h.io.stdout.join("\n")).not.toContain(NUDGE);
    expect(h.io.stderr).toEqual([]);
  });

  test("a check whose spawn THROWS leaves the update successful and silent too", async () => {
    // The real `capture` throws when the child cannot even start (ENOEXEC on a stub, EACCES) —
    // the shell suite runs it against a fake binary and caught exactly this. The fake exec only
    // returns results, so the throw is grafted onto the one call that matters.
    const h = binaryHarness({ hooksCheck: { code: EXIT.STATE } });
    const real = h.deps.exec.capture.bind(h.deps.exec);
    h.deps.exec.capture = (tool, args, timeoutMs) => {
      if (args.join(" ") === "hooks status --check") throw new Error("ENOEXEC: posix_spawn");
      return real(tool, args, timeoutMs);
    };
    expect(await runner(h, BINARY_APPLY)).toBe(EXIT.OK);
    expect(h.io.stdout.join("\n")).toContain(`✓ updated to ${NEW}`);
    expect(h.io.stdout.join("\n")).not.toContain(NUDGE);
    expect(h.io.stderr).toEqual([]);
  });

  test("the checkout path asks the binary `build` just wrote, for the same reason", async () => {
    const h = harness({
      answers: [...LINKED, ...SHALLOW, [`${BINARY} hooks status --check`, { code: EXIT.STATE }]],
    });
    expect(await cmdApplyUpdate(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls).toContain(`${BINARY} hooks status --check`);
    expect(h.io.stdout.join("\n")).toContain(NUDGE);
  });

  test("never fires on a rollback — that flips back, it does not add registrations", async () => {
    const h = binaryHarness({ others: ["0.9.0"], hooksCheck: { code: EXIT.STATE } });
    await cmdUpdate(h.deps, ["--rollback"]);
    expect(h.exec.calls.join("\n")).not.toContain("hooks status --check");
  });
});

// ── The staged checkout path (M15/02) ────────────────────────────────────────
// A checkout builds into `versions/vX.Y.Z` — a git worktree of the release tag — and goes live by
// the same single-rename symlink flip the binary path makes. What is pinned here is that the
// running install is untouched until that flip, that the flip demands the build's own completeness
// marker, and that nothing is pruned by an update.

const CLONE = ROOT;
const VERSIONS = `${CLONE}/versions`;
const CURRENT = `${CLONE}/current`;
const WT = (tag: string): string => `${VERSIONS}/${tag}`;

/** A LINKED CLONE that has never staged a version — the shape the first staged update migrates. */
function legacyClone(over: { answers?: Scripted["answers"]; absent?: string[]; installed?: string } = {}): Harness {
  const h = harness({
    installed: over.installed ?? "0.31.1",
    absent: over.absent,
    answers: [
      ...(over.answers ?? []),
      ...(LINKED ?? []),
      [`${GIT} ls-remote --tags origin`, { stdout: LS_REMOTE }],
      [`${GIT} rev-parse HEAD`, { stdout: "a1a1a1a1\n" }],
      ...(FULL ?? []),
    ],
  });
  // The two seams are separate fakes, so a `rename(2)` over a symlink has to be joined up here: the
  // flip renames `.current.new` onto `current` through the FILES seam, and what moves is a symlink
  // the LINK seam owns. Every probe after the flip — `publishedBinary`, `currentVersionDir` — reads
  // the link seam, so a fixture that did not model this would answer as if the flip never happened.
  const rename = h.files.rename;
  h.files.rename = (from, to) => {
    rename(from, to);
    const moved = h.link.entries.get(from);
    if (moved === undefined) return;
    h.link.entries.delete(from);
    h.link.entries.set(to, moved);
  };
  return h;
}

interface StagedOptions {
  /** The version directories on disk: name → the version its marker names, or null for no marker. */
  versions?: Record<string, string | null>;
  /** The directory `current` points at. */
  current?: string;
  answers?: Scripted["answers"];
  /** What `/api/health` answers the detached runner's gate, in order. */
  health?: readonly HealthReply[];
}

/** An already-staged checkout: the running root IS a worktree under `versions/`. */
function stagedHarness(over: StagedOptions = {}): Harness {
  const current = over.current ?? "v1.0.0";
  const versions = over.versions ?? { "v1.0.0": "1.0.0" };
  const root = WT(current);
  const io = capture();
  const exec = fakeExec({
    answers: [
      ...(over.answers ?? []),
      // A worktree of a tag is detached — which is exactly why the layout, not the HEAD, decides
      // that this install stages.
      [`git -C ${root} symbolic-ref -q HEAD`, { code: 1 }],
      [`git -C ${root} remote get-url origin`, { stdout: "https://github.com/AltanS/collie.git\n" }],
    ],
  });
  const seed: SeededFiles = {
    [`${root}/herdr-plugin.toml`]: `id = "herdr.collie"\nversion = "${current.slice(1)}"\n`,
  };
  for (const [dir, marker] of Object.entries(versions)) {
    seed[`${VERSIONS}/${dir}/bin/collie`] = "BINARY";
    if (marker !== null) {
      seed[`${VERSIONS}/${dir}/.collie-build`] = JSON.stringify({ version: marker, commit: "abc1234" });
    }
  }
  const files = fakeFiles(seed);
  const link = fakeLinkFs({ [CURRENT]: { kind: "symlink", target: `versions/${current}` } });
  const health = healthNet(over.health, STAGED_TARGET);
  const h: Harness = {
    io,
    exec,
    files,
    link,
    restarts: 0,
    deps: {
      ctx: context({}, { root }),
      io,
      exec,
      files,
      link,
      net: { ...deadNet, getJson: (url) => (url.includes("/api/health") ? health() : deadNet.getJson(url)) },
      platform: "linux",
      arch: "x64",
      restart: () => {
        h.restarts++;
        return Promise.resolve(EXIT.OK);
      },
      ...clock(),
    },
  };
  return h;
}

describe("the staged checkout path", () => {
  test("stages the release as a git worktree, builds inside it, then flips `current` with one rename", async () => {
    const h = legacyClone();
    expect(await cmdUpdate(h.deps)).toBe(EXIT.OK);
    // The tag is FETCHED and STORED, then a worktree of it is added beside the running install.
    expect(gitRuns(h.exec)).toContain(`${GIT} fetch origin +refs/tags/v0.32.0:refs/tags/v0.32.0`);
    expect(gitRuns(h.exec)).toContain(
      `${GIT} worktree add --detach --force ${WT("v0.32.0")} refs/tags/v0.32.0`,
    );
    // The build runs INSIDE the worktree, from the source that was just checked out there.
    expect(h.exec.calls).toContain(`${WT("v0.32.0")}$ bun ${WT("v0.32.0")}/cli/main.ts build`);
    // The marker is the build's last act…
    expect(JSON.parse(h.files.read(`${WT("v0.32.0")}/.collie-build`) ?? "{}")).toEqual({
      version: "0.32.0",
      commit: "b2peeled",
    });
    // …and then this process hands off: nothing is flipped and nothing is restarted here.
    expect(h.link.ops).toEqual([]);
    expect(h.restarts).toBe(0);
    expect(h.io.stdout.join("\n")).toContain("Watch it with: collie update --status");
  });

  test("the runner flips `current` with the one rename, restarts through it, and re-links Herdr", async () => {
    const h = legacyClone();
    // The staging half already ran: a built worktree carrying the marker its build wrote LAST.
    h.files.write(`${WT("v0.32.0")}/.collie-build`, JSON.stringify({ version: "0.32.0", commit: "b2peeled" }));
    h.files.entries.set(`${CURRENT}/bin/collie`, { text: "NEW BINARY" });
    expect(
      await runner(h, { to: "v0.32.0", from: null, version: "0.32.0", commit: "b2peeled", kind: "checkout" }),
    ).toBe(EXIT.OK);
    // The swap is the one rename the binary path already makes.
    expect(h.link.ops).toContain(`symlink versions/v0.32.0 ${CLONE}/.current.new`);
    expect(h.files.ops).toContain(`mv ${CLONE}/.current.new ${CURRENT}`);
    // The restart goes through the name that was just switched, never through this old process.
    expect(h.exec.calls).toContain(`${CLONE}$ ${CURRENT}/bin/collie restart`);
    expect(h.restarts).toBe(0);
    expect(h.exec.calls).toContain(`herdr plugin link ${CURRENT}`);
    expect(h.io.stdout.join("\n")).toContain("✓ updated to 0.32.0");
  });

  test("migrates a legacy in-place checkout with no manual step, and says it has no rollback target", async () => {
    const h = legacyClone();
    // The name on PATH was published at the clone's own binary before the migration (ADR 0021).
    h.link.entries.set(`${HOME}/.local/bin/collie`, { kind: "symlink", target: BINARY });
    // The flip is what makes this path resolve; the fake filesystem is flat, so it is seeded.
    h.files.entries.set(`${CURRENT}/bin/collie`, { text: "NEW BINARY" });
    expect(await cmdUpdate(h.deps)).toBe(EXIT.OK);
    const said = h.io.stdout.join("\n");
    expect(said).toContain(`${VERSIONS} and ${CURRENT} are created now`);
    // Nothing to fall back to yet, and the transcript says exactly that rather than implying one.
    expect(said).toContain("nothing to roll back to yet");
    // The pointer follows the flip — and the flip is the RUNNER's, so the republish is too.
    h.files.write(`${WT("v0.32.0")}/.collie-build`, JSON.stringify({ version: "0.32.0", commit: "b2peeled" }));
    expect(
      await runner(h, { to: "v0.32.0", from: null, version: "0.32.0", commit: "b2peeled", kind: "checkout" }),
    ).toBe(EXIT.OK);
    expect(h.link.ops).toContain(`symlink ${CURRENT}/bin/collie ${HOME}/.local/bin/collie`);
    // And Herdr is re-registered at `current`, so a plugin action runs whatever is live.
    expect(h.exec.calls).toContain(`herdr plugin link ${CURRENT}`);
  });

  test("a build fail leaves `current` where it was, names the stage, and takes the worktree away", async () => {
    const h = legacyClone({ answers: [[`${WT("v0.32.0")}$ bun`, { code: 1 }]] });
    expect(await cmdUpdate(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("stopped at the BUILD stage");
    expect(h.io.stderr.join("\n")).toContain("`current` never moved");
    // Nothing was ever pointed at the half-built version…
    expect(h.link.ops).toEqual([]);
    expect(h.files.read(`${WT("v0.32.0")}/.collie-build`)).toBeNull();
    // …and both halves of the worktree go, directory and administrative record together.
    expect(h.files.ops).toContain(`rm -rf ${WT("v0.32.0")}`);
    expect(h.exec.calls).toContain(`${GIT} worktree prune`);
  });

  test("a fetch that fails stops before any worktree is added", async () => {
    const h = legacyClone({ answers: [[`${ROOT}$ git -C ${ROOT} fetch origin +refs/tags`, { code: 1 }]] });
    expect(await cmdUpdate(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("stopped at the FETCH stage");
    expect(gitRuns(h.exec).join("\n")).not.toContain("worktree add");
  });

  test("prune after health, never during staging: an update removes no version directory", async () => {
    // Pruning here would destroy the rollback target of the very update that may need it. The order
    // is stage, flip, restart, health passes (spec 04), THEN prune.
    const h = legacyClone();
    expect(await cmdUpdate(h.deps)).toBe(EXIT.OK);
    expect(h.files.ops.filter((o) => o.startsWith(`rm -rf ${VERSIONS}`))).toEqual([]);
  });

  test("a staged install that is already current stages nothing at all", async () => {
    const h = stagedHarness({ answers: [[`git -C ${WT("v1.0.0")} ls-remote --tags origin`, { stdout: LS_REMOTE }]] });
    expect(await cmdUpdate(h.deps)).toBe(EXIT.OK);
    expect(h.io.stdout.join("\n")).toContain("already current");
    expect(h.exec.calls.join("\n")).not.toContain("worktree add");
    expect(h.link.ops).toEqual([]);
  });

  test("retention keeps `current` plus the two newest previous versions", () => {
    const h = stagedHarness({
      versions: { "v0.7.0": "0.7.0", "v0.8.0": "0.8.0", "v0.9.0": "0.9.0", "v1.0.0": "1.0.0" },
    });
    expect(pruneVersions(h.deps, checkoutLayout(CLONE))).toEqual(["v0.7.0"]);
    expect(h.files.ops).toContain(`rm -rf ${VERSIONS}/v0.7.0`);
    // The administrative half runs wherever a worktree directory is removed.
    expect(h.exec.calls).toContain(`git -C ${WT("v1.0.0")} worktree prune`);
    // …and the two newest previous ones are still there, with `current` untouched.
    expect(h.files.exists(`${VERSIONS}/v0.8.0`)).toBe(true);
    expect(h.files.exists(`${VERSIONS}/v1.0.0`)).toBe(true);
  });

  test("retention counts `current` itself — keep 1 leaves exactly the live version", () => {
    const h = stagedHarness({
      versions: { "v0.9.0": "0.9.0", "v1.0.0": "1.0.0" },
    });
    expect(pruneVersions(h.deps, checkoutLayout(CLONE), 1)).toEqual(["v0.9.0"]);
    expect(h.files.exists(`${VERSIONS}/v1.0.0`)).toBe(true);
  });
});

describe("collie update --rollback on a staged checkout", () => {
  test("flips `current` back to the newest retained previous version", async () => {
    const h = stagedHarness({ versions: { "v0.9.0": "0.9.0", "v1.0.0": "1.0.0" } });
    expect(await cmdUpdate(h.deps, ["--rollback"])).toBe(EXIT.OK);
    expect(h.link.ops).toContain(`symlink versions/v0.9.0 ${CLONE}/.current.new`);
    expect(h.files.ops).toContain(`mv ${CLONE}/.current.new ${CURRENT}`);
    expect(h.exec.calls).toContain(`${CLONE}$ ${CURRENT}/bin/collie restart`);
    expect(h.io.stdout.join("\n")).toContain("✓ rolled back to 0.9.0");
    // Never collects: the version rolled away from is the one most likely to be wanted back.
    expect(h.files.ops.join("\n")).not.toContain("rm -rf");
  });

  test("with nothing retained it says so rather than doing something", async () => {
    const h = stagedHarness();
    expect(await cmdUpdate(h.deps, ["--rollback"])).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("nothing to roll back to");
    expect(h.io.stderr.join("\n")).toContain("the only complete version this checkout");
    expect(h.link.ops).toEqual([]);
  });

  test("the flip refuses a version whose build marker is missing", async () => {
    // A killed build, a full disk, a half-copied directory: the marker is the evidence, and without
    // it the version is not a rollback candidate at all.
    const h = stagedHarness({ versions: { "v0.9.0": null, "v1.0.0": "1.0.0" } });
    expect(await cmdUpdate(h.deps, ["--rollback"])).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("nothing to roll back to");
    expect(h.link.ops).toEqual([]);
  });

  test("the flip refuses a marker that names another version, and names the mismatch", async () => {
    const h = stagedHarness({ versions: { "v0.9.0": "0.8.0", "v1.0.0": "1.0.0" } });
    expect(await cmdUpdate(h.deps, ["--rollback"])).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("names 0.8.0, not 0.9.0");
    expect(h.link.ops).toEqual([]);
  });

  test("a rollback that does not come up is rolled FORWARD again", async () => {
    const h = stagedHarness({
      versions: { "v0.9.0": "0.9.0", "v1.0.0": "1.0.0" },
      answers: [[`${CLONE}$ ${CURRENT}/bin/collie restart`, { code: 1 }]],
    });
    expect(await cmdUpdate(h.deps, ["--rollback"])).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("rolled forward to v1.0.0 again");
    expect(h.link.ops.filter((o) => o.startsWith("symlink")).length).toBe(2);
  });
});

// ── The detached updater (M15/04) ────────────────────────────────────────────
// The machine is a pure reducer over injected effects, so everything below runs with no systemd, no
// service, no network and no clock. The two cases that get discovered in production otherwise — the
// updater dying mid-flight, and a reader arriving at a stale marker — are pinned by name.

const RUN_FILE = `${STATE}/update.json`;
const LOCK_FILE = `${STATE}/update.lock`;

describe("the update reducer", () => {
  const t0 = 1_000;
  const begun = reduce(idleRun(t0), { kind: "begin", from: "v1.0.0", to: "v1.1.0", pid: 7 }, t0);

  test("the reducer walks idle → preflight → staging → restarting → verifying → done", () => {
    let run = begun;
    expect(run.state).toBe("preflight");
    run = reduce(run, { kind: "stage" }, t0 + 1);
    expect(run.state).toBe("staging");
    run = reduce(run, { kind: "restart" }, t0 + 2);
    expect(run.state).toBe("restarting");
    run = reduce(run, { kind: "verify" }, t0 + 3);
    expect(run.state).toBe("verifying");
    run = reduce(run, { kind: "pass" }, t0 + 4);
    expect(run.state).toBe("done");
    // Every transition stamps `updatedAt` and none of them moves `startedAt`.
    expect(run.startedAt).toBe(t0);
    expect(run.updatedAt).toBe(t0 + 4);
    expect(run.attempt).toBe(0);
  });

  test("the reducer allows exactly one rollback, and the second failure is stuck", () => {
    const verifying = reduce(
      reduce(reduce(begun, { kind: "stage" }, t0), { kind: "restart" }, t0),
      { kind: "verify" },
      t0,
    );
    const fail = { kind: "fail", reason: "no answer", logTail: "boom", recovery: "run me" } as const;
    // First failure: back into `restarting` — that IS the rollback restart, and the counter moves.
    const rolling = reduce(verifying, { ...fail, rollbackTo: "v1.0.0" }, t0 + 1);
    expect(rolling.state).toBe("restarting");
    expect(rolling.attempt).toBe(1);
    // The rollback's own health check passing is `rolled-back`, never `done`.
    const back = reduce(reduce(rolling, { kind: "verify" }, t0 + 2), { kind: "pass" }, t0 + 3);
    expect(back.state).toBe("rolled-back");
    // A second failure is terminal, carries the tail and the recovery command, and restarts nothing.
    const second = reduce(reduce(rolling, { kind: "verify" }, t0 + 2), { ...fail, rollbackTo: "v1.0.0" }, t0 + 3);
    expect(second.state).toBe("stuck");
    expect(second.recovery).toBe("run me");
    expect(second.logTail).toBe("boom");
  });

  test("the reducer sends a first failure straight to stuck when there is nothing to roll back to", () => {
    const verifying = reduce(
      reduce(reduce(begun, { kind: "stage" }, t0), { kind: "restart" }, t0),
      { kind: "verify" },
      t0,
    );
    const only = reduce(
      verifying,
      { kind: "fail", reason: "no answer", logTail: "", recovery: "collie update", rollbackTo: null },
      t0 + 1,
    );
    expect(only.state).toBe("stuck");
  });

  test("the reducer refuses a transition it has no meaning for", () => {
    expect(() => reduce(idleRun(t0), { kind: "pass" }, t0)).toThrow("no transition for `pass` from `idle`");
    // A run already in flight cannot be begun a second time — that is the lock's job to prevent,
    // and the machine says so rather than silently restarting its own record.
    expect(() => reduce(begun, { kind: "begin", from: null, to: "x", pid: 1 }, t0)).toThrow();
  });

  test("the reducer interrupts any in-flight state, and no terminal one", () => {
    const staging = reduce(begun, { kind: "stage" }, t0);
    const gone = reduce(staging, { kind: "interrupt", reason: "the updater is gone" }, t0 + 1);
    expect(gone.state).toBe("interrupted");
    expect(gone.reason).toBe("the updater is gone");
    // A finished run cannot be interrupted — there is nobody left to interrupt.
    const done = reduce(reduce(reduce(staging, { kind: "restart" }, t0), { kind: "verify" }, t0), { kind: "pass" }, t0);
    expect(() => reduce(done, { kind: "interrupt", reason: "x" }, t0)).toThrow();
  });

  test("an aborted staging returns the reducer to idle, because nothing moved", () => {
    const staged = reduce(begun, { kind: "stage" }, t0);
    const stopped = reduce(staged, { kind: "abort", reason: "the build failed" }, t0 + 1);
    expect(stopped.state).toBe("idle");
    expect(stopped.reason).toBe("the build failed");
  });
});

describe("the update state file and its lock", () => {
  test("the state file is schema-versioned and written atomically, temp file then rename", async () => {
    const h = binaryHarness();
    await cmdUpdate(h.deps);
    expect(h.files.ops).toContain(`mv ${RUN_FILE}.tmp ${RUN_FILE}`);
    const run = parseUpdateRun(h.files.read(RUN_FILE));
    expect(run?.schema).toBe(UPDATE_RUN_SCHEMA);
    expect(run?.state).toBe("staging");
    expect(run?.to).toBe(NEW);
    // 0600: it names a pid and a path on a possibly shared host.
    expect(h.files.entries.get(RUN_FILE)?.mode).toBe(0o600);
  });

  test("a concurrent apply is refused by the pid-and-timestamp lock", async () => {
    const h = binaryHarness();
    h.files.write(LOCK_FILE, JSON.stringify({ pid: 999, at: 1_700_000_000_000 }));
    // The pid is in the process table, so the lock holds whatever its age.
    h.deps.exec.processCommand = (pid) => (pid === 999 ? "collie _apply-update" : null);
    expect(await cmdUpdate(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("another update is in flight");
    expect(h.link.ops).toEqual([]);
  });

  test("a lock older than ten minutes whose updater is gone no longer blocks a retry", () => {
    const now = 2_000_000_000_000;
    const held = { pid: 999, at: now - STALE_AFTER_MS - 1 };
    expect(lockVerdict(held, now, true, STALE_AFTER_MS).ok).toBe(false);
    expect(lockVerdict(held, now, false, STALE_AFTER_MS).ok).toBe(true);
    // A YOUNG lock with a dead pid still holds: a retry must not race the tail of a finishing run.
    expect(lockVerdict({ pid: 999, at: now - 1_000 }, now, false, STALE_AFTER_MS).ok).toBe(false);
  });

  test("the updater dies mid-flight: the stale marker reads as interrupted and the retry proceeds", async () => {
    const h = binaryHarness();
    // Well past the ten-minute rule on the fixture clock — the marker is old AND its pid is gone.
    const stale = 1_600_000_000_000;
    // A run left `verifying` by an updater that is no longer in the process table.
    h.files.write(
      RUN_FILE,
      JSON.stringify({ schema: 1, state: "verifying", from: "1.0.0", to: NEW, startedAt: stale, updatedAt: stale, pid: 999, attempt: 0 }),
    );
    h.files.write(LOCK_FILE, JSON.stringify({ pid: 999, at: stale }));
    expect(await cmdUpdate(h.deps, ["--status"])).toBe(EXIT.OK);
    expect(h.io.stdout.join("\n")).toContain("interrupted");
    // …and the lock it left behind does not block the next run.
    expect(await cmdUpdate(h.deps)).toBe(EXIT.OK);
    expect(parseUpdateRun(h.files.read(RUN_FILE))?.state).toBe("staging");
  });
});

describe("the detached updater's health gate", () => {
  test("the health timeout defaults to 30 s and honours COLLIE_UPDATE_HEALTH_TIMEOUT_MS", () => {
    expect(healthTimeoutMs({})).toBe(30_000);
    expect(healthTimeoutMs({ COLLIE_UPDATE_HEALTH_TIMEOUT_MS: "5000" })).toBe(5_000);
    // A value nobody can act on is the default, not a crash and not zero.
    expect(healthTimeoutMs({ COLLIE_UPDATE_HEALTH_TIMEOUT_MS: "nonsense" })).toBe(30_000);
    expect(healthTimeoutMs({ COLLIE_UPDATE_HEALTH_TIMEOUT_MS: "0" })).toBe(30_000);
  });

  test("a health timeout stops polling at the budget and rolls back", async () => {
    const h = binaryHarness({
      env: { COLLIE_UPDATE_HEALTH_TIMEOUT_MS: "3000" },
      // Down for the forward gate; the rollback only has to prove the old version is up.
      health: [{ down: true }, { down: true }, { down: true }, { down: true }, { version: "1.0.0" }],
    });
    expect(await runner(h, BINARY_APPLY)).toBe(EXIT.FAIL);
    expect(parseUpdateRun(h.files.read(RUN_FILE))?.state).toBe("rolled-back");
  });

  test("a deposed peer answering health is not a success — it is rolled back like any other failure", async () => {
    const h = binaryHarness({
      env: { COLLIE_UPDATE_HEALTH_TIMEOUT_MS: "1000" },
      health: [{ version: NEW, deposed: true }, { version: NEW, deposed: true }, { version: "1.0.0" }],
    });
    expect(await runner(h, BINARY_APPLY)).toBe(EXIT.FAIL);
    const run = parseUpdateRun(h.files.read(RUN_FILE));
    expect(run?.state).toBe("rolled-back");
    expect(run?.reason).toContain("DEPOSED");
  });

  test("a second failure after the rollback is stuck, with a recovery command and no third restart", async () => {
    const h = binaryHarness({ env: { COLLIE_UPDATE_HEALTH_TIMEOUT_MS: "1000" }, health: [{ down: true }] });
    expect(await runner(h, BINARY_APPLY)).toBe(EXIT.FAIL);
    const run = parseUpdateRun(h.files.read(RUN_FILE));
    expect(run?.state).toBe("stuck");
    expect(run?.recovery).toBe(`${INST}/versions/1.0.0/bin/collie update --rollback`);
    // Two restarts and no more: forward, then the one rollback.
    expect(h.exec.calls.filter((c) => c.endsWith("current/bin/collie restart")).length).toBe(2);
    expect(h.io.stderr.join("\n")).toContain("Nothing will restart again");
  });

  test("a done run prunes and a rolled-back run does not — the prune is the success half only", async () => {
    const kept = binaryHarness({ others: ["0.9.0"] });
    expect(await runner(kept, BINARY_APPLY)).toBe(EXIT.OK);
    expect(kept.files.ops.join("\n")).toContain(`${INST}/.trash/0.9.0.`);

    const rolled = binaryHarness({
      others: ["0.9.0"],
      env: { COLLIE_UPDATE_HEALTH_TIMEOUT_MS: "1000" },
      health: [{ version: "1.0.0" }],
    });
    expect(await runner(rolled, BINARY_APPLY)).toBe(EXIT.FAIL);
    expect(rolled.files.ops.join("\n")).not.toContain(`${INST}/.trash/0.9.0.`);
  });
});

describe("the detached updater's launch seam", () => {
  const base = { binary: "/inst/current/bin/collie", args: ["_apply-update", "--to", "1.1.0"], unit: "collie", stamp: "abc" };

  test("linux launches the runner with systemd-run --user --collect and a transient unit name", () => {
    const plan = launchPlan({ ...base, platform: "linux", hasSystemdRun: true, hasSetsid: true });
    expect(plan.kind).toBe("systemd-run");
    expect(plan.command.slice(0, 5)).toEqual(["systemd-run", "--user", "--collect", "--unit", "collie-update-abc"]);
    expect(plan.command.slice(5)).toEqual([base.binary, ...base.args]);
  });

  test("macOS launches a setsid double-forked child instead — there is no systemd-run there", () => {
    const plan = launchPlan({ ...base, platform: "darwin", hasSystemdRun: false, hasSetsid: true });
    expect(plan.kind).toBe("setsid");
    expect(plan.command).toEqual(["setsid", base.binary, ...base.args]);
  });

  test("linux with no systemd-run falls back to the same setsid child and says so", () => {
    const plan = launchPlan({ ...base, platform: "linux", hasSystemdRun: false, hasSetsid: true });
    expect(plan.kind).toBe("setsid");
    const bare = launchPlan({ ...base, platform: "linux", hasSystemdRun: false, hasSetsid: false });
    expect(bare.kind).toBe("fork");
    expect(bare.command).toEqual([base.binary, ...base.args]);
    expect(bare.note).toContain("neither systemd-run nor setsid");
  });

  test("the handoff spawns the runner detached and never flips anything itself", async () => {
    const h = binaryHarness();
    await cmdUpdate(h.deps);
    const spawned = h.exec.spawned.at(-1);
    expect(spawned?.command[0]).toBe("systemd-run");
    expect(spawned?.command).toContain("_apply-update");
    // The binary THIS process is executing, not a path derived from the root.
    expect(spawned?.command).toContain(BINARY);
    // A narrow, named environment: no credential ever reaches a `--setenv` or a `ps` line.
    expect(Object.keys(spawned?.env ?? {})).not.toContain("COLLIE_VAPID_PRIVATE");
  });
});

describe("the recorded log tail", () => {
  test("the log tail is bounded to the last 40 lines and scrubbed of credential-shaped text", () => {
    const noisy = [
      ...Array.from({ length: 60 }, (_, i) => `line ${i}`),
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
      "COLLIE_PACK_SECRET=hunter2",
      'token = "aaaabbbbccccdddd"',
    ].join("\n");
    const tail = scrubSecrets(boundTail(noisy));
    const lines = tail.split("\n");
    expect(lines.length).toBe(LOG_TAIL_LINES);
    // The oldest lines are the ones that went; the newest are the ones that say why it failed.
    expect(lines[0]).toBe("line 23");
    expect(tail).not.toContain("hunter2");
    expect(tail).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(tail).not.toContain("aaaabbbbccccdddd");
    expect(tail).toContain(REDACTED);
  });

  test("the log tail is capped in bytes as well as lines", () => {
    const huge = Array.from({ length: 10 }, () => "x".repeat(4_000)).join("\n");
    expect(boundTail(huge).length).toBeLessThanOrEqual(8 * 1024);
  });

  test("a stuck run records the log tail journalctl gave it", async () => {
    const h = binaryHarness({ env: { COLLIE_UPDATE_HEALTH_TIMEOUT_MS: "1000" }, health: [{ down: true }] });
    h.deps.exec = {
      ...h.deps.exec,
      capture: (tool, args, ms) =>
        tool === "journalctl"
          ? { code: 0, stdout: "collie.service: Failed with result 'exit-code'.\n", stderr: "", found: true }
          : h.exec.capture(tool, args, ms),
    };
    await runner(h, BINARY_APPLY);
    expect(parseUpdateRun(h.files.read(RUN_FILE))?.logTail).toContain("Failed with result");
  });
});

describe("collie update --to-tag", () => {
  // The pure resolver first: the four refusals and the one happy path, decided without an install.
  const TAGS = parseApiTags([
    { name: "v1.0.0", sha: "a" },
    { name: "v1.1.0", sha: "b" },
    { name: "v1.2.0-beta.1", sha: "c" },
    { name: "v2.0.0", sha: "d" },
  ]);

  test("to-tag pins the plan to that exact release, not to the highest one", () => {
    const plan = planToTag({ tags: TAGS, installed: "1.0.0", wanted: "v1.1.0" });
    expect(plan.kind).toBe("pinned");
    expect(plan.kind === "pinned" && plan.target.tag).toBe("v1.1.0");
    // The bare spelling resolves to the same tag: a caller composing argv writes one or the other.
    expect(planToTag({ tags: TAGS, installed: "1.0.0", wanted: "1.1.0" }).kind).toBe("pinned");
  });

  test("to-tag refuses a tag that does not exist upstream", () => {
    const plan = planToTag({ tags: TAGS, installed: "1.0.0", wanted: "v9.9.9" });
    expect(plan.kind).toBe("refused");
    expect(plan.kind === "refused" && plan.reason).toContain("no release tag");
  });

  test("to-tag refuses a prerelease", () => {
    const plan = planToTag({ tags: TAGS, installed: "1.0.0", wanted: "v1.2.0-beta.1" });
    expect(plan.kind === "refused" && plan.reason).toContain("prerelease");
  });

  test("to-tag refuses a tag that is not higher than the installed version", () => {
    const plan = planToTag({ tags: TAGS, installed: "1.1.0", wanted: "v1.0.0" });
    expect(plan.kind === "refused" && plan.reason).toContain("never downgrades");
    // Equal is refused too. There is no "re-install this version" spelling here.
    expect(planToTag({ tags: TAGS, installed: "1.1.0", wanted: "v1.1.0" }).kind).toBe("refused");
  });

  test("to-tag refuses a major crossing", () => {
    const plan = planToTag({ tags: TAGS, installed: "1.0.0", wanted: "v2.0.0" });
    expect(plan.kind === "refused" && plan.reason).toContain("crosses a major");
  });

  test("to-tag reads both spellings off the argv and blank is absent", () => {
    expect(wantsToTag(["update", "--to-tag", "v1.1.0"])).toBe("v1.1.0");
    expect(wantsToTag(["update", "--to-tag=v1.1.0"])).toBe("v1.1.0");
    expect(wantsToTag(["update"])).toBeNull();
    expect(wantsToTag(["update", "--to-tag"])).toBeNull();
    // `--to` is the detached runner's own flag and is NOT read as a target tag.
    expect(wantsToTag(["_apply-update", "--to", "1.1.0"])).toBeNull();
  });

  test("to-tag on a binary install takes the named release", async () => {
    const h = binaryHarness();
    expect(await cmdUpdate(h.deps, ["--to-tag", `v${NEW}`])).toBe(EXIT.OK);
    expect(parseUpdateRun(h.files.read(RUN_FILE))?.to).toBe(NEW);
  });

  test("to-tag on a binary install refuses a tag the remote does not publish", async () => {
    const h = binaryHarness();
    expect(await cmdUpdate(h.deps, ["--to-tag", "v9.9.9"])).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("no release tag");
    // Nothing was staged: a refusal happens before any download.
    expect(h.files.read(RUN_FILE)).toBeNull();
  });
});

describe("the update run id", () => {
  test("run id rides the record when the caller names one, and is absent when it does not", async () => {
    const withId = binaryHarness();
    expect(await cmdUpdate(withId.deps, ["--run-id", "r-42"])).toBe(EXIT.OK);
    expect(parseUpdateRun(withId.files.read(RUN_FILE))?.runId).toBe("r-42");

    const without = binaryHarness();
    expect(await cmdUpdate(without.deps)).toBe(EXIT.OK);
    expect(parseUpdateRun(without.files.read(RUN_FILE))?.runId).toBeUndefined();
  });

  test("run id reads both spellings and never picks up the runner's own --to", () => {
    expect(wantsRunId(["update", "--run-id", "r-1"])).toBe("r-1");
    expect(wantsRunId(["update", "--run-id=r-1"])).toBe("r-1");
    expect(wantsRunId(["update", "--to-tag", "v1.1.0"])).toBeNull();
  });
});
