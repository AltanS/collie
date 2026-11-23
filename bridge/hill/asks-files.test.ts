import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { linkableFile } from "../files-view.ts";
import { ASK_FILES_NO_ROOT, askFilesResolver } from "./ask-files.ts";
import type { JsonValue } from "../json.ts";
import { readDecision, readPostFields } from "./parse.ts";
import { askInput, askRig, posted } from "./ask-rig.ts";
import { HillStore, hillDir } from "./store.ts";

// The linked files of an ask (`collie walky ask --file`): a pointer under the pane's Files root, checked by
// the Files view's own rules (files-view.ts `linkableFile`). Nothing is opened: these cases make real files
// and links on disk and look only at what the resolver answers.

let base = "";
let root = "";
let outside = "";
let state = "";
beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "collie-ask-files-")));
  root = join(base, "repo");
  outside = join(base, "elsewhere");
  state = join(root, ".collie-state");
  for (const dir of [root, join(root, "docs"), join(root, ".git"), outside, state]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "docs", "hill.md"), "# Hill\n");
  writeFileSync(join(root, "README.md"), "x\n");
  writeFileSync(join(root, ".git", "config"), "[core]\n");
  writeFileSync(join(state, "notes.json"), "{}\n");
  writeFileSync(join(outside, "secret.md"), "x\n");
  symlinkSync(join(outside, "secret.md"), join(root, "docs", "leads-out.md"));
  symlinkSync(join(root, "README.md"), join(root, "docs", "inside-link.md"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function resolver(paneRoot: string | null = root) {
  return askFilesResolver({ paneRoot: async (paneId) => (paneId === "%1" ? { root: paneRoot } : null), home: base, privateFolders: [state] });
}

const ADDRESS = "local/%1#aaaa";

describe("linking a file to an ask", () => {
  test("stores the path relative to the root, the heading or line as given, and the pane id as the root", async () => {
    const answer = await resolver()(ADDRESS, [{ path: join(root, "docs", "hill.md"), heading: "Asks (in work)" }, { path: join(root, "README.md"), line: 12 }]);
    expect(answer).toEqual({ ok: true, root: "%1", files: [{ path: "docs/hill.md", heading: "Asks (in work)" }, { path: "README.md", line: 12 }] });
  });

  test("an ask with no files from a pane with no root posts with root null; a --file there is refused plainly", async () => {
    expect(await resolver(null)(ADDRESS, [])).toEqual({ ok: true, root: null, files: [] });
    expect(await resolver(null)(ADDRESS, [{ path: join(root, "README.md") }])).toEqual({ ok: false, error: ASK_FILES_NO_ROOT });
    expect(await resolver()("local/%9#zzzz", [{ path: join(root, "README.md") }])).toEqual({ ok: false, error: ASK_FILES_NO_ROOT });
  });

  test("refuses a path outside the root, naming --file", async () => {
    const answer = await resolver()(ADDRESS, [{ path: join(outside, "secret.md") }]);
    expect(answer.ok).toBe(false);
    expect(!answer.ok && answer.error).toContain("is outside the workspace root");
    expect(!answer.ok && answer.error.startsWith("--file ")).toBe(true);
    expect((await resolver()(ADDRESS, [{ path: `${root}/../elsewhere/secret.md` }])).ok).toBe(false);
    expect((await resolver()(ADDRESS, [{ path: root }])).ok).toBe(false);
  });

  test("refuses a link that leads out of the root; a link that stays inside links as Files opens it", async () => {
    const out = await resolver()(ADDRESS, [{ path: join(root, "docs", "leads-out.md") }]);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toContain("is not a file the Files view opens");
    expect(await resolver()(ADDRESS, [{ path: join(root, "docs", "inside-link.md") }])).toEqual({ ok: true, root: "%1", files: [{ path: "docs/inside-link.md" }] });
  });

  test("refuses what Files refuses: .git, Collie's own folders, a folder, a missing file", async () => {
    for (const path of [join(root, ".git", "config"), join(state, "notes.json"), join(root, "docs"), join(root, "docs", "gone.md")]) {
      expect((await resolver()(ADDRESS, [{ path }])).ok).toBe(false);
    }
  });

  test("the check reads no byte: an unreadable file still links, as a pointer", async () => {
    const ctx = { root, home: base, privateFolders: [state] };
    expect(await linkableFile(ctx, join(root, "README.md"))).toEqual({ ok: true, path: "README.md" });
    expect(await linkableFile(ctx, "README.md")).toEqual({ ok: false, reason: "unknown-path" });
    expect(await linkableFile({ ...ctx, root: base }, join(root, "README.md"))).toEqual({ ok: false, reason: "no-folder" });
  });
});

describe("the ask on the wire", () => {
  test("a post's ask: at most ten files, a path of at most 4096 bytes, a heading of at most 120, a positive line", () => {
    const fields = (ask: JsonValue) => readPostFields({ requestId: "00000000-0000-4000-8000-000000000001", title: "Q?", summary: "F.", ask });
    expect(fields({ words: false, files: [{ path: "/r/a.md", heading: "H" }] })).toMatchObject({ ok: true, input: { ask: { words: false, files: [{ path: "/r/a.md", heading: "H" }] } } });
    expect(fields({ words: false, files: Array.from({ length: 11 }, (_, i) => ({ path: `/r/${String(i)}.md` })) })).toMatchObject({ ok: false, code: "bad_file" });
    expect(fields({ words: false, files: [{ path: `/${"x".repeat(4096)}` }] })).toMatchObject({ ok: false, code: "bad_file" });
    expect(fields({ words: false, files: [{ path: "/r/a.md", heading: "h".repeat(121) }] })).toMatchObject({ ok: false, code: "bad_file" });
    expect(fields({ words: false, files: [{ path: "/r/a.md", line: 0 }] })).toMatchObject({ ok: false, code: "bad_file" });
    expect(fields({ words: false, files: [{ path: "/r/a.md", line: 1.5 }] })).toMatchObject({ ok: false, code: "bad_file" });
    expect(fields({ words: false, files: [{ path: "/r/a.md", line: 3, heading: "H" }] })).toMatchObject({ ok: false, code: "bad_file" });
    expect(fields({ files: [] })).toMatchObject({ ok: false });
  });

  test("a stored ask keeps its mark; one from before the mark reads by its confirmedAt; an unknown word reads unchecked", () => {
    const r = askRig();
    const ask = posted(r.hill.post({ kind: "agent", address: ADDRESS, memberId: null, harness: "claude", label: "x", host: "desk" }, askInput(1)));
    expect(ask.ask?.mark).toBe("fresh");
    const markOf = (extra: { mark?: string; confirmedAt?: number }) => readDecision(JSON.parse(JSON.stringify({ ...ask, ask: { words: false, files: [], root: null, ...extra } })))?.ask?.mark;
    expect(markOf({ mark: "carried", confirmedAt: 9 })).toBe("carried");
    expect(markOf({ mark: "unchecked" })).toBe("unchecked");
    expect(markOf({})).toBe("fresh");
    expect(markOf({ confirmedAt: 9 })).toBe("carried");
    expect(markOf({ mark: "seen" })).toBe("unchecked");
  });

  test("a stored ask with a path the Files routes would not take fails, and so does the decision", () => {
    const r = askRig();
    const ask = posted(r.hill.post({ kind: "agent", address: ADDRESS, memberId: null, harness: "claude", label: "x", host: "desk" }, askInput(1)));
    const row = (files: unknown[]) => JSON.parse(JSON.stringify({ ...ask, ask: { words: false, files, root: "%1" } }));
    expect(readDecision(row([{ path: "docs/hill.md", line: 4 }]))?.ask).toEqual({ words: false, files: [{ path: "docs/hill.md", line: 4 }], root: "%1", mark: "fresh" });
    expect(readDecision(row([{ path: "../out.md" }]))).toBeNull();
    expect(readDecision(row([{ path: "/abs.md" }]))).toBeNull();
    expect(readDecision(row([{ path: ".git/config" }]))).toBeNull();
    expect(readDecision(JSON.parse(JSON.stringify({ ...ask, ask: { words: false, files: [], root: 7 } })))).toBeNull();
  });

  test("an ask is kept across a restart with no end; the store's end on read skips it", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-ask-store-"));
    try {
      const store = new HillStore(hillDir(dir), () => 1000);
      const ask = { ...posted(askRig().hill.post({ kind: "agent", address: ADDRESS, memberId: null, harness: "claude", label: "x", host: "desk" }, askInput(1))) };
      const plain = { ...ask, id: "dc_aaaaaaaaaaaa", ask: undefined, expiresAt: null };
      delete plain.ask;
      expect(store.put(ask, plain)).toBe(true);
      const again = new HillStore(hillDir(dir), () => 1000);
      expect(again.get(ask.id)).toMatchObject({ expiresAt: null, ask: { words: false } });
      expect(again.get("dc_aaaaaaaaaaaa")?.expiresAt).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
