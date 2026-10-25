import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { MuxSpace } from "../types.ts";
import { HerdrMux, REPO_LOOKUP_RETRY_MS, workspaceRepoOf } from "./adapter.ts";
import type { PaneRead, WirePane, WireSnapshot, WireWorkspace, WireWorktreeListing } from "./client.ts";
import { FakeHerdr } from "./fixture.ts";

// WHICH REPO A WORKSPACE SITS IN, across the two Herdr shapes (ADR 0032).
//
// herdr 0.8.2 put it on the workspace record (`worktree.repo_root`). herdr 0.9.3 (protocol 22) keeps
// the field in its schema and no longer sends it: the 0.9.3 capture below is the real answer, and it
// is what left every space without `repoRoot` on the dev lane, so "New agent on a branch" never
// showed. The repo now comes from `worktree.list` by workspace, looked up once and cached.

interface Capture {
  version: string;
  protocol: number;
  workspaces: WireWorkspace[];
  worktreeList: Record<string, { result: WireWorktreeListing }>;
  notGit: { error: { code: string; message: string } };
}

// SAFETY: a file this repo checks in, captured from herdr 0.9.3 and scrubbed (see its `_comment`).
const CAPTURE = JSON.parse(
  readFileSync(join(import.meta.dir, "captures", "workspaces-0.9.3.json"), "utf8"),
) as Capture;

const NOT_GIT = `herdr worktree.list: ${CAPTURE.notGit.error.code}: ${CAPTURE.notGit.error.message}`;

/** What the fake answers one workspace's `worktree.list` with. */
type Answer = { readonly listing: WireWorktreeListing } | { readonly error: string };

/** The real adapter over a fake that answers from a fixed set of workspace records. */
class CapturedHerdr extends FakeHerdr {
  lookups: string[] = [];
  /** Per workspace: a listing, or the error Herdr answers. Absent is not_git_worktree. */
  answers = new Map<string, Answer>();

  constructor(public records: WireWorkspace[]) {
    super();
  }

  override async sessionSnapshot(): Promise<WireSnapshot> {
    return { version: CAPTURE.version, protocol: CAPTURE.protocol, workspaces: this.records, tabs: [], panes: [] };
  }

  override async workspaceWorktrees(workspaceId: string): Promise<WireWorktreeListing> {
    this.lookups.push(workspaceId);
    const answer = this.answers.get(workspaceId) ?? { error: NOT_GIT };
    if ("error" in answer) throw new Error(answer.error);
    return answer.listing;
  }
}

function captured(): CapturedHerdr {
  const fake = new CapturedHerdr(CAPTURE.workspaces);
  for (const [id, reply] of Object.entries(CAPTURE.worktreeList)) fake.answers.set(id, { listing: reply.result });
  return fake;
}

function spaceOf(spaces: readonly MuxSpace[], id: string): MuxSpace {
  const space = spaces.find((candidate) => candidate.spaceId === id);
  if (space === undefined) throw new Error(`no space ${id}`);
  return space;
}

const plainWorkspace = (id: string, label: string): WireWorkspace => ({
  workspace_id: id,
  number: 9,
  label,
  focused: false,
  pane_count: 1,
  tab_count: 1,
  active_tab_id: `${id}:t1`,
  agent_status: "idle",
});

