import { describe, expect, test } from "bun:test";

import {
  BINARY,
  capture,
  context,
  type FakeExec,
  fakeExec,
  type FakeFiles,
  fakeFiles,
  ROOT,
  type Scripted,
  type SeededFiles,
} from "./fakes.ts";
import { EXIT } from "./io.ts";
import { latestUpdateInMajor } from "../bridge/update.ts";
import {
  cmdApplyUpdate,
  cmdUpdate,
  isManagedCheckout,
  majorVerdict,
  nextMajorRelease,
  parseRemoteTags,
  planUpdate,
  refreshRegistry,
  releaseInMajor,
  trainInMajor,
  updateCheckout,
  type UpdateDeps,
  wantsMajor,
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
  restarts: number;
}

/** `git symbolic-ref -q HEAD` answering non-zero is what "detached, i.e. Herdr-managed" means. */
const MANAGED: Scripted["answers"] = [[`${GIT} symbolic-ref -q HEAD`, { code: 1 }]];
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
    }
  > = {},
): Harness {
  const io = capture();
  const exec = fakeExec(over);
  const seed: SeededFiles = { [`${DIST}/index.html`]: "OLD", [BINARY]: "OLD BINARY" };
  if (over.installed !== undefined) {
    seed[`${ROOT}/herdr-plugin.toml`] = `id = "herdr.collie"\nversion = "${over.installed}"\n`;
  }
  const files = fakeFiles(seed);
  const h: Harness = {
    io,
    exec,
    files,
    restarts: 0,
    deps: {
      ctx: context(over.env ?? {}),
      io,
      exec,
      files,
      restart: () => {
        h.restarts++;
        return Promise.resolve(over.restart ?? EXIT.OK);
      },
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
    expect(updateCheckout(h.deps)).toBe(EXIT.OK);
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
    expect(updateCheckout(h.deps)).toBe(EXIT.OK);
    expect(gitRuns(h.exec)).toEqual([`${GIT} fetch origin`, `${GIT} pull --ff-only`]);
    expect(h.exec.calls).toContain(`${GIT} show origin/v0.x:herdr-plugin.toml`);
    expect(h.exec.calls.some((c) => c.includes("FETCH_HEAD:herdr-plugin.toml"))).toBe(false);
    expect(h.io.stdout.join("\n")).not.toContain("MAJOR");
  });

  test("a linked clone refuses to be pulled across a major, and pulls NOTHING", () => {
    const h = linked("main", "1.0.0");
    expect(updateCheckout(h.deps)).toBe(EXIT.OK);
    expect(gitRuns(h.exec)).toEqual([`${GIT} fetch origin`]); // fetched to look; never pulled
    expect(h.io.stdout.join("\n")).toContain("crosses a MAJOR version");
    expect(h.io.stdout.join("\n")).toContain("(origin/main)");
    expect(h.io.stdout.join("\n")).toContain("update-major --plugin herdr.collie");
  });

  test("--major lets the same clone through, on its branch and with its ff-only pull", () => {
    const h = linked("main", "1.0.0");
    expect(updateCheckout(h.deps, { crossMajor: true })).toBe(EXIT.OK);
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
    expect(updateCheckout(h.deps)).toBe(EXIT.FAIL);
    expect(gitRuns(h.exec)).toEqual([`${GIT} fetch origin`, `${GIT} pull --ff-only`]);
    expect(h.exec.calls.some((c) => c.includes("herdr-plugin.toml"))).toBe(false);
  });

  test("a managed checkout detaches onto the newest TAG of its major, shallow and forced", () => {
    const h = managed();
    expect(updateCheckout(h.deps)).toBe(EXIT.OK);
    expect(gitRuns(h.exec)).toEqual([
      `${GIT} fetch --depth 1 origin refs/tags/v0.32.0`,
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
    expect(updateCheckout(h.deps)).toBe(EXIT.OK);
    expect(gitRuns(h.exec)).toEqual([]);
    expect(h.io.stdout.join("\n")).toContain("already current");
    expect(h.io.stdout.join("\n")).toContain("update-major --plugin herdr.collie");
  });

  test("--major on a managed checkout detaches onto the next major's tag", () => {
    const h = managed([], "0.31.1");
    expect(updateCheckout(h.deps, { crossMajor: true })).toBe(EXIT.OK);
    expect(gitRuns(h.exec)[0]).toBe(`${GIT} fetch --depth 1 origin refs/tags/v1.0.0`);
    expect(h.io.stdout.join("\n")).toContain("crossing to Collie 1.0.0");
  });

  test("--major with nothing above the installed major acts on nothing", () => {
    const h = managed([], "1.0.0");
    expect(updateCheckout(h.deps, { crossMajor: true })).toBe(EXIT.OK);
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
    expect(updateCheckout(h.deps)).toBe(EXIT.OK);
    // v1.0.0, NOT v1.0.0-beta.10: the release supersedes every beta that led to it.
    expect(gitRuns(h.exec)[0]).toBe(`${GIT} fetch --depth 1 origin refs/tags/v1.0.0`);
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
    expect(updateCheckout(h.deps)).toBe(EXIT.OK);
    // A prerelease tag name reaches `refs/tags/` untouched — it is a ref like any other.
    expect(gitRuns(h.exec)).toEqual([
      `${GIT} fetch --depth 1 origin refs/tags/v1.0.0-beta.10`,
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
    expect(updateCheckout(h.deps)).toBe(EXIT.OK);
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
    expect(updateCheckout(h.deps)).toBe(EXIT.OK);
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
    expect(updateCheckout(h.deps)).toBe(EXIT.OK);
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
    expect(updateCheckout(h.deps)).toBe(EXIT.OK);
    expect(gitRuns(h.exec)).toEqual([
      `${GIT} fetch --depth 1 origin refs/tags/v1.0.0`,
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
    expect(updateCheckout(h.deps)).toBe(EXIT.FAIL);
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
    expect(updateCheckout(h.deps)).toBe(EXIT.OK);
    expect(gitRuns(h.exec)[0]).toBe(`${GIT} fetch origin refs/tags/v0.32.0`);
  });

  test("a non-git checkout names the reinstall command and fails", () => {
    const h = harness({ answers: [[`${GIT} rev-parse --git-dir`, { code: 128 }]] });
    expect(updateCheckout(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("herdr plugin install AltanS/collie --yes");
    expect(gitRuns(h.exec)).toEqual([]);
  });

  test("an unreachable remote fails before anything moves", () => {
    const h = harness({
      installed: "0.31.1",
      answers: [...MANAGED, [`${GIT} ls-remote --tags origin`, { code: 128 }]],
    });
    expect(updateCheckout(h.deps)).toBe(EXIT.FAIL);
    expect(gitRuns(h.exec)).toEqual([]);
    expect(h.io.stderr.join("\n")).toContain("could not list the upstream release tags");
  });

  test("a failed fetch stops before the checkout", () => {
    const h = managed([[`${ROOT}$ ${GIT} fetch`, { code: 1 }]]);
    expect(updateCheckout(h.deps)).toBe(EXIT.FAIL);
    expect(gitRuns(h.exec)).toEqual([`${GIT} fetch --depth 1 origin refs/tags/v0.32.0`]);
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
    // The post-pull half MUST run the new build logic, and the new binary does not exist yet —
    // `build` is what produces it. So the handoff re-execs the fetched SOURCE with Bun.
    const h = harness({ answers: [...LINKED] });
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
    const h = harness({ absent: ["bun"], answers: LINKED });
    expect(await cmdUpdate(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("the checkout advanced, but rebuilding needs Bun");
  });
});
