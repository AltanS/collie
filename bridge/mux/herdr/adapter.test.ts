import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { MuxSpace } from "../types.ts";
import { HerdrMux, SCROLL_STATE_MEMO_MS } from "./adapter.ts";
import { HerdrNoReply, HerdrTimeout, type CreatedShell, type PaneRead, type WirePane, type WireSnapshot, type WireWorkspace } from "./client.ts";
import { FakeHerdr } from "./fixture.ts";

// THE SPACE'S FOLDER, across the two Herdr shapes (ADR 0032, ADR 0126).
//
// herdr 0.8.2 put the repo on the workspace record (`worktree`). herdr 0.9.3 (protocol 22) keeps the
// field in its schema and no longer sends it. The adapter reads no repo from either: `repoRoot` and
// `isWorktree` come from the folder on disk, for every multiplexer (bridge/repo-facts-mux.ts). All the
// adapter sets is `folder`, and only when the record names a checkout.

interface Capture {
  version: string;
  protocol: number;
  workspaces: WireWorkspace[];
}

// SAFETY: a file this repo checks in, captured from herdr 0.9.3 and scrubbed (see its `_comment`).
const CAPTURE = JSON.parse(
  readFileSync(join(import.meta.dir, "captures", "workspaces-0.9.3.json"), "utf8"),
) as Capture;

/** The real adapter over a fake that answers from a fixed set of workspace records. */
class CapturedHerdr extends FakeHerdr {
  constructor(public records: WireWorkspace[]) {
    super();
  }

