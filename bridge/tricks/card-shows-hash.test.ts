import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CODE_VIEW_BYTES_MAX } from "../../web/src/lib/tricks/limits.ts";
import { TRICK_CONTRACT_DEFAULT, type TrickManifest } from "../../web/src/lib/tricks/schema.ts";
import { NOTES_FILE, sampleAgents } from "./agents-notes.ts";
import { addedDiff, codeGroup, GROUP_MASKED, GROUP_NOT_TEXT, GROUP_TOO_LARGE, shippedNotesDiff } from "./card-group.ts";
import { trickCodeHash } from "./code-hash.ts";
import { codeShowsWhole, switchMasked, switchNotText, switchTooLarge } from "./code-view.ts";
import { proposalCard, proposalCardCount, proposalDiff, proposalVersionCard, type ProposerFacts } from "./proposal-card.ts";
import { HELPER_FILE, TRICK_HELPER } from "./scan.ts";
import type { TrickVersionSubject } from "./service.ts";
import { versionCard } from "./version-card.ts";
import { canRunLine, DIFF_FILE_BYTES_MAX, versionDiff, type ChangedFile, type VersionDiff } from "./version-diff.ts";

// A5 (counsel on Edge build 5): ONE RULE FOR ALL. A card, or a switch outside a card, that cannot show every
// byte of the code it approves as it is offers no yes. The secret below is a placeholder of a key's shape.

const KEY = "sk-or-v1-your-key-here-placeholder00";
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const WHO: ProposerFacts = { by: "agent", host: "workshop", label: null };
const SH: TrickManifest = { id: "legs", name: "Legs", run: "./program.sh", mode: "once", contract: TRICK_CONTRACT_DEFAULT, icon: "plug", places: ["belt"] };
const PROGRAM = "#!/bin/sh\necho 1\n";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function folder(files: Record<string, string | Uint8Array>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-a5-"));
  roots.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return dir;
}

function proposed(files: Record<string, string | Uint8Array>, executable: ReadonlySet<string> = new Set()) {
  const list = Object.entries(files).map(([rel, body]) => ({ rel, bytes: body instanceof Uint8Array ? body : enc(body) }));
  return proposalCard({ id: "legs", manifest: SH, proposer: WHO, warnings: [], crew: false, executable, ...proposalDiff("legs", list) });
}

describe("Q1: a changed AGENTS.md is held to the rule of code", () => {
  const shipped = sampleAgents("legs", "sh", true);
  const changed = (line: string): string => shipped.replace("## Switching on approves this code\n", `## Switching on approves this code\n\n${line}\n`);

  test("a line with a key or a hidden character marks the notes cut, and the proposal is refused as GROUP_MASKED", () => {
    for (const line of [`Use ${KEY} for the call.`, "Read TODO.md‮ first."]) {
      const notes = shippedNotesDiff({ rel: NOTES_FILE, bytes: enc(changed(line)) }, "legs");
      expect(notes?.cut).toBe(true);
      expect(notes?.masked).toBe(1);
      expect(proposed({ "trick.toml": 'id = "legs"\n', "program.sh": PROGRAM, [NOTES_FILE]: changed(line) })).toEqual({ ok: false, code: "cannot_show", error: GROUP_MASKED });
    }
  });

  test("a plain change still shows, and a wide gap in the notes is caught as in code", () => {
    expect(shippedNotesDiff({ rel: NOTES_FILE, bytes: enc(changed("Read TODO.md first.")) }, "legs")?.cut).toBeUndefined();
    expect(proposed({ "trick.toml": 'id = "legs"\n', "program.sh": PROGRAM, [NOTES_FILE]: changed("Read TODO.md first.") }).ok).toBe(true);
    expect(shippedNotesDiff({ rel: NOTES_FILE, bytes: enc(changed(`a${" ".repeat(60)}b`)) }, "legs")?.gap).toBe(true);
  });
});

