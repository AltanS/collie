import { describe, expect, it } from "vitest";

import { cwdBeyondName, paneParts, paneTitleInTab, TITLE_SEP } from "./pane-name";
import type { AgentView } from "./types";

function pane(over: Partial<AgentView> = {}): AgentView {
  return {
    paneId: "w0:p1",
    workspaceId: "w0",
    workspaceLabel: "moonward_os",
    workspaceNumber: 1,
    tabId: "w0:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/kon/dev/moonward",
    focused: false,
    ...over,
  };
}

/** What the row shows: the two spans are rendered side by side, so the assertions read them joined.
 *  They stay SEPARATE in the DOM on purpose — the project must be able to truncate before the tab
 *  does, which a single joined string cannot express. */
const join = (p: { project: string; tab: string | null }) =>
  p.tab ? `${p.project}${TITLE_SEP}${p.tab}` : p.project;
const joined = (view: AgentView) => join(paneParts(view));

describe("paneParts — the title line", () => {
  it("is project · tab when the tab has a label", () => {
    expect(joined(pane({ tabLabel: "fix-auth" }))).toBe("moonward_os · fix-auth");
  });

  it("falls back to the project alone when the bridge dropped the tab label", () => {
    // An unlabelled tab in a single-tab space arrives with tabLabel absent (meaningfulTabLabel),
    // so the row must not render a dangling separator.
    expect(joined(pane())).toBe("moonward_os");
  });

  it("never says 'claude'", () => {
    expect(joined(pane({ tabLabel: "fix-auth" }))).not.toContain("claude");
    expect(joined(pane())).not.toContain("claude");
  });

  it("falls back to the workspace id if a space somehow has no label", () => {
    expect(joined(pane({ workspaceLabel: "" }))).toBe("w0");
  });
});

describe("paneParts — the second line", () => {
  it("prefers a user-set pane label", () => {
    const t = paneParts(pane({ paneLabel: "hand-named", sessionName: "auto-named" }));
    expect(t.secondary).toBe("hand-named");
  });

  it("falls back to Claude's own /rename session name", () => {
    expect(paneParts(pane({ sessionName: "oauth-refactor" })).secondary).toBe("oauth-refactor");
  });

  it("falls back to the terminal title — what the pane says it is doing", () => {
    expect(paneParts(pane({ terminalTitle: "Reconcile the book lists" })).secondary).toBe(
      "Reconcile the book lists",
    );
  });

  it("lets a hand-set name outrank the terminal title", () => {
    // A name you chose must not be overwritten by one the process rewrites every turn.
    const over = { terminalTitle: "Reconcile the book lists" };
    expect(paneParts(pane({ ...over, paneLabel: "hand-named" })).secondary).toBe("hand-named");
    expect(paneParts(pane({ ...over, sessionName: "oauth-refactor" })).secondary).toBe(
      "oauth-refactor",
    );
  });

  it("falls back to a shortened cwd", () => {
    expect(paneParts(pane()).secondary).toBe("~/dev/moonward");
  });

  it("prefers the terminal title over the cwd — a project's herd shares one cwd", () => {
    expect(paneParts(pane({ terminalTitle: "Fixing the parser" })).secondary).toBe(
      "Fixing the parser",
    );
  });

  it("tells apart several agents sitting in ONE project and tab", () => {
    // The herd this change exists for: same project, same cwd, no hand-set names. Before the title
    // was read, all three rows rendered identically.
    const rendered = [
      "Custom UI for Collie",
      "Read Notes From Underground",
      "Reconcile book lists",
    ].map((terminalTitle) => {
      const p = paneParts(pane({ terminalTitle }));
      return `${join(p)}|${p.secondary}`;
    });
    expect(new Set(rendered).size).toBe(3);
  });

  it("is null when there is nothing to say", () => {
    expect(paneParts(pane({ cwd: "" })).secondary).toBeNull();
  });

  it("keeps the pane's own name even when the tab is labelled — nothing is lost", () => {
    const t = paneParts(pane({ tabLabel: "fix-auth", sessionName: "oauth-refactor" }));
    expect(join(t)).toBe("moonward_os · fix-auth");
    expect(t.secondary).toBe("oauth-refactor");
  });
});

