import { paneGitHead, scopeGitHead, shortSha } from "@/lib/git-head";
import { fixtureAgents } from "@/test/handlers";
import type { AgentView, GitHead } from "@/lib/types";

const pane = (cwd: string, gitHead?: GitHead): AgentView => ({ ...fixtureAgents[0]!, cwd, gitHead });
const main: GitHead = { kind: "branch", name: "main" };
const fix: GitHead = { kind: "branch", name: "fix-login" };

describe("paneGitHead", () => {
  it("passes a branch and a detached head through", () => {
    expect(paneGitHead({ gitHead: main })).toEqual(main);
    const detached: GitHead = { kind: "detached", sha: "abc1234def5678abc1234def5678abc1234def56" };
    expect(paneGitHead({ gitHead: detached })).toEqual(detached);
  });

  it("is null when the field is absent, empty or of a kind this build does not know", () => {
    expect(paneGitHead({})).toBeNull();
    expect(paneGitHead({ gitHead: { kind: "branch", name: "" } })).toBeNull();
    expect(paneGitHead({ gitHead: { kind: "detached", sha: "not-hex" } })).toBeNull();
    // A foreign shape, the one a newer crew member could send, arriving the way the wire delivers it.
    const odd: GitHead = JSON.parse('{"kind":"tag"}');
    expect(paneGitHead({ gitHead: odd })).toBeNull();
  });
});

describe("shortSha", () => {
  it("cuts to git's seven characters", () => {
    expect(shortSha("abc1234def5678")).toBe("abc1234");
  });
});

describe("scopeGitHead", () => {
  it("names the branch the panes in the root agree on", () => {
    expect(scopeGitHead([pane("/r", main), pane("/r/web", main)], "/r")).toEqual(main);
  });

  it("names none when the panes in the root disagree", () => {
    expect(scopeGitHead([pane("/r", main), pane("/r/sub", fix)], "/r")).toBeNull();
  });

  it("leaves out panes outside the root, and a sibling folder that only shares a prefix", () => {
    expect(scopeGitHead([pane("/r", main), pane("/elsewhere", fix), pane("/r-two", fix)], "/r/")).toEqual(main);
  });

  it("counts every pane before the root is known, and skips panes with no branch", () => {
    expect(scopeGitHead([pane("/a"), pane("/b", fix)], null)).toEqual(fix);
    expect(scopeGitHead([pane("/a"), pane("/b")], null)).toBeNull();
  });

  it("reads a Windows root on its own separator", () => {
    expect(scopeGitHead([pane("C:\\r\\web", main)], "C:\\r")).toEqual(main);
  });
});
