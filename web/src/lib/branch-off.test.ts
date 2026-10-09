import { branchOffOffered, paneBranchName, paneInRepo, startFromChoices } from "./branch-off";
import type { WorkspaceView } from "./types";

// "New agent on a branch" (ADR 0089, M48): the menu's gates, and the "Start from" choice.

describe("branchOffOffered", () => {
  it("needs the capability and the lead scope", () => {
    expect(branchOffOffered(true, undefined)).toBe(true);
    expect(branchOffOffered(true, { session: "work" })).toBe(true);
    expect(branchOffOffered(true, { host: "  " })).toBe(true);
    expect(branchOffOffered(false, undefined)).toBe(false);
    expect(branchOffOffered(true, { host: "laptop" })).toBe(false);
  });
});

describe("paneInRepo", () => {
  const space = (over: Partial<WorkspaceView>): WorkspaceView => ({
    workspaceId: "w1",
    number: 1,
    label: "repo",
    focused: false,
    activeTabId: "w1:t1",
    tabCount: 1,
    paneCount: 1,
    ...over,
  });

  it("is true only for a pane whose space names a repo", () => {
    expect(paneInRepo([space({ repoRoot: "/src/api" })], "w1")).toBe(true);
    expect(paneInRepo([space({ repoRoot: "" })], "w1")).toBe(false);
    expect(paneInRepo([space({})], "w1")).toBe(false);
    expect(paneInRepo([], "w1")).toBe(false);
  });
});

// "Start from" (ADR 0089, amended): the pane's branch name, whether there is a choice, and the base
// the sheet offers.
describe("paneBranchName", () => {
  it("names a branch and nothing else", () => {
    expect(paneBranchName({ gitHead: { kind: "branch", name: "feature/login" } })).toBe("feature/login");
    expect(paneBranchName({ gitHead: { kind: "detached", sha: "a".repeat(40) } })).toBeNull();
    expect(paneBranchName({})).toBeNull();
    expect(paneBranchName(undefined)).toBeNull();
  });

  it("drops a head from a newer peer that this build cannot read", () => {
    // SAFETY: a deliberately malformed head, as a crew member on a newer build could send.
    const odd = { gitHead: { kind: "branch", name: "" } } as const;
    expect(paneBranchName(odd)).toBeNull();
  });
});

describe("startFromChoices", () => {
  it("offers both names when the pane is on a branch other than the default", () => {
    expect(startFromChoices("feature/login", "main")).toEqual({ defaultBranch: "main", paneBranch: "feature/login" });
  });

  it("offers nothing when the pane is on the default branch", () => {
    expect(startFromChoices("main", "main")).toBeNull();
  });

  it("offers nothing without both names", () => {
    for (const [pane, def] of [
      [null, "main"],
      [undefined, "main"],
      ["", "main"],
      ["feature/login", null],
      ["feature/login", undefined],
      ["feature/login", ""],
    ] as const) {
      expect(startFromChoices(pane, def)).toBeNull();
    }
  });
});