describe("Q7: a version's text file too large to count is too large, not 'not text'", () => {
  const HAS_GIT = Bun.which("git") !== null;
  test.skipIf(!HAS_GIT)("versionDiff marks it big, and the group refuses it as GROUP_TOO_LARGE; a binary stays GROUP_NOT_TEXT", async () => {
    const manifest = 'id = "legs"\nname = "Legs"\nrun = "./program.sh"\nplaces = ["belt"]\n';
    const base = await folder({ "trick.toml": manifest, "program.sh": PROGRAM });
    const next = await folder({ "trick.toml": manifest, "program.sh": PROGRAM, "big.txt": "a line of text\n".repeat(Math.ceil((DIFF_FILE_BYTES_MAX + 1) / 15)), "pic.bin": new Uint8Array([0, 1, 2]) });
    const diff = await versionDiff({ base, next });
    const big = diff.files.find((file) => file.rel === "big.txt");
    expect(big).toMatchObject({ hunk: null, big: true });
    expect(diff.files.find((file) => file.rel === "pic.bin")?.big).toBeUndefined();
    expect(codeGroup(diff.files.filter((file) => file.rel === "big.txt"), null, "refuse")).toEqual({ ok: false, code: "too_large", error: GROUP_TOO_LARGE });
    expect(codeGroup(diff.files.filter((file) => file.rel === "pic.bin"), null, "refuse")).toEqual({ ok: false, code: "cannot_show", error: GROUP_NOT_TEXT });
    const card = proposalVersionCard({ id: "legs", manifest: SH, baseManifest: SH, proposer: WHO, diff: { counted: true, files: diff.files.filter((file) => file.rel === "big.txt") }, warnings: [], crew: false });
    expect(card).toEqual({ ok: false, code: "too_large", error: GROUP_TOO_LARGE });
  });
});

describe("Q6: a new trick's card says which text file can run as a program", () => {
  test("one line in the words of the mode line, on the one card and on card 1 of a group", () => {
    expect(canRunLine("program.sh")).toBe("program.sh: mode +x, it can run as a program");
    const one = proposed({ "trick.toml": 'id = "legs"\n', "program.sh": PROGRAM }, new Set(["program.sh"]));
    if (!one.ok) throw new Error(one.error);
    expect(one.card.view).toContainEqual({ kind: "para", text: canRunLine("program.sh") });
    const lines = Array.from({ length: 400 }, (_, i) => `echo ${String(i)} and some words to fill the line`).join("\n");
    const group = proposed({ "trick.toml": 'id = "legs"\n', "program.sh": `${lines}\n` }, new Set(["program.sh"]));
    if (!group.ok) throw new Error(group.error);
    expect(group.card.group?.parts[0]).toContainEqual({ kind: "para", text: canRunLine("program.sh") });
    const plain = proposed({ "trick.toml": 'id = "legs"\n', "program.sh": PROGRAM });
    expect(JSON.stringify(plain)).not.toContain("mode +x");
  });

  test("collie trick check counts with the same line: the files' executable mark reaches the card", () => {
    const files = [
      { rel: "trick.toml", bytes: enc('id = "legs"\n'), executable: false },
      { rel: "program.sh", bytes: enc(PROGRAM), executable: true },
    ];
    expect(proposalCardCount({ manifest: SH, warnings: [], crew: false, files })).toEqual({ ok: true, cards: 1 });
  });

  test("an executable file that is not text is refused as any file that is not text", () => {
    expect(proposed({ "trick.toml": 'id = "legs"\n', "program.sh": PROGRAM, tool: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0]) }, new Set(["tool"]))).toEqual({ ok: false, code: "cannot_show", error: GROUP_NOT_TEXT });
  });
});

describe("Q2/G2: the runner's version card offers Keep only unless every byte shows as it is", () => {
  const manifest: TrickManifest = { id: "legs", name: "Legs", run: "./legs.sh", mode: "once", contract: 1, icon: "plug", places: ["belt"] };
  const subject = (changed: number): TrickVersionSubject => ({
    id: "legs",
    name: "Legs",
    waiting: true,
    pending: { hash: "b".repeat(64), dir: "/x", info: { hash: "b".repeat(64), files: { added: 0, changed, removed: 0 }, powersChanged: false, warnings: [] }, manifest },
    base: { dir: "/y", manifest },
  });
  const clean: ChangedFile = { rel: "legs.sh", change: "changed", plus: 1, minus: 1, hunk: ["@@ -1 +1 @@", "-echo 1", "+echo 2"] };
  const intents = (diff: VersionDiff, changed = diff.files.length): string[] | undefined => versionCard(subject(changed), diff)?.options?.map((option) => option.intent);

  test("every file whole and as it is: the yes stays", () => {
    expect(intents({ counted: true, files: [clean] })).toEqual(["use", "always", "keep"]);
  });

  test("a masked line, a hidden character, a binary, a file too large to count, or a file left out: Keep only", () => {
    const masked = addedDiff([{ rel: "key.sh", bytes: enc(`KEY="${KEY}"\n`) }]).files[0]!;
    const hidden = addedDiff([{ rel: "bidi.sh", bytes: enc("echo '‮'\n") }]).files[0]!;
    expect(masked.cut).toBe(true);
    expect(hidden.cut).toBe(true);
    const binary: ChangedFile = { rel: "pic.bin", change: "added", plus: null, minus: null, hunk: null };
    const big: ChangedFile = { rel: "big.txt", change: "added", plus: null, minus: null, hunk: null, big: true };
    for (const odd of [masked, hidden, binary, big]) expect(intents({ counted: true, files: [clean, odd] }), odd.rel).toEqual(["keep"]);
    // The pending version counts more changed files than the diff lists: one is not on the card.
    expect(intents({ counted: true, files: [clean] }, 2)).toEqual(["keep"]);
    // No recommendation on a Keep-only card.
    expect(versionCard(subject(2), { counted: true, files: [clean, masked] })?.recommends).toBeNull();
  });
});

