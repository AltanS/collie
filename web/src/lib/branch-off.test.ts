import {
  BRANCH_OFF_LAUNCHER_KEY,
  SHELL_CHOICE,
  branchOffOffered,
  branchOffRepos,
  defaultLauncher,
  paneBranchName,
  pickedStart,
  rememberLauncher,
  startFromBase,
  startFromChoices,
} from "./branch-off";
import type { Launcher, WorkspaceView } from "./types";

// "New agent on a branch" (ADR 0089): the picker's memory, the menu's two gates, and which repo the
// sheet opens on.

const CLAUDE: Launcher = { command: "claude", label: "Claude" };
const CODEX: Launcher = { command: "codex --full-auto", label: "Codex" };

/** A Storage stand-in holding at most one value per key. */
function memory(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("the agent picker's default", () => {
  it("is the shell when nothing was used before", () => {
    expect(defaultLauncher([CLAUDE, CODEX], memory())).toBe(SHELL_CHOICE);
  });

  it("is the last agent used, when this machine still has that row", () => {
    const store = memory();
    rememberLauncher(CODEX.command, store);
    expect(store.getItem(BRANCH_OFF_LAUNCHER_KEY)).toBe("codex --full-auto");
    expect(defaultLauncher([CLAUDE, CODEX], store)).toBe("codex --full-auto");
  });

  it("falls back to the shell when the remembered row is gone, never to a neighbour", () => {
    const store = memory({ [BRANCH_OFF_LAUNCHER_KEY]: "aider" });
    expect(defaultLauncher([CLAUDE, CODEX], store)).toBe(SHELL_CHOICE);
  });

  it("remembers the shell too", () => {
    const store = memory({ [BRANCH_OFF_LAUNCHER_KEY]: "claude" });
    rememberLauncher(SHELL_CHOICE, store);
    expect(defaultLauncher([CLAUDE], store)).toBe(SHELL_CHOICE);
  });

  it("survives a storage that throws", () => {
    const broken: Pick<Storage, "getItem" | "setItem"> = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => rememberLauncher("claude", broken)).not.toThrow();
    expect(defaultLauncher([CLAUDE], broken)).toBe(SHELL_CHOICE);
  });
});

describe("branchOffOffered", () => {
  it("needs the capability and the lead scope", () => {
    expect(branchOffOffered(true, undefined)).toBe(true);
    expect(branchOffOffered(true, { session: "work" })).toBe(true);
    expect(branchOffOffered(true, { host: "  " })).toBe(true);
    expect(branchOffOffered(false, undefined)).toBe(false);
    expect(branchOffOffered(true, { host: "laptop" })).toBe(false);
  });
});

describe("branchOffRepos", () => {
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

  it("is null for a pane whose space is in no repo", () => {
    expect(branchOffRepos([space({})], "w1")).toBeNull();
    expect(branchOffRepos([], "w1")).toBeNull();
  });

  it("chooses the pane's own repo among the repos the dashboard would list", () => {
    const spaces = [
      space({ workspaceId: "w1", label: "api", repoRoot: "/src/api", isWorktree: false }),
      space({ workspaceId: "w2", label: "web", repoRoot: "/src/web", isWorktree: false }),
    ];
    expect(branchOffRepos(spaces, "w2")).toEqual({
      repos: [
        { workspaceId: "w1", repoRoot: "/src/api", label: "api" },
        { workspaceId: "w2", repoRoot: "/src/web", label: "web" },
      ],
      selected: "w2",
    });
  });

  it("a pane in a worktree branches from the space showing its repo", () => {
    const spaces = [
      space({ workspaceId: "w1", label: "api", repoRoot: "/src/api", isWorktree: false }),
      space({ workspaceId: "w5", label: "api-x", repoRoot: "/src/api", isWorktree: true }),
    ];
    expect(branchOffRepos(spaces, "w5")?.selected).toBe("w1");
  });

  it("when no space shows the repo itself, the pane's own space stands in", () => {
    const spaces = [space({ workspaceId: "w5", label: "api-x", repoRoot: "/src/api", isWorktree: true })];
    expect(branchOffRepos(spaces, "w5")).toEqual({
      repos: [{ workspaceId: "w5", repoRoot: "/src/api", label: "api-x" }],
      selected: "w5",
    });
  });
});

// "Start from" (ADR 0089, amended): the pane's branch name, whether there is a choice, and the base
// the create sends.
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

describe("startFromBase", () => {
  const choices = { defaultBranch: "main", paneBranch: "feature/login" };

  it("with no choice to make, is the default", () => {
    expect(startFromBase(null, null)).toEqual({ kind: "default" });
    expect(startFromBase(null, "branch")).toEqual({ kind: "default" });
  });

  it("opens on This branch, and follows a pick", () => {
    expect(pickedStart(null)).toBe("branch");
    expect(startFromBase(choices, null)).toEqual({ kind: "ref", ref: "feature/login" });
    expect(startFromBase(choices, "branch")).toEqual({ kind: "ref", ref: "feature/login" });
    expect(startFromBase(choices, "default")).toEqual({ kind: "default" });
  });
});
