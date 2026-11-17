import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WireCodeFile, WireCodeIndex } from "../../web/src/lib/tricks/code-wire.ts";
import { CODE_VIEW_BYTES_MAX } from "../../web/src/lib/tricks/limits.ts";
import { codeFile, codeIndex, codeSource, type CodeRuntime } from "./code-view.ts";
import { trickCodeHash } from "./code-hash.ts";
import { TRICKS_DIR } from "./paths.ts";
import { TricksService, type CodeAnswer } from "./service.ts";

// The code route behind the About sheet's "Read the code" folds (code-view.ts): which bytes, the mask, the
// cap, a binary file, the marks, and the refusals. A real service over a real folder, no runner.

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const HOST = "lodge";
/** Built from parts, so the source holds no key-shaped literal: a fake vendor key of the masked shape. */
const FAKE_KEY = `sk-or-v1-${"0123456789abcdef".repeat(2)}`;
const MANIFEST = 'id = "legs"\nname = "Browser leg"\nrun = "./legs.sh"\nevery = "30s"\nplaces = ["belt"]\n';

async function rig(files: Record<string, string | Uint8Array> = {}, manifest = MANIFEST) {
  const root = await mkdtemp(join(tmpdir(), "collie-code-view-"));
  dirs.push(root);
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  await mkdir(join(configDir, TRICKS_DIR, "legs"), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const folder = join(configDir, TRICKS_DIR, "legs");
  await writeFile(join(folder, "trick.toml"), manifest);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(folder, name, ".."), { recursive: true });
    await writeFile(join(folder, name), content, { mode: 0o755 });
  }
  const service = new TricksService({ configDir, stateDir, memberId: HOST, world: () => ({ machine: "desk", sessions: [], spaces: [] }), env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, now: () => Date.parse("2026-11-17T09:00:00Z"), warn: () => {}, revBase: 1000, feature: { on: () => true } });
  await service.refresh(true);
  return { folder, service };
}

function index(answer: CodeAnswer): WireCodeIndex {
  if (answer.status !== 200 || !("hash" in answer.body)) throw new Error(`not an index: ${JSON.stringify(answer)}`);
  return answer.body;
}

function file(answer: CodeAnswer): WireCodeFile {
  if (answer.status !== 200 || !("size" in answer.body)) throw new Error(`not a file: ${JSON.stringify(answer)}`);
  return answer.body;
}