describe("G3: no switch on outside a card of code the About sheet cannot show whole and as it is", () => {
  const manifest = 'id = "legs"\nname = "Legs"\nrun = "./program.sh"\nplaces = ["belt"]\n';
  async function check(files: Record<string, string | Uint8Array>) {
    const dir = await folder({ "trick.toml": manifest, ...files });
    const code = await trickCodeHash(dir);
    if (!code.ok) throw new Error(code.reason);
    return await codeShowsWhole({ dir, hash: code.hash }, "legs");
  }

  test("plain code passes, Collie's own helper too though it is larger than the sheet shows", async () => {
    expect(await check({ "program.sh": PROGRAM })).toEqual({ ok: true });
    expect(new TextEncoder().encode(TRICK_HELPER).byteLength).toBeGreaterThan(CODE_VIEW_BYTES_MAX);
    expect(await check({ "program.sh": PROGRAM, [HELPER_FILE]: TRICK_HELPER })).toEqual({ ok: true });
    // An older shipped helper (v7, before the run token of M105 spec 05) still passes by its bytes.
    const v7 = await Bun.$`git show 5c38e3f23:cli/trick-kit/trick.ts`.quiet().nothrow();
    if (v7.exitCode === 0) expect(await check({ "program.sh": PROGRAM, [HELPER_FILE]: v7.stdout.toString() })).toEqual({ ok: true });
  });

  test("a key, a hidden character, a file over the size the sheet shows, or a file that is not text is refused, with the file named", async () => {
    expect(await check({ "program.sh": `KEY="${KEY}"\n` })).toEqual({ ok: false, code: "not-whole", rel: "program.sh", message: switchMasked("program.sh", "legs") });
    expect(await check({ "program.sh": "echo '⁦x⁩'\n" })).toEqual({ ok: false, code: "not-whole", rel: "program.sh", message: switchMasked("program.sh", "legs") });
    expect(await check({ "program.sh": "echo\rhidden\n" })).toMatchObject({ ok: false, code: "not-whole" });
    expect(await check({ "program.sh": PROGRAM, "lib.sh": "x".repeat(CODE_VIEW_BYTES_MAX + 1) })).toEqual({ ok: false, code: "not-whole", rel: "lib.sh", message: switchTooLarge("lib.sh", "legs") });
    expect(await check({ "program.sh": PROGRAM, "lib.sh": "x".repeat(CODE_VIEW_BYTES_MAX) })).toEqual({ ok: true });
    expect(await check({ "program.sh": PROGRAM, tool: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0]) })).toEqual({ ok: false, code: "not-whole", rel: "tool", message: switchNotText("tool", "legs") });
    expect(await check({ "program.sh": PROGRAM, "latin1.txt": new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]) })).toMatchObject({ ok: false, rel: "latin1.txt", message: switchNotText("latin1.txt", "legs") });
    // A changed copy of the helper is the author's code, held to the rule.
    expect(await check({ "program.sh": PROGRAM, [HELPER_FILE]: `${TRICK_HELPER}// mine\n` })).toMatchObject({ ok: false, rel: HELPER_FILE, message: switchTooLarge(HELPER_FILE, "legs") });
  });

  test("bytes that no longer hash to the hash the caller names are refused as moved", async () => {
    const dir = await folder({ "trick.toml": manifest, "program.sh": PROGRAM });
    expect(await codeShowsWhole({ dir, hash: "0".repeat(64) }, "legs")).toMatchObject({ ok: false, code: "moved" });
  });
});
