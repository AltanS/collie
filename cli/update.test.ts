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
} from "./fakes.ts";
import { EXIT } from "./io.ts";
import {
  cmdApplyUpdate,
  cmdUpdate,
  isManagedCheckout,
  refreshRegistry,
  updateCheckout,
  type UpdateDeps,
} from "./update.ts";

// `update` against fakes. The shell suite proves the git grammar against REAL throwaway repos
// (scripts/collie-cli.test.sh) — what is proved here is the branching: one predicate, two strategies,
// and the rule that a managed checkout is never re-linked.

const GIT = `git -C ${ROOT}`;
const DIST = `${ROOT}/web/dist`;

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
  over: Partial<Scripted & { env: Record<string, string | undefined>; restart: number }> = {},
): Harness {
  const io = capture();
  const exec = fakeExec(over);
  const files = fakeFiles({ [`${DIST}/index.html`]: "OLD", [BINARY]: "OLD BINARY" });
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

describe("updateCheckout", () => {
  test("a linked clone fast-forwards its branch", () => {
    const h = harness({ answers: LINKED });
    expect(updateCheckout(h.deps)).toBe(EXIT.OK);
    expect(gitRuns(h.exec)).toEqual([`${GIT} pull --ff-only`]);
    expect(h.io.stdout.join("\n")).toContain("git pull --ff-only");
  });

  test("a managed checkout fetches shallow and re-detaches with --force", () => {
    const h = harness({
      answers: [
        ...MANAGED,
        ...SHALLOW,
        [`${GIT} log -1`, { stdout: "abc1234 the newest release\n" }],
      ],
    });
    expect(updateCheckout(h.deps)).toBe(EXIT.OK);
    expect(gitRuns(h.exec)).toEqual([
      `${GIT} fetch --depth 1 origin HEAD`,
      `${GIT} checkout -q --detach --force FETCH_HEAD`,
    ]);
    expect(h.io.stdout.join("\n")).toContain("Herdr-managed checkout");
    expect(h.io.stdout.join("\n")).toContain("→ now at abc1234 the newest release");
  });

  test("--depth 1 ONLY when the repo is already shallow", () => {
    // Otherwise an update would truncate the history of a full clone someone happens to have
    // detached — a destruction the operator never asked for and cannot undo.
    const h = harness({ answers: [...MANAGED, ...FULL] });
    expect(updateCheckout(h.deps)).toBe(EXIT.OK);
    expect(gitRuns(h.exec)[0]).toBe(`${GIT} fetch origin HEAD`);
  });

  test("a non-git checkout names the reinstall command and fails", () => {
    const h = harness({ answers: [[`${GIT} rev-parse --git-dir`, { code: 128 }]] });
    expect(updateCheckout(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("herdr plugin install AltanS/collie --yes");
    expect(gitRuns(h.exec)).toEqual([]);
  });

  test("a failed fetch stops before the checkout", () => {
    const h = harness({
      answers: [...MANAGED, ...SHALLOW, [`${ROOT}$ ${GIT} fetch`, { code: 1 }]],
    });
    expect(updateCheckout(h.deps)).toBe(EXIT.FAIL);
    expect(gitRuns(h.exec)).toEqual([`${GIT} fetch --depth 1 origin HEAD`]);
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