describe("herdr 0.9.3: the repo comes from worktree.list", () => {
  test("the captured records carry no worktree field, which is the regression", () => {
    expect(CAPTURE.version).toBe("0.9.3");
    for (const workspace of CAPTURE.workspaces) expect(workspace.worktree).toBeUndefined();
  });

  test("every captured workspace gets repoRoot, isWorktree and its folder", async () => {
    const mux = new HerdrMux(captured(), () => []);
    const { spaces } = await mux.snapshot();
    expect(spaces).toHaveLength(4);
    expect(spaceOf(spaces, "w51")).toMatchObject({
      label: "harbor",
      repoRoot: "/home/operator/projects/harbor",
      isWorktree: false,
      folder: "/home/operator/projects/harbor",
    });
    for (const space of spaces) {
      expect(space.repoRoot).toBe(`/home/operator/projects/${space.label}`);
      expect(space.isWorktree).toBe(false);
    }
  });

  test("a workspace outside Git has no repo, and the snapshot still answers", async () => {
    const fake = captured();
    fake.records = [...CAPTURE.workspaces, plainWorkspace("w90", "scratch")];
    const { spaces } = await new HerdrMux(fake, () => []).snapshot();
    const scratch = spaceOf(spaces, "w90");
    expect("repoRoot" in scratch).toBe(false);
    expect("isWorktree" in scratch).toBe(false);
    expect("folder" in scratch).toBe(false);
  });

  test("foregroundProcesses answers the seeded argv and pid, null argv as no argv", async () => {
    const fake = new FakeHerdr();
    const [first] = await fake.listPanes();
    const paneId = first?.pane_id ?? "missing";
    fake.setProcesses(paneId, [
      { pid: 7, name: "muse", argv: ["muse", "resume", "abc"] },
      { pid: 8, name: "rg", argv: null },
    ]);
    const mux = new HerdrMux(fake, () => []);
    const result = await mux.foregroundProcesses(paneId);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.value : null).toEqual([
      { argv: ["muse", "resume", "abc"], pid: 7 },
      { argv: [], pid: 8 },
    ]);
  });

  test("foregroundProcesses on an unknown pane refuses instead of throwing", async () => {
    const mux = new HerdrMux(new FakeHerdr(), () => []);
    const result = await mux.foregroundProcesses("w9:nope");
    expect(result.ok).toBe(false);
  });

  test("looked up once per workspace, not once per poll", async () => {
    const fake = captured();
    fake.records = [...CAPTURE.workspaces, plainWorkspace("w90", "scratch")];
    const mux = new HerdrMux(fake, () => []);
    await mux.snapshot();
    await mux.snapshot();
    await Promise.all([mux.snapshot(), mux.snapshot()]);
    expect(fake.lookups.toSorted()).toEqual(["w2H", "w47", "w51", "w54", "w90"]);
  });

  test("overlapping first snapshots ask Herdr once", async () => {
    const fake = captured();
    const mux = new HerdrMux(fake, () => []);
    await Promise.all([mux.snapshot(), mux.snapshot(), mux.snapshot()]);
    expect(fake.lookups).toHaveLength(4);
  });

  test("a new workspace is looked up, a closed one is forgotten", async () => {
    const fake = captured();
    const mux = new HerdrMux(fake, () => []);
    await mux.snapshot();
    fake.records = CAPTURE.workspaces.filter((w) => w.workspace_id !== "w47");
    await mux.snapshot();
    fake.records = [...CAPTURE.workspaces];
    await mux.snapshot();
    // w47 came back as a workspace the cache had dropped, so it is asked again — once.
    expect(fake.lookups.filter((id) => id === "w47")).toHaveLength(2);
    expect(fake.lookups).toHaveLength(5);
  });

  test("a failed lookup leaves the space bare and is retried only after the backoff", async () => {
    const fake = captured();
    fake.answers.set("w51", { error: "herdr worktree.list: timed out after 5000ms" });
    const mux = new HerdrMux(fake, () => []);
    const first = await mux.snapshot();
    expect("repoRoot" in spaceOf(first.spaces, "w51")).toBe(false);
    expect(spaceOf(first.spaces, "w54").repoRoot).toBe("/home/operator/projects/kennel");

    await mux.snapshot();
    expect(fake.lookups.filter((id) => id === "w51")).toHaveLength(1);

    const realNow = Date.now;
    const start = realNow();
    Date.now = () => start + REPO_LOOKUP_RETRY_MS + 1;
    try {
      const harbor = CAPTURE.worktreeList["w51"];
      if (harbor === undefined) throw new Error("capture lost w51");
      fake.answers.set("w51", { listing: harbor.result });
      const later = await mux.snapshot();
      expect(spaceOf(later.spaces, "w51").repoRoot).toBe("/home/operator/projects/harbor");
    } finally {
      Date.now = realNow;
    }
    expect(fake.lookups.filter((id) => id === "w51")).toHaveLength(2);
  });

  test("the event stream coming up clears the cache", async () => {
    const fake = captured();
    const mux = new HerdrMux(fake, () => []);
    await mux.snapshot();
    let ups = 0;
    const watch = mux.watch({
      panes: [],
      onUp: () => void (ups += 1),
      onDown: () => undefined,
      onTopologyChange: () => undefined,
      onPaneChange: () => undefined,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(ups).toBe(1);
    await mux.snapshot();
    watch.close();
    expect(fake.lookups).toHaveLength(8);
  });

  test("a linked worktree is the entry that names the workspace, not source_checkout_path", () => {
    // Shape from a 0.9.3 probe of a linked worktree: `source` names the MAIN checkout even then.
    const listing: WireWorktreeListing = {
      source: {
        repo_root: "/home/operator/projects/kennel/collie",
        repo_key: "/home/operator/projects/kennel/collie/.git",
        repo_name: "collie",
        source_checkout_path: "/home/operator/projects/kennel/collie",
        source_workspace_id: "w54",
      },
      worktrees: [
        {
          path: "/home/operator/projects/kennel/collie",
          branch: "main",
          is_linked_worktree: false,
          is_prunable: false,
          is_bare: false,
          is_detached: false,
          open_workspace_id: "w54",
        },
        {
          path: "/home/operator/apps/collie-remix",
          branch: "remix-v3",
          is_linked_worktree: true,
          is_prunable: false,
          is_bare: false,
          is_detached: false,
          open_workspace_id: "w60",
        },
      ],
    };
    expect(workspaceRepoOf("w60", listing)).toEqual({
      repoRoot: "/home/operator/projects/kennel/collie",
      isWorktree: true,
      folder: "/home/operator/apps/collie-remix",
    });
    expect(workspaceRepoOf("w54", listing)).toEqual({
      repoRoot: "/home/operator/projects/kennel/collie",
      isWorktree: false,
      folder: "/home/operator/projects/kennel/collie",
    });
    // No entry names it: the repo is known, the checkout is not — no folder, and not a worktree.
    expect(workspaceRepoOf("w77", listing)).toEqual({
      repoRoot: "/home/operator/projects/kennel/collie",
      isWorktree: false,
    });
    expect(workspaceRepoOf("w54", { ...listing, source: { repo_root: "" } })).toBeNull();
  });
});

describe("herdr 0.8.2: the repo is on the workspace record", () => {
  // The record shape probed 2026-08-28 on herdr 0.8.2, as 0.9.3's schema still describes it
  // (WorkspaceWorktreeInfo). Read straight off the record; no worktree.list call is made.
  const linked: WireWorkspace = {
    ...plainWorkspace("w3", "feature"),
    worktree: {
      repo_root: "/home/operator/projects/kennel/collie",
      repo_name: "collie",
      repo_key: "/home/operator/projects/kennel/collie/.git",
      checkout_path: "/home/operator/projects/kennel/collie/.worktrees/feature",
      is_linked_worktree: true,
    },
  };
  const main: WireWorkspace = {
    ...plainWorkspace("w1", "collie"),
    worktree: {
      repo_root: "/home/operator/projects/kennel/collie",
      checkout_path: "/home/operator/projects/kennel/collie",
      is_linked_worktree: false,
    },
  };

  test("repoRoot, isWorktree and folder come from the record, with no lookup", async () => {
    const fake = new CapturedHerdr([main, linked]);
    const { spaces } = await new HerdrMux(fake, () => []).snapshot();
    expect(spaceOf(spaces, "w3")).toMatchObject({
      repoRoot: "/home/operator/projects/kennel/collie",
      isWorktree: true,
      folder: "/home/operator/projects/kennel/collie/.worktrees/feature",
    });
    expect(spaceOf(spaces, "w1")).toMatchObject({
      repoRoot: "/home/operator/projects/kennel/collie",
      isWorktree: false,
    });
    expect(fake.lookups).toEqual([]);
  });

  test("a 0.8.2 record without the field is looked up like a 0.9.3 one", async () => {
    const fake = new CapturedHerdr([main, plainWorkspace("w5", "notes")]);
    const { spaces } = await new HerdrMux(fake, () => []).snapshot();
    expect(fake.lookups).toEqual(["w5"]);
    expect("repoRoot" in spaceOf(spaces, "w5")).toBe(false);
  });
});

describe("pasteBlock: one bracketed paste, framed by the adapter", () => {
  /** A fake that keeps every `pane.send_text` payload as sent. */
  class TextHerdr extends FakeHerdr {
    sent: Array<[string, string]> = [];
    override async sendPaneText(paneId: string, text: string): Promise<void> {
      this.sent.push([paneId, text]);
    }
  }

  test("the whole text, line breaks included, goes in ONE send_text between the paste markers", async () => {
    const fake = new TextHerdr();
    const ack = await new HerdrMux(fake, () => []).pasteBlock("w1:p1", "first line\nsecond line");
    expect(ack.ok).toBe(true);
    expect(fake.sent).toEqual([["w1:p1", "\u001b[200~first line\nsecond line\u001b[201~"]]);
  });

  test("every control byte but the line break is cut, the 8-bit CSI too, so nothing can end the paste early", async () => {
    const fake = new TextHerdr();
    const mux = new HerdrMux(fake, () => []);
    await mux.pasteBlock("w1:p1", "a\u001b[201~\rb\u009b201~c\u0007\u007f\nd");
    await mux.pasteBlock("w1:p1", "");
    await mux.pasteBlock("w1:p1", "\u001b\u009b");
    expect(fake.sent).toEqual([["w1:p1", "\u001b[200~a[201~b201~c\nd\u001b[201~"]]);
  });
});

describe("readGrid viewport: the live screen, whatever the operator's scroll", () => {
  /** A fake that logs every `pane.read` as asked: source, lines, format. */
  class ReadLog extends FakeHerdr {
    reads: Array<[string, number, string]> = [];
    override async readPane(paneId: string, source: string, lines: number, format = "text"): Promise<PaneRead> {
      this.reads.push([source, lines, format]);
      return super.readPane(paneId, source, lines, format);
    }
  }

  /** The seeded agent pane and the two rows its live screen holds. */
  async function agentPane(fake: FakeHerdr): Promise<{ id: string; live: string[] }> {
    const id = (await fake.listPanes())[0]!.pane_id;
    return { id, live: ["$ shell in /home/dev/collie", `pane ${id} on screen`] };
  }

  test("an unscrolled pane reads its visible screen", async () => {
    const fake = new ReadLog();
    const { id, live } = await agentPane(fake);
    const read = await new HerdrMux(fake, () => []).readGrid(id, { scope: "viewport", lines: 120, styling: "strip" });
    expect(read.ok && read.value.text.split("\n")).toEqual(live);
    expect(fake.reads).toEqual([["visible", 120, "text"]]);
  });

  test("a pane scrolled up on the desktop still reads the live screen, not the old rows in view", async () => {
    const fake = new ReadLog();
    const { id, live } = await agentPane(fake);
    fake.scrollPane(id, 5);
    const mux = new HerdrMux(fake, () => []);
    // The live screen is the bottom of the read; a screen the program has not filled may carry
    // scrollback rows above it, never more rows than the viewport holds (24 in the fake).
    const stripped = await mux.readGrid(id, { scope: "viewport", lines: 120, styling: "strip" });
    const rows = stripped.ok ? stripped.value.text.split("\n") : [];
    expect(rows.slice(-2)).toEqual(live);
    expect(rows.length).toBe(24);
    expect(stripped.ok && stripped.value.text).not.toContain("\u001b");
    const preserved = await mux.readGrid(id, { scope: "viewport", lines: 120, styling: "preserve" });
    expect(preserved.ok && preserved.value.text.split("\n").at(-1)).toContain(`pane ${id} on screen`);
    // Both reads are `recent` in `ansi`, the read that never harvests an alt-screen pane.
    expect(fake.reads).toEqual([
      ["recent", 24, "ansi"],
      ["recent", 24, "ansi"],
    ]);
  });

  test("a text read of a scrolled pane cuts every CSI sequence, not only plain SGR", async () => {
    class Painted extends FakeHerdr {
      override async readPane(): Promise<PaneRead> {
        return { pane_id: "x", text: "\u001b[1;38:2::255:0:0mX\u001b[0m\u001b[K", truncated: false, revision: 1 };
      }
    }
    const fake = new Painted();
    const { id } = await agentPane(fake);
    fake.scrollPane(id, 5);
    const read = await new HerdrMux(fake, () => []).readGrid(id, { scope: "viewport", lines: 120, styling: "strip" });
    expect(read.ok && read.value.text).toBe("X");
  });

  test("a pane record that cannot be read, is empty or has no scroll leaves the visible read", async () => {
    class NoGet extends FakeHerdr {
      override async getPane(): Promise<never> {
        throw new Error("herdr pane.get: unknown variant");
      }
    }
    class EmptyGet extends FakeHerdr {
      override async getPane(): Promise<never> {
        // SAFETY: a reply with no `pane` key is what this case models; the adapter must not read it.
        return undefined as never;
      }
    }
    class NoScroll extends FakeHerdr {
      override async getPane(paneId: string): Promise<WirePane> {
        return { ...(await super.getPane(paneId)), scroll: null };
      }
    }
    for (const fake of [new NoGet(), new EmptyGet(), new NoScroll()]) {
      const { id, live } = await agentPane(fake);
      const read = await new HerdrMux(fake, () => []).readGrid(id, { scope: "viewport", lines: 120, styling: "strip" });
      expect(read.ok && read.value.text.split("\n")).toEqual(live);
    }
  });
});
