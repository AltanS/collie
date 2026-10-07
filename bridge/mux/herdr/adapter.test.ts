import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { MuxSpace } from "../types.ts";
import { HerdrMux, REPO_LOOKUP_RETRY_MS, workspaceRepoOf } from "./adapter.ts";
import type { WireSnapshot, WireWorkspace, WireWorktreeListing } from "./client.ts";
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
