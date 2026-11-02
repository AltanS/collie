import { describe, expect, test } from "bun:test";

import { declareCapabilities } from "./mux/capabilities.ts";
import {
  muxAck,
  muxGone,
  muxOk,
  type MuxAdapter,
  type MuxPane,
  type MuxSnapshot,
  type MuxSpace,
  type MuxSubscription,
} from "./mux/types.ts";
import type { RepoFacts } from "./repo-facts.ts";
import { REPO_FACTS_TTL_MS, withRepoFacts } from "./repo-facts-mux.ts";

function space(spaceId: string, over: Partial<MuxSpace> = {}): MuxSpace {
  return { spaceId, number: 1, label: spaceId, focused: false, activeTabId: "t", tabCount: 1, paneCount: 1, ...over };
}

function pane(spaceId: string, cwd: string, paneId = `${spaceId}-p`): MuxPane {
  return { paneId, spaceId, spaceLabel: spaceId, spaceNumber: 1, tabId: "t", cwd, focused: false, alive: true, agent: "shell", status: "unknown" };
}

/** A fake adapter written as a class, so prototype methods are proved to pass through. */
class FakeAdapter implements MuxAdapter {
  readonly mux = "fake";
  logo?: string;
  capabilities = declareCapabilities({ supports: ["paneGrid", "typeText"], topologyLatency: { kind: "push" } });
  snap: MuxSnapshot = { panes: [], spaces: [], tabs: [] };
  readonly calls: string[] = [];
  readonly subscription: MuxSubscription = { close: () => undefined };

  reachable() { this.calls.push("reachable"); return Promise.resolve(true); }
  refresh() { this.calls.push("refresh"); return Promise.resolve(); }
  snapshot() { this.calls.push("snapshot"); return Promise.resolve(this.snap); }
  readGrid(paneId: string) { this.calls.push("readGrid"); return Promise.resolve(muxOk({ paneId, text: "g", truncated: false, revision: 1 })); }
  typeText() { this.calls.push("typeText"); return Promise.resolve(muxAck()); }
  writeKeys() { this.calls.push("writeKeys"); return Promise.resolve(muxAck()); }
  renamePane() { this.calls.push("renamePane"); return Promise.resolve(muxAck()); }
  closePane() { this.calls.push("closePane"); return Promise.resolve(muxGone("gone")); }
  setFocus() { this.calls.push("setFocus"); return Promise.resolve(muxAck()); }
  createTab() { this.calls.push("createTab"); return Promise.resolve(muxOk({ paneId: "%9", spaceId: "s", spaceLabel: "s", tabId: "t", cwd: "/tmp" })); }
  renameTab() { this.calls.push("renameTab"); return Promise.resolve(muxAck()); }
  closeTab() { this.calls.push("closeTab"); return Promise.resolve(muxAck()); }
  createSpace() { this.calls.push("createSpace"); return Promise.resolve(muxOk({ paneId: "%9", spaceId: "s", spaceLabel: "s", tabId: "t", cwd: "/tmp" })); }
  listSessions() { this.calls.push("listSessions"); return Promise.resolve(muxOk([])); }
  listWorktrees() { this.calls.push("listWorktrees"); return Promise.resolve(muxOk([])); }
  createWorktree() { this.calls.push("createWorktree"); return Promise.resolve(muxOk({ paneId: "%9", spaceId: "s", spaceLabel: "s", tabId: "t", cwd: "/tmp" })); }
  openWorktree() { this.calls.push("openWorktree"); return Promise.resolve(muxOk({ pane: { paneId: "%9", spaceId: "s", spaceLabel: "s", tabId: "t", cwd: "/tmp" }, alreadyOpen: false })); }
  watch() { this.calls.push("watch"); return this.subscription; }
}

/** A facts source that records what it was asked, over a fixed table. */
function factsOver(table: Record<string, RepoFacts | null>) {
  const asked: string[] = [];
  return { asked, facts: (folder: string) => { asked.push(folder); return Promise.resolve(table[folder] ?? null); } };
}

const MAIN: RepoFacts = { repoRoot: "/r/main", isWorktree: false };
const LINKED: RepoFacts = { repoRoot: "/r/main", isWorktree: true };