describe("paneParts — shell panes", () => {
  it("names a shell by its place, not by the word 'shell'", () => {
    const t = paneParts(pane({ kind: "shell", agent: "shell", tabLabel: "scratch" }));
    expect(join(t)).toBe("moonward_os · scratch");
  });
});

describe("paneParts — the cwd fallback only when it says something", () => {
  it("drops the cwd when the directory is just the project again", () => {
    // The space is named after its directory on almost every row, so the fallback was printing
    // line 1 twice.
    expect(paneParts(pane({ workspaceLabel: "collie", cwd: "/home/kon/dev/ai/collie" })).secondary)
      .toBeNull();
  });

  it("is case-insensitive about that match", () => {
    expect(paneParts(pane({ workspaceLabel: "Collie", cwd: "/home/kon/dev/ai/collie" })).secondary)
      .toBeNull();
  });

  it("KEEPS the cwd when the pane sits somewhere else — a worktree or a subdir", () => {
    expect(paneParts(pane({ workspaceLabel: "collie", cwd: "/home/kon/dev/ai/collie/web" })).secondary)
      .toBe("~/dev/ai/collie/web");
  });

  it("still prefers the pane's own name over either", () => {
    const t = paneParts(pane({ workspaceLabel: "collie", cwd: "/home/kon/dev/ai/collie", sessionName: "oauth" }));
    expect(t.secondary).toBe("oauth");
  });
});

describe("paneTitleInTab — inside a space view, where project and tab are already established", () => {
  it("leads with the pane's own name, since repeating project · tab would say nothing", () => {
    const t = paneTitleInTab(pane({ tabLabel: "fix-auth", sessionName: "oauth-refactor" }));
    expect(t.primary).toBe("oauth-refactor");
    expect(t.secondary).toBe("~/dev/moonward");
  });

  it("falls back through paneDisplayName's precedence: label, session name, then agent", () => {
    expect(paneTitleInTab(pane({ paneLabel: "hand-named", sessionName: "auto" })).primary).toBe("hand-named");
    expect(paneTitleInTab(pane()).primary).toBe("claude");
    expect(paneTitleInTab(pane({ kind: "shell", agent: "shell" })).primary).toBe("shell");
  });
});

// A STALE TITLE — the program that printed it has exited, and the multiplexer kept it.
//
// Live-observed on tmux: a pane running a bare `bash` still carried `✳ waiting for soak time - server
// performance`, the title of a Claude that had finished hours before. The bridge marks the pair (see
// terminalTitleIsStale); the row's job is to stop reading that title as the pane's NAME while still
// showing it, because it is the only trace of what ran here.
describe("a stale terminal title", () => {
  const STALE = "✳ waiting for soak time - server performance";

  it("never leads the row — it drops below the cwd", () => {
    const t = paneParts(pane({ terminalTitle: STALE, terminalTitleStale: true }));
    expect(t.secondary).toBe("~/dev/moonward");
  });

  it("is still shown when there is nothing else to say", () => {
    const t = paneParts(pane({ cwd: "", terminalTitle: STALE, terminalTitleStale: true }));
    expect(t.secondary).toBe(STALE);
  });

  it("keeps the ✳ as the agent typed it — the glyph is Claude's text, not Collie's", () => {
    const t = paneParts(pane({ cwd: "", terminalTitle: STALE, terminalTitleStale: true }));
    expect(t.secondary).toContain("✳");
  });

  it("is not the pane's name: the row falls back to what it would be with no title at all", () => {
    const shell = { kind: "shell", agent: "shell" } as const;
    expect(paneTitleInTab(pane({ ...shell, terminalTitle: STALE, terminalTitleStale: true })).primary)
      .toBe("shell");
    // …and a live title still is the name, which is the control this test needs.
    expect(paneTitleInTab(pane({ ...shell, terminalTitle: STALE })).primary).toBe(STALE);
  });

  it("never outranks a name somebody chose", () => {
    const over = { terminalTitle: STALE, terminalTitleStale: true };
    expect(paneParts(pane({ ...over, paneLabel: "hand-named" })).secondary).toBe("hand-named");
    expect(paneTitleInTab(pane({ ...over, paneLabel: "hand-named" })).primary).toBe("hand-named");
  });
});

