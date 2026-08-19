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
// the peeled (`^{}`) line is the one naming a commit. `v1.1.0-rc.1` and `nightly` are the refs the
// strict anchor must drop.
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
  test("keeps strict releases only, and prefers the peeled commit of an annotated tag", () => {
    expect(parseRemoteTags(LS_REMOTE)).toEqual([
      { tag: "v0.31.1", version: "0.31.1", major: 0, commit: "a1a1a1a1" },
      // b2peeled, NOT b2b2b2b2: the peeled line is the one that names a commit.
      { tag: "v0.32.0", version: "0.32.0", major: 0, commit: "b2peeled" },
      { tag: "v1.0.0", version: "1.0.0", major: 1, commit: "cccccccc" },
    ]);
    // A prerelease and a non-semver ref are invisible to the verb, exactly as they are to the banner.
    expect(parseRemoteTags("x\trefs/tags/v1.1.0-rc.1\ny\trefs/heads/main\n")).toEqual([]);
    expect(parseRemoteTags("")).toEqual([]);
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
      target: { tag: "v0.32.0", version: "0.32.0", major: 0, commit: "b2peeled" },
      crossesMajor: false,
      higher: { tag: "v1.0.0", version: "1.0.0", major: 1, commit: "cccccccc" },
    });
  });

  test("already on the newest release of the major → nothing to do, major still announced", () => {
    const done = plan("0.32.0", "b2peeled");
    expect(done.kind).toBe("current");
    expect(done.kind === "current" && done.higher?.version).toBe("1.0.0");
    // Also "current" by version alone, whatever commit the checkout happens to sit on.
    expect(plan("0.32.0", "somewhere-else").kind).toBe("current");
  });

  test("no release of the installed major yet (a beta before its 1.0.0) → do nothing", () => {
    // The 0.x tags are not a 1.x install's to take, and its own major has nothing tagged yet.
    expect(
      planUpdate({ tags: parseRemoteTags(ONLY_0X), installed: "1.0.0-beta.5", head: "zzz", crossMajor: false }),
    ).toEqual({ kind: "no-release", major: 1, higher: null });
    // Once v1.0.0 IS tagged, the beta is simply behind its own release — no crossing involved.
    const out = plan("1.0.0-beta.5", "zzz");
    expect(out.kind === "advance" && out.target.tag).toBe("v1.0.0");
    expect(out.kind === "advance" && out.crossesMajor).toBe(false);
  });

  test("--major targets the next major; without one, it says so and acts on nothing", () => {
    const cross = plan("0.31.1", "a1a1a1a1", true);
    expect(cross.kind === "advance" && cross.target.tag).toBe("v1.0.0");
    expect(cross.kind === "advance" && cross.crossesMajor).toBe(true);
    expect(plan("1.0.0", "cccccccc", true)).toEqual({ kind: "no-higher-major", major: 1 });
  });

  test("an unreadable version falls back rather than stranding the install", () => {
    expect(plan(null, "zzz")).toEqual({ kind: "unknown-version" });
    expect(plan("unknown", "zzz")).toEqual({ kind: "unknown-version" });
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

  test("a major with no release of its own yet leaves the checkout alone", () => {
    // A 1.0.0-beta install before v1.0.0 is tagged: the 0.x tags are not its to take.
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

  test("an unreadable manifest falls back to origin HEAD rather than refusing to update", () => {
    const h = harness({
      answers: [...MANAGED, ...SHALLOW, [`${GIT} log -1`, { stdout: "abc1234 tip\n" }]],
    });
    expect(updateCheckout(h.deps)).toBe(EXIT.OK);
    expect(gitRuns(h.exec)).toEqual([
      `${GIT} fetch --depth 1 origin HEAD`,
      `${GIT} checkout -q --detach --force FETCH_HEAD`,
    ]);
    expect(h.io.stdout.join("\n")).toContain("no readable version");
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