describe("withRepoFacts", () => {
  test("fills repoRoot and isWorktree from a space's own folder", async () => {
    const fake = new FakeAdapter();
    fake.snap = { panes: [], tabs: [], spaces: [space("a", { folder: "/r/main" }), space("b", { folder: "/r/wt" })] };
    const src = factsOver({ "/r/main": MAIN, "/r/wt": LINKED });
    const out = await withRepoFacts(fake, src).snapshot();
    expect(out.spaces[0]).toMatchObject({ folder: "/r/main", repoRoot: "/r/main", isWorktree: false });
    expect(out.spaces[1]).toMatchObject({ folder: "/r/wt", repoRoot: "/r/main", isWorktree: true });
  });

  test("fills folder from the first pane's absolute cwd when the space has none", async () => {
    const fake = new FakeAdapter();
    fake.snap = { panes: [pane("a", "/r/wt", "a1"), pane("a", "/elsewhere", "a2")], tabs: [], spaces: [space("a")] };
    const out = await withRepoFacts(fake, factsOver({ "/r/wt": LINKED })).snapshot();
    expect(out.spaces[0]).toMatchObject({ folder: "/r/wt", repoRoot: "/r/main", isWorktree: true });
  });

  test("a space with no folder and no absolute pane cwd is left exactly as it is", async () => {
    const fake = new FakeAdapter();
    const bare = space("a");
    const relative = space("b");
    fake.snap = { panes: [pane("a", ""), pane("b", "relative/dir")], tabs: [], spaces: [bare, relative] };
    const src = factsOver({});
    const out = await withRepoFacts(fake, src).snapshot();
    expect(out.spaces[0]).toBe(bare);
    expect(out.spaces[1]).toBe(relative);
    expect(src.asked).toEqual([]);
  });

  test("the wrapper's value wins over what the adapter set", async () => {
    const fake = new FakeAdapter();
    fake.snap = { panes: [], tabs: [], spaces: [space("a", { folder: "/r/wt", repoRoot: "/stale", isWorktree: false })] };
    const out = await withRepoFacts(fake, factsOver({ "/r/wt": LINKED })).snapshot();
    expect(out.spaces[0]).toMatchObject({ repoRoot: "/r/main", isWorktree: true });
  });

  test("when the disk states no facts, the adapter's own values stay", async () => {
    const fake = new FakeAdapter();
    fake.snap = { panes: [], tabs: [], spaces: [space("a", { folder: "/plain", repoRoot: "/theirs", isWorktree: false })] };
    const out = await withRepoFacts(fake, factsOver({})).snapshot();
    expect(out.spaces[0]).toMatchObject({ repoRoot: "/theirs", isWorktree: false });
  });

  test("two spaces in one folder read the disk once, and the next snapshot reads it zero times", async () => {
    const fake = new FakeAdapter();
    fake.snap = { panes: [], tabs: [], spaces: [space("a", { folder: "/r/main" }), space("b", { folder: "/r/main" })] };
    const src = factsOver({ "/r/main": MAIN });
    const wrapped = withRepoFacts(fake, src);
    await wrapped.snapshot();
    await wrapped.snapshot();
    expect(src.asked).toEqual(["/r/main"]);
  });

  test("the cache drops a folder no space names any more, so it stays within the last snapshot", async () => {
    const fake = new FakeAdapter();
    const src = factsOver({ "/r/a": MAIN, "/r/b": MAIN });
    const wrapped = withRepoFacts(fake, src);
    fake.snap = { panes: [], tabs: [], spaces: [space("a", { folder: "/r/a" })] };
    await wrapped.snapshot();
    fake.snap = { panes: [], tabs: [], spaces: [space("b", { folder: "/r/b" })] };
    await wrapped.snapshot();
    // /r/a left the snapshot, so naming it again is a miss.
    fake.snap = { panes: [], tabs: [], spaces: [space("a", { folder: "/r/a" })] };
    await wrapped.snapshot();
    expect(src.asked).toEqual(["/r/a", "/r/b", "/r/a"]);
  });

  test("an entry expires after the TTL, so a git init or a removed worktree is seen", async () => {
    const fake = new FakeAdapter();
    fake.snap = { panes: [], tabs: [], spaces: [space("a", { folder: "/r/main" })] };
    let clock = 1_000;
    const src = factsOver({ "/r/main": MAIN });
    const wrapped = withRepoFacts(fake, { ...src, now: () => clock });
    await wrapped.snapshot();
    clock += REPO_FACTS_TTL_MS - 1;
    await wrapped.snapshot();
    expect(src.asked.length).toBe(1);
    clock += 1;
    await wrapped.snapshot();
    expect(src.asked.length).toBe(2);
  });

  test("tabs and panes ride through unchanged", async () => {
    const fake = new FakeAdapter();
    fake.snap = { panes: [pane("a", "/r/main")], tabs: [], spaces: [space("a")] };
    const out = await withRepoFacts(fake, factsOver({})).snapshot();
    expect(out.panes).toBe(fake.snap.panes);
    expect(out.tabs).toBe(fake.snap.tabs);
  });

  test("declares what the wrapped adapter declares, and carries the mark only when there is one", () => {
    const fake = new FakeAdapter();
    const bare = withRepoFacts(fake, factsOver({}));
    expect(bare.capabilities).toEqual(fake.capabilities);
    expect(bare.mux).toBe("fake");
    expect("logo" in bare).toBe(false);
    fake.logo = "<svg></svg>";
    expect(withRepoFacts(fake, factsOver({})).logo).toBe("<svg></svg>");
  });

  test("every other verb reaches the adapter underneath", async () => {
    const fake = new FakeAdapter();
    const w = withRepoFacts(fake, factsOver({}));
    await w.reachable();
    await w.refresh();
    await w.readGrid("p", { scope: "viewport", lines: 10, styling: "strip" });
    await w.typeText("p", "x");
    await w.writeKeys("p", ["Enter"]);
    await w.renamePane("p", null);
    await w.closePane("p");
    await w.setFocus("p");
    await w.createTab({ spaceId: "s" });
    await w.renameTab("t", "x");
    await w.closeTab("t");
    await w.createSpace({ cwd: "/tmp" });
    await w.listSessions();
    await w.listWorktrees({ repoRoot: "/r" });
    await w.createWorktree({ repoRoot: "/r", branch: "b" });
    await w.openWorktree({ repoRoot: "/r", path: "/r/wt" });
    expect(w.watch({ panes: [], onTopologyChange: () => undefined, onPaneChange: () => undefined, onUp: () => undefined, onDown: () => undefined })).toBe(fake.subscription);
    expect(fake.calls).toEqual([
      "reachable", "refresh", "readGrid", "typeText", "writeKeys", "renamePane", "closePane", "setFocus",
      "createTab", "renameTab", "closeTab", "createSpace", "listSessions", "listWorktrees", "createWorktree",
      "openWorktree", "watch",
    ]);
  });
});
