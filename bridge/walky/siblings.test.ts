import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { liveHookTargets } from "../../cli/beacon.ts";
import { realFiles } from "../../cli/sys.ts";
import { hookTargetFileName } from "../beacon/hook-targets.ts";
import { mergeRows, recordsOfText, WalkyLog, type SiblingRow } from "./log.ts";
import { instanceTokensOf, realSiblingFs, siblingDirsOf, siblingPlacementCounts, SiblingLogs, type SiblingFs } from "./siblings.ts";
import type { WalkyEntry, WalkyMessage, WalkyReceipt } from "./types.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "sibling");
/** The fixture's pane, as both instances see it: `wl8b` on the stable one, `esaj` on next. */
const SESSION = "default";
const PANE = "w6Y:pV";
const ID = "wt_zsoxe7e4qh0j";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "walky-siblings-"));
  roots.push(root);
  return root;
}

/** Register a bridge in the hook target registry under `xdg`, live as this test's own pid. */
function register(xdg: string, stateDir: string): void {
  const dir = join(xdg, "collie", "hook-targets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, hookTargetFileName(stateDir)), `${JSON.stringify({ schemaVersion: 1, stateDir, pid: process.pid, pidStartTime: null, bootedAt: 1 })}\n`, { mode: 0o600 });
}

/** Two state dirs, `collie` holding the fixture and `collie-next` empty, both live in a registry. */
function twoInstances() {
  const root = tempRoot();
  const xdg = join(root, "state");
  const stable = join(xdg, "collie");
  const next = join(xdg, "collie-next");
  mkdirSync(join(stable, "walky"), { recursive: true });
  mkdirSync(join(next, "walky"), { recursive: true });
  copyFileSync(join(FIXTURE, "log.jsonl"), join(stable, "walky", "log.jsonl"));
  copyFileSync(join(FIXTURE, "instances.json"), join(stable, "walky", "instances.json"));
  register(xdg, stable);
  register(xdg, next);
  return { root, xdg, stable, next };
}

function siblingsOf(xdg: string, root: string, own: string): SiblingLogs {
  return new SiblingLogs({
    dirs: () => siblingDirsOf(liveHookTargets({ ctx: { env: { XDG_STATE_HOME: xdg }, home: root }, files: realFiles, uid: process.getuid?.() }), own, (path) => realFiles.realpath(path)),
  });
}

/** The fixture's stable instance handed to the reader directly, with no registry walk. */
function injected(stable: string): SiblingLogs {
  return new SiblingLogs({ dirs: () => [{ stateDir: stable, name: "collie" }] });
}

describe("a row a sibling instance recorded, with the siblings handed in (every platform)", () => {
  test("the next log's list for the pane holds the stable-recorded row, and the stable files stay as they were", () => {
    const { stable, next } = twoInstances();
    const before = readFileSync(join(stable, "walky", "log.jsonl"), "utf8");
    const rows = new WalkyLog(join(next, "walky"), Date.now, injected(stable)).forPane(SESSION, PANE, "esaj", 50, true);
    expect(rows.map((entry) => entry.id)).toEqual([ID]);
    expect(rows[0]).toMatchObject({ recordedBy: "collie", recordedAs: "collie-biyrya/w6Y:pV", receipt: { state: "delivered", target: "collie-biyrya/w6Y:pV" } });
    expect(readFileSync(join(stable, "walky", "log.jsonl"), "utf8")).toBe(before);
    expect(readFileSync(join(stable, "walky", "instances.json"), "utf8")).toBe(readFileSync(join(FIXTURE, "instances.json"), "utf8"));
  });
});

// These walk a LIVE hook target registry (liveHookTargets), which needs a pid start-time probe. win32 has
// none, so every target there reads as dead: the registry is empty in production and there is nothing to merge.
describe("a row a sibling instance recorded (the reproduction, from the live logs)", () => {
  test.skipIf(process.platform === "win32")("the next log's list for the pane holds the stable-recorded row, with `recordedBy`", () => {
    const { root, xdg, stable, next } = twoInstances();
    const alone = new WalkyLog(join(next, "walky"));
    expect(alone.forPane(SESSION, PANE, "esaj", 50, true)).toEqual([]);

    const log = new WalkyLog(join(next, "walky"), Date.now, siblingsOf(xdg, root, next));
    const rows = log.forPane(SESSION, PANE, "esaj", 50, true);
    expect(rows.map((entry) => entry.id)).toEqual([ID]);
    expect(rows[0]).toMatchObject({ recordedBy: "collie", recordedAs: "collie-biyrya/w6Y:pV", receipt: { state: "delivered", target: "collie-biyrya/w6Y:pV" } });
    // The stable instance's own list does not merge its own rows a second time: it is excluded by real path.
    const own = new WalkyLog(join(stable, "walky"), Date.now, siblingsOf(xdg, root, stable)).forPane(SESSION, PANE, "wl8b", 50, true);
    expect(own.map((entry) => [entry.id, entry.recordedBy])).toEqual([[ID, undefined]]);
  });

  test.skipIf(process.platform === "win32")("the sibling's files are only read: the log, its inbox and its instances stay as they were", () => {
    const { root, xdg, stable, next } = twoInstances();
    const before = readFileSync(join(stable, "walky", "log.jsonl"), "utf8");
    new WalkyLog(join(next, "walky"), Date.now, siblingsOf(xdg, root, next)).forPane(SESSION, PANE, "esaj", 50, true);
    expect(readFileSync(join(stable, "walky", "log.jsonl"), "utf8")).toBe(before);
    expect(readFileSync(join(stable, "walky", "instances.json"), "utf8")).toBe(readFileSync(join(FIXTURE, "instances.json"), "utf8"));
  });

  test.skipIf(process.platform === "win32")("a registry that is not private reads as no siblings, and the list is the own one", () => {
    const { root, xdg, next } = twoInstances();
    chmodSync(join(xdg, "collie", "hook-targets"), 0o777);
    expect(new WalkyLog(join(next, "walky"), Date.now, siblingsOf(xdg, root, next)).forPane(SESSION, PANE, "esaj", 50, true)).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("a missing registry reads as no siblings", () => {
    const root = tempRoot();
    expect(new WalkyLog(join(root, "next", "walky"), Date.now, siblingsOf(join(root, "nowhere"), root, join(root, "next"))).forPane(SESSION, PANE, "esaj", 50, true)).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("a sibling with no walky log adds nothing", () => {
    const { root, xdg, stable, next } = twoInstances();
    rmSync(join(stable, "walky"), { recursive: true });
    expect(new WalkyLog(join(next, "walky"), Date.now, siblingsOf(xdg, root, next)).forPane(SESSION, PANE, "esaj", 50, true)).toEqual([]);
  });
});

describe("which sibling row counts for the pane", () => {
  const at = { session: SESSION, paneId: PANE };

  test("the sibling's current token counts, an old token does not, a row from before tokens does", () => {
    expect(siblingPlacementCounts({ ...at, instance: "wl8b" }, SESSION, PANE, "wl8b")).toBe(true);
    expect(siblingPlacementCounts({ ...at, instance: "old1" }, SESSION, PANE, "wl8b")).toBe(false);
    expect(siblingPlacementCounts({ ...at, instance: null }, SESSION, PANE, "wl8b")).toBe(true);
  });

  test("a sibling that holds no token for the pane counts only the rows from before tokens", () => {
    expect(siblingPlacementCounts({ ...at, instance: "wl8b" }, SESSION, PANE, null)).toBe(false);
    expect(siblingPlacementCounts({ ...at, instance: null }, SESSION, PANE, null)).toBe(true);
  });

  test("another session or pane id never counts, and neither does no placement", () => {
    expect(siblingPlacementCounts({ session: "other", paneId: PANE, instance: null }, SESSION, PANE, "wl8b")).toBe(false);
    expect(siblingPlacementCounts({ session: SESSION, paneId: "w6Y:pP", instance: null }, SESSION, PANE, "wl8b")).toBe(false);
    expect(siblingPlacementCounts(null, SESSION, PANE, "wl8b")).toBe(false);
  });

  test("the fixture's instances read as (session, pane id) to token", () => {
    expect(instanceTokensOf(readFileSync(join(FIXTURE, "instances.json"), "utf8")).get(`${SESSION}\u0000${PANE}`)).toBe("wl8b");
    expect(instanceTokensOf("not json").size).toBe(0);
  });

  test("a replaced pane's row (the sibling minted a new token since) is not merged", () => {
    const { stable, next } = twoInstances();
    const instances = readFileSync(join(stable, "walky", "instances.json"), "utf8").replace('"token":"wl8b"', '"token":"zz99"');
    writeFileSync(join(stable, "walky", "instances.json"), instances);
    expect(new WalkyLog(join(next, "walky"), Date.now, injected(stable)).forPane(SESSION, PANE, "esaj", 50, true)).toEqual([]);
  });

  test("this bridge's own state dir is excluded by its real path, a link to it included", () => {
    const root = tempRoot();
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    const dirs = siblingDirsOf([{ stateDir: join(root, "link") }, { stateDir: join(root, "collie") }, { stateDir: join(root, "collie") }], join(root, "real"), (path) => realFiles.realpath(path));
    expect(dirs).toEqual([{ stateDir: join(root, "collie"), name: "collie" }]);
  });
});

// ── The merge and the cache, over hand-made rows ───────────────────────────────────────────────────

function message(id: string, at: number, to = "collie-biyrya/w1:p1#aaaa"): WalkyMessage {
  return { v: 1, id, kind: "operator", from: { memberId: null, address: null, harness: null, label: "cli" }, to, replyTo: null, at, body: "A neutral line.", signer: null, signature: null };
}

function receipt(id: string, target: string, at: number): WalkyReceipt {
  return { id, target, state: "delivered", verified: "local", at, by: "-" };
}

function row(id: string, acceptedAt: number, recordedBy?: string): SiblingRow {
  const entry: WalkyEntry = { ...message(id, acceptedAt), receipt: receipt(id, "local/w1:p1", acceptedAt) };
  return { entry: recordedBy === undefined ? entry : { ...entry, recordedBy }, acceptedAt };
}

/** A sibling log's text: one message to `w1:p1` per id, at the given times and tokens. */
function logText(lines: readonly { readonly id: string; readonly at: number; readonly instance: string | null }[]): string {
  return lines
    .flatMap(({ id, at, instance }) => [
      JSON.stringify({ t: "message", at, target: "collie-biyrya/w1:p1", session: "main", paneId: "w1:p1", instance, message: message(id, at) }),
      JSON.stringify({ t: "receipt", at, receipt: receipt(id, "collie-biyrya/w1:p1", at) }),
    ])
    .map((line) => `${line}\n`)
    .join("");
}

/** A disk in memory whose reads are counted. */
function memoryFs(files: Map<string, { text: string; mtimeMs: number }>): SiblingFs & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    stat: (path) => {
      const file = files.get(path);
      return file === undefined ? null : { mtimeMs: file.mtimeMs, size: file.text.length };
    },
    readTail: (path) => {
      reads.push(path);
      return files.get(path)?.text ?? null;
    },
  };
}

const INSTANCES = `${JSON.stringify({ v: 1, panes: [{ session: "main", paneId: "w1:p1", token: "bbbb", since: 1, lastSeen: 1 }] })}\n`;

describe("the merge", () => {
  test("newest first across both sources, an own row first on a tie, the limit over the merged list", () => {
    const own = [row("wt_own000000003", 30), row("wt_own000000001", 10)];
    const theirs = [row("wt_sib000000004", 40, "collie"), row("wt_sib000000002", 20, "collie"), row("wt_sib000000001", 10, "collie")];
    expect(mergeRows(own, theirs, 50).map((entry) => entry.id)).toEqual(["wt_sib000000004", "wt_own000000003", "wt_sib000000002", "wt_own000000001", "wt_sib000000001"]);
    expect(mergeRows(own, theirs, 3).map((entry) => entry.id)).toEqual(["wt_sib000000004", "wt_own000000003", "wt_sib000000002"]);
  });

  test("a message id both hold is the own record", () => {
    const merged = mergeRows([row("wt_same0000001a", 10)], [row("wt_same0000001a", 20, "collie")], 50);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.recordedBy).toBeUndefined();
  });

  test("with no sibling rows the own list is answered untouched", () => {
    const own = [row("wt_own000000002", 20), row("wt_own000000001", 10)];
    expect(mergeRows(own, [], 1)).toEqual([own[0]!.entry]);
  });

  test("the own log's limit holds over its rows and the sibling's", () => {
    const root = tempRoot();
    const sibling = join(root, "collie");
    const fs = memoryFs(
      new Map([
        [join(sibling, "walky", "log.jsonl"), { text: logText([{ id: "wt_sib000000001", at: 10, instance: "bbbb" }, { id: "wt_sib000000002", at: 30, instance: "bbbb" }]), mtimeMs: 1 }],
        [join(sibling, "walky", "instances.json"), { text: INSTANCES, mtimeMs: 1 }],
      ]),
    );
    let clock = 20;
    const log = new WalkyLog(join(root, "next", "walky"), () => clock, new SiblingLogs({ dirs: () => [{ stateDir: sibling, name: "collie" }], fs }));
    log.record(message("wt_own000000001", 20), "local/w1:p1", { session: "main", paneId: "w1:p1", instance: "aaaa" }, receipt("wt_own000000001", "local/w1:p1", 20));
    clock = 40;
    expect(log.forPane("main", "w1:p1", "aaaa", 50).map((entry) => entry.id)).toEqual(["wt_sib000000002", "wt_own000000001", "wt_sib000000001"]);
    expect(log.forPane("main", "w1:p1", "aaaa", 2).map((entry) => entry.id)).toEqual(["wt_sib000000002", "wt_own000000001"]);
  });
});

describe("the cache", () => {
  test("an unchanged file is not read again; a changed mtime or size is", () => {
    const sibling = "/srv/state/collie";
    const files = new Map([
      [join(sibling, "walky", "log.jsonl"), { text: logText([{ id: "wt_sib000000001", at: 10, instance: "bbbb" }]), mtimeMs: 1 }],
      [join(sibling, "walky", "instances.json"), { text: INSTANCES, mtimeMs: 1 }],
    ]);
    const fs = memoryFs(files);
    const siblings = new SiblingLogs({ dirs: () => [{ stateDir: sibling, name: "collie" }], fs });
    expect(siblings.forPane("main", "w1:p1", 50, false).map((entry) => entry.entry.id)).toEqual(["wt_sib000000001"]);
    expect(siblings.forPane("main", "w1:p1", 50, false)).toHaveLength(1);
    expect(fs.reads).toHaveLength(2);
    files.set(join(sibling, "walky", "log.jsonl"), { text: logText([{ id: "wt_sib000000001", at: 10, instance: "bbbb" }, { id: "wt_sib000000002", at: 20, instance: "bbbb" }]), mtimeMs: 2 });
    expect(siblings.forPane("main", "w1:p1", 50, false).map((entry) => entry.entry.id)).toEqual(["wt_sib000000002", "wt_sib000000001"]);
    expect(fs.reads).toHaveLength(3);
  });

  test("the registry is walked once per window, not once per poll", () => {
    let walks = 0;
    let clock = 0;
    const siblings = new SiblingLogs({
      dirs: () => {
        walks += 1;
        return [];
      },
      fs: memoryFs(new Map()),
      now: () => clock,
    });
    siblings.forPane("main", "w1:p1", 50, false);
    clock = 4_999;
    siblings.forPane("main", "w1:p1", 50, false);
    expect(walks).toBe(1);
    clock = 5_000;
    siblings.forPane("main", "w1:p1", 50, false);
    expect(walks).toBe(2);
  });

  test("an unreadable log, or a registry walk that throws, adds nothing", () => {
    const sibling = "/srv/state/collie";
    const fs: SiblingFs = { stat: () => ({ mtimeMs: 1, size: 10 }), readTail: () => null };
    expect(new SiblingLogs({ dirs: () => [{ stateDir: sibling, name: "collie" }], fs }).forPane("main", "w1:p1", 50, false)).toEqual([]);
    const broken = new SiblingLogs({
      dirs: () => {
        throw new Error("registry gone");
      },
      fs,
    });
    expect(broken.forPane("main", "w1:p1", 50, false)).toEqual([]);
  });

  test("a line that does not parse is skipped, and a log over the cap is read from its tail", () => {
    const text = `not json\n${logText([{ id: "wt_sib000000001", at: 10, instance: null }, { id: "wt_sib000000002", at: 20, instance: null }])}`;
    expect(recordsOfText(text).map((record) => record.message.id)).toEqual(["wt_sib000000001", "wt_sib000000002"]);
    // Two lines a message: the newest two lines hold the second message only.
    expect(recordsOfText(text, 2).map((record) => record.message.id)).toEqual(["wt_sib000000002"]);
  });

  test("a read off the end of a big file drops the line it cut", () => {
    const root = tempRoot();
    const path = join(root, "log.jsonl");
    writeFileSync(path, "first line\nsecond line\nthird\n");
    expect(realSiblingFs.readTail(path, 1024)).toBe("first line\nsecond line\nthird\n");
    expect(realSiblingFs.readTail(path, 15)).toBe("third\n");
    expect(realSiblingFs.readTail(join(root, "missing"), 15)).toBeNull();
    expect(realSiblingFs.stat(root)).toBeNull();
  });
});