describe("which copy the code is", () => {
  test("the approved copy: an edit of the folder after the yes does not change what is read", async () => {
    const r = await rig({ "legs.sh": "#!/bin/sh\necho approved\n" });
    expect((await r.service.setSwitch(HOST, "legs", true)).status).toBe(200);
    await writeFile(join(r.folder, "legs.sh"), "#!/bin/sh\necho edited after the yes\n");
    const idx = index(await r.service.code(HOST, "legs", null));
    expect(idx.copy).toBe("approved");
    expect(idx.files.map((f) => f.file)).toEqual(["trick.toml", "legs.sh"]);
    expect(file(await r.service.code(HOST, "legs", "legs.sh")).lines).toEqual(["#!/bin/sh", "echo approved"]);
    // The hash the bytes were checked against is the approved version's: the folder now hashes elsewhere.
    expect(idx.hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("a trick that is off and never approved: what a switch on would approve, the folder as it is now", async () => {
    const r = await rig({ "legs.sh": "#!/bin/sh\necho folder\n" });
    const idx = index(await r.service.code(HOST, "legs", null));
    expect(idx.copy).toBe("next");
    expect(file(await r.service.code(HOST, "legs", "legs.sh")).lines).toEqual(["#!/bin/sh", "echo folder"]);
    // The hash is the one the row's switch sends back: the two cannot disagree.
    const row = (await r.service.reply(undefined)).tricks.find((trick) => trick.id === "legs");
    expect(row?.approves).toBeDefined();
    expect(idx.hash).toBe(row?.approves ?? "");
  });

  test("a new version that waits: the approved copy that runs is shown, not the waiting one", async () => {
    const r = await rig({ "legs.sh": "#!/bin/sh\necho one\n" });
    await r.service.setSwitch(HOST, "legs", true);
    await writeFile(join(r.folder, "legs.sh"), "#!/bin/sh\necho two\n");
    await r.service.refresh(true);
    expect(file(await r.service.code(HOST, "legs", "legs.sh")).lines).toEqual(["#!/bin/sh", "echo one"]);
  });

  test("another host, an unknown trick and a file that is not code are refused in words, with no path read", async () => {
    const r = await rig({ "legs.sh": "#!/bin/sh\n" });
    expect((await r.service.code("elsewhere", "legs", null)).status).toBe(404);
    expect((await r.service.code(HOST, "nope", null)).status).toBe(404);
    for (const rel of ["../../state/x", "/etc/passwd", "config.toml", "media/a.png", "legs", "./legs.sh", "legs.sh/"]) {
      expect({ rel, status: (await r.service.code(HOST, "legs", rel)).status }).toEqual({ rel, status: 404 });
    }
  });
});

describe("the mask and the cap", () => {
  test("a key in the code is masked before it leaves, and the lines the mask changed are counted", async () => {
    const r = await rig({ "legs.sh": `#!/bin/sh\nKEY=${FAKE_KEY}\necho fine\n` });
    await r.service.setSwitch(HOST, "legs", true);
    const body = file(await r.service.code(HOST, "legs", "legs.sh"));
    const text = (body.lines ?? []).join("\n");
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain("0123456789abcdef0123");
    expect(body.lines?.[1]).toContain("•");
    expect(body.masked).toBe(1);
    expect(JSON.stringify(await r.service.code(HOST, "legs", null))).not.toContain(FAKE_KEY);
  });

  test("a hidden character becomes a ?, a tab becomes two spaces", async () => {
    const r = await rig({ "legs.sh": "#!/bin/sh\n\techo ‮hidden\n" });
    const body = file(await r.service.code(HOST, "legs", "legs.sh"));
    expect(body.lines?.[1]).toBe("  echo ?hidden");
    expect(body.masked).toBe(1);
  });

  test("a file over the cap shows its first part, cut at a line end, and says how many bytes are left out", async () => {
    const line = "echo a line of the program that is long enough\n";
    const text = `#!/bin/sh\n${line.repeat(Math.ceil((CODE_VIEW_BYTES_MAX * 2) / line.length))}`;
    const r = await rig({ "legs.sh": text });
    const body = file(await r.service.code(HOST, "legs", "legs.sh"));
    const shown = body.lines ?? [];
    const bytes = new TextEncoder().encode(`${shown.join("\n")}\n`).length;
    expect(bytes).toBeLessThanOrEqual(CODE_VIEW_BYTES_MAX);
    expect(body.size).toBe(new TextEncoder().encode(text).length);
    expect(body.leftOut).toBe(body.size - bytes);
    expect(body.leftOut).toBeGreaterThan(CODE_VIEW_BYTES_MAX / 2);
    // Cut at a line end: the last line shown is whole.
    expect(shown.at(-1)).toBe(line.trimEnd());
  });

  test("a file just under the cap is shown whole, with nothing left out", async () => {
    const r = await rig({ "legs.sh": "#!/bin/sh\necho x\n" });
    const body = file(await r.service.code(HOST, "legs", "legs.sh"));
    expect(body.leftOut).toBe(0);
    expect(body.masked).toBe(0);
  });

  test("a binary file sends its name and size and no bytes", async () => {
    const bin = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3, 0, 0, 0xff, 0xfe, 65, 66, 67]);
    const r = await rig({ "legs.sh": "#!/bin/sh\n", "tool.bin": bin });
    const idx = index(await r.service.code(HOST, "legs", null));
    expect(idx.files.find((f) => f.file === "tool.bin")).toEqual({ file: "tool.bin", size: bin.length, binary: true, flagged: 0 });
    const body = file(await r.service.code(HOST, "legs", "tool.bin"));
    expect(body).toEqual({ file: "tool.bin", size: bin.length, binary: true });
    expect(JSON.stringify(body)).not.toContain("ABC");
  });
});

describe("the marks of the text search", () => {
  test("a flagged line carries the kinds the search found, a line with none carries nothing, and the index counts the lines", async () => {
    const r = await rig({ "legs.sh": "#!/bin/sh\necho start\ncurl https://example.test/data\nwhoami > /tmp/out.txt\n" });
    await r.service.setSwitch(HOST, "legs", true);
    const idx = index(await r.service.code(HOST, "legs", null));
    const flagged = Object.fromEntries(idx.files.map((f) => [f.file, f.flagged]));
    expect(flagged["legs.sh"]).toBe(2);
    expect(flagged["trick.toml"]).toBe(0);
    const body = file(await r.service.code(HOST, "legs", "legs.sh"));
    expect(body.marks).toEqual([
      { line: 3, kinds: ["network"] },
      { line: 4, kinds: ["write"] },
    ]);
    expect(body.marksLeft).toBe(0);
  });

  test("a line that reaches Collie's local API past its helper carries the api kind", async () => {
    const r = await rig({ "legs.sh": "#!/bin/sh\necho start\ncollie api GET /api/health\n" });
    const body = file(await r.service.code(HOST, "legs", "legs.sh"));
    expect(body.marks).toEqual([{ line: 3, kinds: ["api"] }]);
  });

  test("a flag past the part shown is counted, not drawn on a line that is not there", async () => {
    const filler = "echo filler line of the program\n".repeat(Math.ceil((CODE_VIEW_BYTES_MAX * 2) / 32));
    const r = await rig({ "legs.sh": `#!/bin/sh\n${filler}curl https://example.test/late\n` });
    const body = file(await r.service.code(HOST, "legs", "legs.sh"));
    expect(body.marks).toEqual([]);
    expect(body.marksLeft).toBe(1);
  });
});

describe("the bytes are the ones the hash names", () => {
  test("a folder edited between the read of its names and its bytes is refused as moved, never shown mixed", async () => {
    const r = await rig({ "legs.sh": "#!/bin/sh\necho one\n" });
    const idx = index(await r.service.code(HOST, "legs", null));
    // Same service, the folder changes under it: the row still names the old hash until the next scan, so the read must not mix.
    const before = await readFile(join(r.folder, "legs.sh"), "utf8");
    await writeFile(join(r.folder, "legs.sh"), before.replace("one", "two"));
    const answer = await r.service.code(HOST, "legs", "legs.sh");
    // Either the scan already saw the new bytes (a fresh hash, the new text) or the read is refused: never the old hash over new bytes.
    if (answer.status === 200) expect(file(answer).lines).toEqual(["#!/bin/sh", "echo two"]);
    else expect(answer).toMatchObject({ status: 409, body: { error: "moved" } });
    expect(idx.hash).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("code-view on its own", () => {
  test("bytes that do not hash to the hash named are refused as moved, for the index and for a file", async () => {
    const r = await rig({ "legs.sh": "#!/bin/sh\necho one\n" });
    const hash = await trickCodeHash(r.folder);
    if (!hash.ok) throw new Error("the folder does not hash");
    const good = { dir: r.folder, hash: hash.hash, copy: "next" as const, manifest: undefined };
    expect((await codeIndex(good)).ok).toBe(true);
    const stale = { ...good, hash: "0".repeat(64) };
    expect(await codeIndex(stale)).toMatchObject({ ok: false, code: "moved" });
    expect(await codeFile(stale, "legs.sh")).toMatchObject({ ok: false, code: "moved" });
    expect(await codeFile(good, "missing.sh")).toMatchObject({ ok: false, code: "no-file" });
  });

  test("the source: the approved copy while one runs, else the waiting snapshot, else the folder, else none", () => {
    const found = { dir: "/folder", codeHash: "f".repeat(64) };
    const base: CodeRuntime = { approved: null, copyProblem: null, pending: null, found };
    expect(codeSource(base)).toMatchObject({ dir: "/folder", copy: "next" });
    expect(codeSource({ ...base, pending: { dir: "/pending", hash: "p".repeat(64) } })).toMatchObject({ dir: "/pending", copy: "next" });
    const approved = { dir: "/approved", hash: "a".repeat(64), found: {} };
    expect(codeSource({ ...base, approved, pending: { dir: "/pending", hash: "p".repeat(64) } })).toMatchObject({ dir: "/approved", copy: "approved" });
    // A copy that cannot run (changed on disk) is not shown as the approved one.
    expect(codeSource({ ...base, approved, copyProblem: "changed" })).toMatchObject({ dir: "/folder", copy: "next" });
    expect(codeSource({ ...base, found: { dir: "/folder" } })).toBeNull();
  });
});

describe("the run line and the timer on the row", () => {
  test("the row carries the run line, masked, and the timer in milliseconds; a trick with no timer has none", async () => {
    const withKey = `id = "legs"\nname = "Browser leg"\nrun = "./legs.sh --token ${FAKE_KEY}"\nevery = "5m"\nplaces = ["belt"]\n`;
    const r = await rig({ "legs.sh": "#!/bin/sh\n" }, withKey);
    const row = (await r.service.reply(undefined)).tricks.find((trick) => trick.id === "legs");
    expect(row?.everyMs).toBe(5 * 60_000);
    expect(row?.run).toContain("./legs.sh --token");
    expect(row?.run).not.toContain(FAKE_KEY);
    expect(row?.run).toContain("•");
    const plain = await rig({ "legs.sh": "#!/bin/sh\n" }, 'id = "legs"\nname = "Browser leg"\nrun = "./legs.sh"\nplaces = ["belt"]\n');
    const bare = (await plain.service.reply(undefined)).tricks.find((trick) => trick.id === "legs");
    expect(bare?.run).toBe("./legs.sh");
    expect(bare?.everyMs).toBeUndefined();
  });
});