// THE CWD GATE THE PANE HEADER USES — and it is deliberately NOT `informativeCwd`.
//
// `informativeCwd` compares the directory's own name to the PROJECT, which is right in the herd list
// because there line 1 IS the project. The pane header's line 1 is `paneLabel ?? sessionName ??
// "space › tab"`, so the project may not be on screen at all — and run over the fixture herd, the
// project gate hid the path on 14 panes of 14, including every hand-named one, where the path was the
// only thing left naming the work. This gate asks the reader's own question instead: does the path
// show me a SEGMENT the name above it does not already show?
describe("cwdBeyondName — the header's cwd line", () => {
  it("hides the path when the name above it already shows every segment", () => {
    // The design's own specimen. `…/workspace-sprqvntrs/openplate` under
    // `workspace-sprqvntrs › openplate` is the same two tokens with slashes instead of a chevron —
    // three type sizes carrying two facts.
    expect(
      cwdBeyondName("/home/you/dev/workspace-sprqvntrs/openplate", "workspace-sprqvntrs › openplate"),
    ).toBeNull();
    // Order does not matter, and neither does case: it is a set of segments, not a prefix match.
    expect(cwdBeyondName("/home/you/openplate", "OpenPlate")).toBeNull();
  });

  it("keeps the path the moment it carries a segment the name does not", () => {
    // The case the line exists for: a pane sitting in a worktree, not at the space root.
    expect(cwdBeyondName("/home/you/dev/openplate/worktrees/fix-42", "openplate › build")).toBe(
      "~/dev/openplate/worktrees/fix-42",
    );
    // …and the case the PROJECT gate got wrong: a hand-set label names no directory at all, so the
    // path is the only thing on screen locating the work. `informativeCwd` hid this one.
    expect(cwdBeyondName("/home/you/src/sprqvntrs-api", "logs")).toBe("~/src/sprqvntrs-api");
  });

  it("never counts `~` or the elision marker as a segment", () => {
    // `~` is $HOME collapsed and `…` is shortCwd's "some segments dropped" mark. If either counted,
    // every home-relative path would look like it carried a segment the name lacks, and the gate
    // would never close.
    expect(cwdBeyondName("/home/you/openplate", "openplate")).toBeNull(); // `~/openplate`
    // A path long enough for shortCwd to drop its head keeps `…/` as the first token. The specimen
    // above is exactly that shape and still closes the gate, which is the proof: `…` is not a
    // segment.
    expect(
      cwdBeyondName(
        "/home/you/dev/workspace-sprqvntrs/openplate",
        "workspace-sprqvntrs › openplate",
      ),
    ).toBeNull();
  });

  it("says nothing when there is no path", () => {
    expect(cwdBeyondName("", "anything")).toBeNull();
  });

  it("leaves informativeCwd's own callers alone — the herd list still gates on the project", () => {
    // THE COUPLING, stated as a test so the two rules cannot be merged by a later edit that notices
    // they look alike. paneParts is informativeCwd's only caller: with the directory named after the
    // project the secondary line stays empty, and it does so for a pane whose NAME would have kept
    // the path under the header's gate.
    expect(paneParts(pane({ cwd: "/home/kon/dev/moonward_os" })).secondary).toBeNull();
    // …and the two genuinely disagree, which is the point: the header's gate keeps this path,
    // because `dev` is a segment the name `moonward_os` does not show. The herd list drops it,
    // because there line 1 IS `moonward_os` and eighteen rows would all repeat the same parent.
    expect(cwdBeyondName("/home/kon/dev/moonward_os", "moonward_os")).toBe("~/dev/moonward_os");
    // The hand-named pane is where the project gate actively misinforms: `informativeCwd` would hide
    // the path under a name that mentions no project at all.
    expect(paneParts(pane({ paneLabel: "logs", cwd: "/home/kon/dev/moonward_os" })).secondary).toBe(
      "logs",
    );
    expect(cwdBeyondName("/home/kon/dev/moonward_os", "logs")).toBe("~/dev/moonward_os");
  });
});
