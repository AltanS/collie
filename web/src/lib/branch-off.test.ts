import {
  BRANCH_OFF_LAUNCHER_KEY,
  SHELL_CHOICE,
  branchOffOffered,
  branchOffRepos,
  defaultLauncher,
  rememberLauncher,
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