  override async sessionSnapshot(): Promise<WireSnapshot> {
    return { version: CAPTURE.version, protocol: CAPTURE.protocol, workspaces: this.records, tabs: [], panes: [] };
  }
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

describe("a pane reports where its foreground agent is working", () => {
  test.each(["/private/tmp", "/tmp/work outside the workspace"])(
    "prefers foreground cwd %s to the pane's launch folder",
    async (foreground) => {
      class ForegroundHerdr extends FakeHerdr {
        override async sessionSnapshot(): Promise<WireSnapshot> {
          const snapshot = await super.sessionSnapshot();
          return {
            ...snapshot,
            panes: snapshot.panes.map((pane) =>
              Object.assign({}, pane, {
                cwd: "/home/operator",
                foreground_cwd: foreground,
              }),
            ),
          };
        }
      }
      const { panes } = await new HerdrMux(new ForegroundHerdr(), () => []).snapshot();
      expect(panes.length).toBeGreaterThan(0);
      for (const pane of panes) expect(pane.cwd).toBe(foreground);
    },
  );

  test("falls back to cwd when foreground_cwd is empty or absent", async () => {
    class EmptyForegroundHerdr extends FakeHerdr {
      override async sessionSnapshot(): Promise<WireSnapshot> {
        const snapshot = await super.sessionSnapshot();
        return {
          ...snapshot,
          panes: snapshot.panes.map((pane) =>
            Object.assign({}, pane, {
              cwd: "/home/operator",
              foreground_cwd: "",
            }),
          ),
        };
      }
    }
    const { panes } = await new HerdrMux(new EmptyForegroundHerdr(), () => []).snapshot();
    expect(panes.length).toBeGreaterThan(0);
    for (const pane of panes) expect(pane.cwd).toBe("/home/operator");
  });
});

describe("herdr 0.9.3: the record names no repo", () => {
  test("the captured records carry no worktree field", () => {
    expect(CAPTURE.version).toBe("0.9.3");
    for (const workspace of CAPTURE.workspaces) expect(workspace.worktree).toBeUndefined();
  });

  test("a space has no repoRoot, isWorktree or folder from the adapter", async () => {
    const { spaces } = await new HerdrMux(new CapturedHerdr(CAPTURE.workspaces), () => []).snapshot();
    expect(spaces).toHaveLength(4);
    for (const space of spaces) {
      expect("repoRoot" in space).toBe(false);
      expect("isWorktree" in space).toBe(false);
      expect("folder" in space).toBe(false);
    }
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
});

describe("herdr 0.8.2: the folder is on the workspace record", () => {
  // The record shape probed 2026-08-28 on herdr 0.8.2 (WorkspaceWorktreeInfo).
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

  test("folder comes from the record, and the repo facts are left to the bridge", async () => {
    const { spaces } = await new HerdrMux(new CapturedHerdr([main, linked]), () => []).snapshot();
    expect(spaceOf(spaces, "w3").folder).toBe("/home/operator/projects/kennel/collie/.worktrees/feature");
    expect(spaceOf(spaces, "w1").folder).toBe("/home/operator/projects/kennel/collie");
    for (const space of spaces) {
      expect("repoRoot" in space).toBe(false);
      expect("isWorktree" in space).toBe(false);
    }
  });

  test("a record without the field has no folder", async () => {
    const { spaces } = await new HerdrMux(new CapturedHerdr([plainWorkspace("w5", "notes")]), () => []).snapshot();
    expect("folder" in spaceOf(spaces, "w5")).toBe(false);
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

  test("two reads inside the memo window make one pane.get, and one after it asks again", async () => {
    class CountGet extends FakeHerdr {
      gets = 0;
      override async getPane(paneId: string): Promise<WirePane> {
        this.gets++;
        return super.getPane(paneId);
      }
    }
    const fake = new CountGet();
    const { id } = await agentPane(fake);
    let clock = 10_000;
    const mux = new HerdrMux(fake, () => [], () => clock);
    const viewport = { scope: "viewport", lines: 120, styling: "strip" } as const;
    await mux.readGrid(id, viewport);
    clock += SCROLL_STATE_MEMO_MS - 1;
    await mux.readGrid(id, viewport);
    expect(fake.gets).toBe(1);
    clock += 1;
    await mux.readGrid(id, viewport);
    expect(fake.gets).toBe(2);
  });

  test("reads that overlap share one pane.get, and a recent read asks none", async () => {
    class CountGet extends FakeHerdr {
      gets = 0;
      override async getPane(paneId: string): Promise<WirePane> {
        this.gets++;
        return super.getPane(paneId);
      }
    }
    const fake = new CountGet();
    const { id } = await agentPane(fake);
    const mux = new HerdrMux(fake, () => []);
    await Promise.all([1, 2, 3].map(() => mux.readGrid(id, { scope: "viewport", lines: 120, styling: "strip" })));
    expect(fake.gets).toBe(1);
    await mux.readGrid(id, { scope: "recent", lines: 120, styling: "preserve" });
    expect(fake.gets).toBe(1);
  });
});

describe("whether a space has a name of its own (M98)", () => {
  /** Seeded panes sit in w1 and w5; this fake relabels them and can drop a workspace record. */
  class LabelledHerdr extends FakeHerdr {
    constructor(private readonly labelOf: (id: string) => string | null) {
      super();
    }

    override async sessionSnapshot(): Promise<WireSnapshot> {
      const snapshot = await super.sessionSnapshot();
      const workspaces: WireWorkspace[] = [];
      for (const workspace of snapshot.workspaces) {
        const label = this.labelOf(workspace.workspace_id);
        if (label !== null) workspaces.push({ ...workspace, label });
      }
      return { ...snapshot, workspaces };
    }
  }

  const spaceNamedBy = async (fake: FakeHerdr): Promise<Record<string, boolean | undefined>> => {
    const { panes } = await new HerdrMux(fake, () => []).snapshot();
    return Object.fromEntries(panes.map((pane) => [pane.spaceId, pane.spaceNamed]));
  };

  test("a workspace listed with a label of its own is named", async () => {
    expect(await spaceNamedBy(new LabelledHerdr((id) => `name of ${id}`))).toEqual({ w1: true, w5: true });
  });

  test("a label that is the id, or empty, is not a name", async () => {
    expect(await spaceNamedBy(new LabelledHerdr((id) => (id === "w1" ? id : "  ")))).toEqual({ w1: false, w5: false });
  });

  test("a pane whose workspace the listing does not hold fell back to its id: not named", async () => {
    expect(await spaceNamedBy(new LabelledHerdr((id) => (id === "w1" ? "kept" : null)))).toEqual({ w1: true, w5: false });
  });
});

// A WORKTREE OPENED AS A WORKTREE (issue 732, ADR 0126 note of 2026-11-13).
//
// The bridge makes a linked checkout with git and asks the adapter for a space. When it says the
// folder is a worktree, Herdr's `worktree.open` records it, so the sidebar nests it under its
// repository. Everything else about the space is what `workspace.create` gave.

describe("a space whose folder is a linked worktree", () => {
  const ASKED = { cwd: "/srv/repo-wt/feat-x", label: "feat-x", worktree: { repoRoot: "/srv/repo" } };

  /** A fake whose `worktree.open` answers as the real client folds an answer or a failure. */
  class OpenFails extends FakeHerdr {
    plainCreates = 0;
    constructor(private readonly failure: Error) {
      super();
    }

    override async openWorktree(opts: { cwd: string; path: string; label?: string }): Promise<CreatedShell> {
      this.worktreeOpens.push(opts);
      throw this.failure;
    }

    override async createWorkspace(opts: { cwd: string; label?: string }): Promise<CreatedShell> {
      this.plainCreates += 1;
      return super.createWorkspace(opts);
    }
  }

  const unknownMethod = () =>
    new Error("herdr worktree.open: invalid_request: invalid request: unknown variant `worktree.open`, expected one of `ping`");

  test("is opened with worktree.open: repo root as cwd, the checkout as path, the label kept", async () => {
    const fake = new FakeHerdr();
    const mux = new HerdrMux(fake, () => []);
    const created = await mux.createSpace(ASKED);
    expect(fake.worktreeOpens).toEqual([{ cwd: "/srv/repo", path: "/srv/repo-wt/feat-x", label: "feat-x" }]);
    if (!created.ok) throw new Error(created.detail);
    expect(created.value.cwd).toBe("/srv/repo-wt/feat-x");
    expect(created.value.spaceLabel).toBe("feat-x");
    // The answer maps to the same record a plain create gives: the new space is in the next snapshot.
    const { spaces, panes } = await mux.snapshot();
    expect(spaces.some((space) => space.spaceId === created.value.spaceId)).toBe(true);
    expect(panes.some((pane) => pane.paneId === created.value.paneId)).toBe(true);
  });

  test("a label is left off when none is asked for", async () => {
    const fake = new FakeHerdr();
    await new HerdrMux(fake, () => []).createSpace({ cwd: "/srv/repo-wt/x", worktree: { repoRoot: "/srv/repo" } });
    expect(fake.worktreeOpens).toEqual([{ cwd: "/srv/repo", path: "/srv/repo-wt/x" }]);
  });

  test("a plain request never calls worktree.open", async () => {
    const fake = new FakeHerdr();
    const created = await new HerdrMux(fake, () => []).createSpace({ cwd: "/srv/plain", label: "plain" });
    expect(created.ok).toBe(true);
    expect(fake.worktreeOpens).toEqual([]);
  });

  test("a Herdr without the method opens a plain space, and is not asked a second time", async () => {
    const fake = new OpenFails(unknownMethod());
    const mux = new HerdrMux(fake, () => []);
    const first = await mux.createSpace(ASKED);
    const second = await mux.createSpace({ ...ASKED, label: "feat-y" });
    expect(first.ok && second.ok).toBe(true);
    expect(fake.worktreeOpens).toHaveLength(1);
    expect(fake.plainCreates).toBe(2);
  });

  test("an answer that refuses the folder falls back to a plain space, and the next one asks again", async () => {
    const fake = new OpenFails(new Error("herdr worktree.open: worktree_not_found: worktree path not found"));
    const mux = new HerdrMux(fake, () => []);
    const first = await mux.createSpace(ASKED);
    await mux.createSpace(ASKED);
    expect(first.ok).toBe(true);
    expect(fake.plainCreates).toBe(2);
    expect(fake.worktreeOpens).toHaveLength(2);
  });

  test("a timeout is unconfirmed, not a second space: the open may have happened", async () => {
    const fake = new OpenFails(new HerdrTimeout("worktree.open", 5000));
    const created = await new HerdrMux(fake, () => []).createSpace(ASKED);
    expect(created.ok).toBe(false);
    expect(created.ok ? "" : created.reason).toBe("unconfirmed");
    expect(fake.plainCreates).toBe(0);
  });

  test("the retry after a timeout opens no second space on that folder", async () => {
    // The open happened and the answer was lost: the caller sees a refusal and asks again.
    class AnswerLost extends FakeHerdr {
      lose = true;
      override async openWorktree(opts: { cwd: string; path: string; label?: string }): Promise<CreatedShell> {
        const opened = await super.openWorktree(opts);
        if (!this.lose) return opened;
        throw new HerdrTimeout("worktree.open", 5000);
      }
    }
    const fake = new AnswerLost();
    const mux = new HerdrMux(fake, () => []);
    const before = (await mux.snapshot()).spaces.length;
    expect((await mux.createSpace(ASKED)).ok).toBe(false);
    fake.lose = false;
    const retried = await mux.createSpace(ASKED);
    expect(retried.ok).toBe(true);
    expect((await mux.snapshot()).spaces.length).toBe(before + 1);
  });

  test("a dropped connection is a refusal too", async () => {
    const fake = new OpenFails(new HerdrNoReply("worktree.open"));
    const created = await new HerdrMux(fake, () => []).createSpace(ASKED);
    expect(created.ok).toBe(false);
    expect(fake.plainCreates).toBe(0);
  });
});

// M100 spec 03, item 2: a text write Herdr did not answer in time may still have reached the pane. It is
// `unconfirmed` (the caller reads the box), not `unreachable` (which read as "nothing typed").
describe("a text write Herdr does not confirm in time", () => {
  class LateHerdr extends FakeHerdr {
    override async sendPaneText(paneId: string, text: string): Promise<void> {
      void paneId;
      void text;
      throw new HerdrTimeout("pane.send_text", 5000);
    }
  }

  test("typeText and pasteBlock answer unconfirmed, and say it may still arrive", async () => {
    const mux = new HerdrMux(new LateHerdr(), () => []);
    for (const ack of [await mux.typeText("w1:p1", "hello"), await mux.pasteBlock("w1:p1", "a\nb")]) {
      expect(ack.ok ? "ok" : ack.reason).toBe("unconfirmed");
      if (!ack.ok) expect(ack.detail).toContain("may still arrive");
    }
  });

  test("any other failure of the write stays unreachable", async () => {
    class DeadHerdr extends FakeHerdr {
      override async sendPaneText(): Promise<void> {
        throw new Error("herdr pane.send_text: connection closed");
      }
    }
    const ack = await new HerdrMux(new DeadHerdr(), () => []).typeText("w1:p1", "hello");
    expect(ack.ok ? "ok" : ack.reason).toBe("unreachable");
  });
});

// M100 spec 03: a connection Herdr closed after the request went out may follow a write it acted on, so a
// text write and a key write answer `unconfirmed`, never `unreachable` ("nothing typed"). A dial that never
// reached Herdr stays `unreachable`.
describe("a write whose connection Herdr closed before the reply", () => {
  test("typeText, pasteBlock and writeKeys answer unconfirmed, and say it may have arrived", async () => {
    const fake = new FakeHerdr();
    const mux = new HerdrMux(fake, () => []);
    const pane = (await mux.snapshot()).panes[0]!;
    const acks = [];
    fake.nextWrite = "closed";
    acks.push(await mux.typeText(pane.paneId, "hello"));
    fake.nextWrite = "closed";
    acks.push(await mux.pasteBlock(pane.paneId, "a\nb"));
    fake.nextKeys = "closed";
    acks.push(await mux.writeKeys(pane.paneId, ["Enter"]));
    for (const ack of acks) {
      expect(ack.ok ? "ok" : ack.reason).toBe("unconfirmed");
      if (!ack.ok) expect(ack.detail).toContain("Herdr closed the connection before it confirmed");
      if (!ack.ok) expect(ack.detail).not.toContain("in time");
    }
    expect(fake.writes()).toEqual([]);
  });

  test("a socket error after the request went out reads the same, with the error's words in brackets", async () => {
    class ResetHerdr extends FakeHerdr {
      override async sendPaneText(): Promise<void> {
        await Promise.resolve();
        throw new HerdrNoReply("pane.send_text", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      }
    }
    const fake = new ResetHerdr();
    const mux = new HerdrMux(fake, () => []);
    const pane = (await mux.snapshot()).panes[0]!;
    const ack = await mux.typeText(pane.paneId, "hello");
    expect(ack.ok ? "ok" : ack.reason).toBe("unconfirmed");
    if (!ack.ok) expect(ack.detail).toBe(`Herdr closed the connection before it confirmed the text written to ${pane.paneId} (herdr pane.send_text: read ECONNRESET). It may have arrived, so it was not written again.`);
  });

  test("a dial that never reached Herdr is unreachable, for text and for keys", async () => {
    const dead = () => Object.assign(new Error("Failed to connect"), { code: "ECONNREFUSED", errno: -111, syscall: "connect" });
    class DeadHerdr extends FakeHerdr {
      override async sendPaneText(): Promise<void> {
        await Promise.resolve();
        throw dead();
      }
      override async sendPaneKeys(): Promise<void> {
        await Promise.resolve();
        throw dead();
      }
    }
    const mux = new HerdrMux(new DeadHerdr(), () => []);
    const text = await mux.typeText("w1:p1", "hello");
    const keys = await mux.writeKeys("w1:p1", ["Enter"]);
    expect(text.ok ? "ok" : text.reason).toBe("unreachable");
    expect(keys.ok ? "ok" : keys.reason).toBe("unreachable");
  });
});
