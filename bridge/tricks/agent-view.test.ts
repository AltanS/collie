import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_VIEW_NEEDS_CONTRACT,
  AGENT_VIEW_NEEDS_RULES,
  parseManifest,
  RESERVED_TRICK_IDS,
  RULES_NEED_AGENT_VIEW,
  RULES_NEEDS_CONTRACT,
  rulesNameProblem,
  rulesTextProblems,
} from "../../web/src/lib/tricks/schema.ts";
import { TRICK_CONTRACT } from "../../web/src/lib/tricks/contract.ts";
import { isHiddenChar } from "../../web/src/lib/hidden-chars.ts";
import { HIDDEN_CHAR_CASES } from "../../web/src/test/hidden-char-cases.ts";
import { readViewLine } from "./version-diff.ts";
import { powersOf } from "./approved.ts";
import { diskTrickFs, trickCodeHash, unsafeText } from "./code-hash.ts";
import { readManifestFile, readRulesFile } from "./discover.ts";
import { RULES_DIFF_CELLS_MAX, rulesChange, rulesDiffRows } from "./rules-diff.ts";

// THE AGENT VIEW CONTRACT (contract 2, task 3a): the keys are read and hashed and the rights are words. The
// view itself is drawn by bridge/agent-view/, so a manifest that lists it carries no `later` note.

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-agent-view-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const FIXTURE = join(import.meta.dir, "fixtures", "morph");
const VIEW = { id: "morph", name: "Morph", contract: 2, places: ["agent-view"], rules: "rules.md" };
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const codes = (doc: Parameters<typeof parseManifest>[0]): [string, string][] => parseManifest(doc).refusals.map((r) => [r.code, r.path]);

/** A trick folder `morph` holding `files`. */
async function folder(files: Record<string, string>): Promise<string> {
  const dir = join(await tempDir(), "morph");
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}
const TOML = 'id = "morph"\nname = "Morph"\ncontract = 2\nplaces = ["agent-view"]\nrules = "rules.md"\n';

describe("the contract number", () => {
  test("the keys ride inside contract 2: this Collie speaks 2, and a contract 1 trick may not use them", () => {
    expect(TRICK_CONTRACT).toBe(2);
    expect(codes({ ...VIEW, contract: 1 })).toEqual([
      ["version", "/places/0"],
      ["version", "/rules"],
    ]);
    expect(parseManifest({ ...VIEW, contract: 1 }).refusals.map((r) => r.reason)).toEqual([AGENT_VIEW_NEEDS_CONTRACT, RULES_NEEDS_CONTRACT]);
  });
});

describe("the place word agent-view", () => {
  test("reads, is kept apart from the drawing places, and carries no later note: this build draws the view", () => {
    const read = parseManifest(VIEW);
    expect(read.manifest).toEqual({ id: "morph", name: "Morph", mode: "once", contract: 2, icon: "plug", places: [], agentView: true, rules: "rules.md" });
    expect(read.refusals).toEqual([]);
  });

  test("beside drawing places, they stay, and so does the program", () => {
    const read = parseManifest({ ...VIEW, run: "./p.sh", places: ["belt", "agent-view"] });
    expect(read.manifest?.places).toEqual(["belt"]);
    expect(read.manifest?.agentView).toBe(true);
    expect(read.manifest?.run).toBe("./p.sh");
  });

  test("is refused without rules", () => {
    const { rules: _, ...bare } = VIEW;
    expect(codes(bare)).toEqual([
      ["missing", "/places"],
    ]);
    expect(parseManifest(bare).refusals[0]?.reason).toBe(AGENT_VIEW_NEEDS_RULES);
    expect(parseManifest(bare).manifest).toBeUndefined();
  });

  test("is refused when listed twice", () => {
    expect(codes({ ...VIEW, run: "./p.sh", places: ["agent-view", "agent-view"] })).toEqual([
      ["duplicate", "/places/1"],
    ]);
  });
});

describe("the key rules", () => {
  test("is refused without the place agent-view", () => {
    expect(codes({ ...VIEW, run: "./p.sh", places: ["belt"] })).toEqual([["place", "/rules"]]);
    expect(parseManifest({ ...VIEW, run: "./p.sh", places: ["belt"] }).refusals[0]?.reason).toBe(RULES_NEED_AGENT_VIEW);
  });

  test("names one .md file in the folder, never a path, a dot file or another kind", () => {
    for (const ok of ["rules.md", "RULES.md", "agent-rules_2.md"]) expect(rulesNameProblem(ok), ok).toBeUndefined();
    for (const bad of ["../rules.md", "docs/rules.md", "rules.txt", ".rules.md", "rules", "a\\b.md", "-r.md", "rules .md", `${"r".repeat(62)}.md`]) {
      expect(rulesNameProblem(bad), bad).toBeDefined();
      // A name past the text cap is refused by the text rule first.
      expect(codes({ ...VIEW, rules: bad }).map(([code]) => code), bad).toContain(bad.length > 64 ? "text" : "target");
    }
    expect(codes({ ...VIEW, rules: 3 })).toEqual([
      ["type", "/rules"],
    ]);
  });
});

describe("run may be left out", () => {
  test("only when places is exactly agent-view; beside another place it is needed", () => {
    expect(parseManifest(VIEW).manifest?.run).toBeUndefined();
    expect(codes({ ...VIEW, places: ["agent-view", "belt"] })).toContainEqual(["missing", "/run"]);
    expect(codes({ id: "legs", name: "Legs", places: ["belt"] })).toEqual([["missing", "/run"]]);
  });

  test("V-N2: a trick whose only place is agent-view has no program: run, every, env and inputs are refused", () => {
    const cases: [string, Record<string, string | string[]>][] = [
      ["run", { run: "./p.sh" }],
      ["every", { every: "1m" }],
      ["inputs", { inputs: ["TODO.md"] }],
      ["env", { env: ["GH_TOKEN"] }],
    ];
    for (const [key, extra] of cases) {
      const read = parseManifest({ ...VIEW, ...extra });
      expect(read.manifest, key).toBeUndefined();
      expect(read.refusals, key).toContainEqual({ code: "place", path: `/${key}`, reason: `A trick whose only place is "agent-view" has no program, so it takes no "${key}". Remove it, or add a place it draws in.` });
    }
    // A place this Collie does not know still counts as another place: a newer trick keeps its program.
    expect(parseManifest({ ...VIEW, run: "./p.sh", places: ["agent-view", "orbit"] }).manifest?.run).toBe("./p.sh");
  });
});

describe("reserved ids", () => {
  test("walky-talky, hill, collie and view are refused; morph is a trick's name", () => {
    expect(RESERVED_TRICK_IDS).toEqual(["walky-talky", "hill", "collie", "view"]);
    for (const id of RESERVED_TRICK_IDS) {
      const read = parseManifest({ id, name: "X", run: "./p.sh", places: ["belt"] });
      expect(read.manifest, id).toBeUndefined();
      expect(read.refusals, id).toEqual([{ code: "id", path: "/id", reason: `"${id}" is a name Collie keeps for itself. Give the trick another id.` }]);
    }
    expect(parseManifest(VIEW).manifest?.id).toBe("morph");
  });
});

describe("the content rule of a rules file", () => {
  const one = (text: string): string[] => rulesTextProblems(enc(text), "rules.md").map((p) => p.reason);

  test("takes printable ASCII and newlines, short lines, at most two spaces and two blank lines", () => {
    expect(one("Draw one screen.\n")).toEqual([]);
    expect(one("A  b.\n\n\nC.\n")).toEqual([]);
    expect(one(`${"x".repeat(160)}\n`)).toEqual([]);
  });

  test("V-N4: the last line ends with a line break, so A\\nB and A\\nB\\n are never two versions of one text", () => {
    expect(one("Draw one screen.")).toEqual(["rules.md does not end with a line break. End its last line with one."]);
    expect(one("A\nB")).toEqual(["rules.md does not end with a line break. End its last line with one."]);
    expect(one("A\nB\n")).toEqual([]);
  });

  test("refuses each break with its own sentence naming the line", () => {
    expect(one("ok\n\tindented\n")).toEqual(["rules.md line 2 holds a tab. Use spaces."]);
    expect(one("ok\r\n")).toEqual(["rules.md line 1 holds a carriage return. Save the file with plain \\n line ends."]);
    expect(one("ok\nbell\u0007\n")).toEqual(["rules.md line 2 holds a control character."]);
    expect(one("ok\nok\ncafé\n")).toEqual(["rules.md line 3 holds a character outside plain ASCII (letters, digits, punctuation and spaces). Agent instructions are plain ASCII text."]);
    expect(one(`ok\n${"x".repeat(161)}\n`)).toEqual(["rules.md line 2 is longer than 160 characters. Break it in two."]);
    expect(one("ok \n")).toEqual(["rules.md line 1 ends with a space."]);
    expect(one("a   b\n")).toEqual(["rules.md line 1 holds a run of more than 2 spaces."]);
    expect(one("a\n\n\n\nb\n")).toEqual(["rules.md line 4 is a third blank line in a row. At most 2 blank lines may follow each other."]);
  });

  test("refuses the hidden characters an earlier predicate let through", () => {
    // A variation selector, a line separator, a soft hyphen, a zero-width space, a direction mark.
    for (const ch of ["️", " ", "­", "​", "‮", "\u{e0041}"]) expect(one(`ok${ch}\n`), JSON.stringify(ch)).toHaveLength(1);
  });

  test("refuses an empty file, a file of blanks, and one over 8 KiB", () => {
    expect(one("")).toEqual(["rules.md is empty. Write the instructions your agents read."]);
    expect(one("\n\n")).toEqual(["rules.md is empty. Write the instructions your agents read."]);
    expect(one(`${"x".repeat(100)}\n`.repeat(82))).toEqual(["rules.md is larger than 8 KiB."]);
    expect(one(`${"x".repeat(127)}\n`.repeat(64))).toEqual([]);
  });

  test("the fixture's fifteen lines read", async () => {
    const bytes = new Uint8Array(await readFile(join(FIXTURE, "rules.md")));
    expect(rulesTextProblems(bytes)).toEqual([]);
    expect(new TextDecoder().decode(bytes).split("\n").filter((line) => line !== "")).toHaveLength(15);
  });
});

describe("reading the folder", () => {
  test("the fixture reads whole: the manifest carries the rules' bytes as text and their sha256", async () => {
    const read = await readManifestFile(diskTrickFs, FIXTURE, "morph");
    const bytes = await readFile(join(FIXTURE, "rules.md"));
    expect(read.manifest?.rulesText).toBe(bytes.toString("latin1"));
    expect(Buffer.from(read.manifest?.rulesText ?? "", "latin1").equals(bytes)).toBe(true);
    expect(read.manifest?.rulesSha256).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
    expect(read.manifest?.run).toBeUndefined();
    expect(read.refusals).toEqual([]);
  });

  test("a missing, linked or broken rules file refuses the manifest, each break its own refusal", async () => {
    const missing = await readManifestFile(diskTrickFs, await folder({ "trick.toml": TOML }), "morph");
    expect(missing.manifest).toBeUndefined();
    expect(missing.refusals.at(-1)).toEqual({ code: "missing", path: "/rules", reason: '"rules" names rules.md, which is not in the folder.' });

    const linkedDir = await folder({ "trick.toml": TOML, "real.md": "Draw.\n" });
    await symlink("real.md", join(linkedDir, "rules.md"));
    const linked = await readRulesFile(diskTrickFs, linkedDir, "rules.md");
    expect(linked.ok).toBe(false);
    if (!linked.ok) expect(linked.refusals[0]?.reason).toBe("rules.md is a symbolic link. The rules are a regular file in the folder: put the file itself there.");

    const broken = await readManifestFile(diskTrickFs, await folder({ "trick.toml": TOML, "rules.md": "ok \n\tx\n" }), "morph");
    expect(broken.manifest).toBeUndefined();
    expect(broken.refusals.filter((r) => r.path === "/rules").map((r) => r.reason)).toEqual(["rules.md line 1 ends with a space.", "rules.md line 2 holds a tab. Use spaces."]);

    const big = await readRulesFile(diskTrickFs, await folder({ "rules.md": "x\n".repeat(4097) }), "rules.md");
    expect(big.ok ? null : big.refusals[0]?.code).toBe("size");
  });

  test("the rules file is part of the code hash: an edit is a new version", async () => {
    const dir = await folder({ "trick.toml": TOML, "rules.md": "Draw one screen.\n" });
    const before = await trickCodeHash(dir);
    await writeFile(join(dir, "rules.md"), "Draw two screens.\n");
    const after = await trickCodeHash(dir);
    expect(before.ok && after.ok && before.hash !== after.hash).toBe(true);
  });
});

describe("the powers", () => {
  test("every trick without the keys keeps its powers hash byte for byte", async () => {
    // Taken on the base (int/1.29.0 660b722bb) before the keys existed.
    const fixtures = (await import("../../web/src/lib/tricks/fixtures/manifests.json")).default;
    const stored: [string, string][] = [
      ["hello", "ef82e1c9bd8dcfc4"],
      ["legs", "d66ecead783fc3a7"],
    ];
    for (const [id, hash] of stored) {
      const read = await readManifestFile(diskTrickFs, join(import.meta.dir, "fixtures", id), id);
      expect(read.manifest === undefined ? null : powersOf(read.manifest), id).toBe(hash);
    }
    const parsed = (value: Parameters<typeof parseManifest>[0]): string | null => {
      const m = parseManifest(value).manifest;
      return m === undefined ? null : powersOf(m);
    };
    expect(parsed(fixtures.legs)).toBe("d66ecead783fc3a7");
    expect(parsed(fixtures.tracker)).toBe("f7770078dfb7ce7e");
    expect(parsed(fixtures.later)).toBe("ef82e1c9bd8dcfc4");
    expect(powersOf({ env: ["GH_TOKEN"], places: ["belt", "dashboard"], inputs: ["TODO.md"] })).toBe("50f8d6040dffe1f7");
  });

  test("agent-view and the rules bytes are rights: each moves the hash, and the rules move it by their bytes", () => {
    const base: Parameters<typeof powersOf>[0] = { places: [], agentView: true, rules: "rules.md", rulesSha256: "a".repeat(64) };
    const view = powersOf(base);
    expect(view).toBe(new Bun.CryptoHasher("sha256").update(JSON.stringify({ env: [], inputs: [], places: ["agent-view"], rules: "a".repeat(64) })).digest("hex").slice(0, 16));
    expect(powersOf({ ...base, rulesSha256: "b".repeat(64) })).not.toBe(view);
    // The file's name is not a right: the same bytes under another name hash the same.
    expect(powersOf({ ...base, rules: "other.md" })).toBe(view);
    expect(powersOf({ places: [], agentView: true })).not.toBe(powersOf({ places: [] }));
  });
});

describe("the whole diff of two rules texts", () => {
  test("keeps every line: common lines as context, taken out as -, put in as +, in order", () => {
    expect(rulesDiffRows("a\nb\nc\n", "a\nx\nc\nd\n")).toEqual(["@@ -1,3 +1,4 @@", " a", "-b", "+x", " c", "+d"]);
    expect(rulesDiffRows(null, "a\nb\n")).toEqual(["@@ -0,0 +1,2 @@", "+a", "+b"]);
    expect(rulesDiffRows("a\n", null)).toEqual(["@@ -1,1 +0,0 @@", "-a"]);
    // A blank line is a row too.
    expect(rulesDiffRows("a\n\nb\n", "a\n\nb\nc\n")).toEqual(["@@ -1,3 +1,4 @@", " a", " ", " b", "+c"]);
  });

  test("a middle too large for the table is all out then all in, still whole", () => {
    const big = (tag: string): string => Array.from({ length: Math.ceil(Math.sqrt(RULES_DIFF_CELLS_MAX)) + 1 }, (_, i) => `${tag}${String(i)}`).join("\n");
    const rows = rulesDiffRows(`${big("o")}\n`, `${big("n")}\n`);
    expect(rows.filter((r) => r.startsWith("-")).length + rows.filter((r) => r.startsWith("+")).length).toBe(rows.length - 1);
  });

  test("a change names the file and counts; equal texts are no change", () => {
    const base = { rules: "rules.md", rulesText: "a\n" };
    expect(rulesChange(base, { rules: "rules.md", rulesText: "a\n" })).toBeNull();
    expect(rulesChange(undefined, undefined)).toBeNull();
    expect(rulesChange(base, { rules: "rules.md", rulesText: "a\nb\n" })).toEqual({ rel: "rules.md", change: "changed", plus: 1, minus: 0, hunk: ["@@ -1,1 +1,2 @@", " a", "+b"] });
    expect(rulesChange(undefined, base)?.change).toBe("added");
    expect(rulesChange(base, {})?.change).toBe("removed");
  });
});

// The rules' content rule and the shared hidden-character predicate (web/src/lib/hidden-chars.ts) must not
// disagree: every byte the rule takes is one the predicate shows, and every hidden row of the one table is
// a byte the rule refuses. So a rules file that passes shows on a card as itself, never as a `?`.
describe("the rules' content rule and the hidden-character table agree", () => {

  test("every byte a rules file may hold is shown as itself; every hidden character of the table is refused", () => {
    for (let code = 0x20; code <= 0x7e; code += 1) {
      const ch = String.fromCharCode(code);
      expect([ch, isHiddenChar(ch), unsafeText(ch)]).toEqual([ch, false, false]);
      expect([ch, rulesTextProblems(enc(`a${ch}b\n`))]).toEqual([ch, []]);
    }
    for (const { ch, name, hidden } of HIDDEN_CHAR_CASES) {
      if (!hidden) continue;
      expect([name, rulesTextProblems(enc(`a${ch}b\n`)).length > 0]).toEqual([name, true]);
    }
  });

  test("a file of every printable character passes the rule, and a card shows each line as it is", () => {
    const all = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i)).join("");
    const text = `${all.slice(0, 47)}\n${all.slice(47)} and a space\n`;
    expect(rulesTextProblems(enc(text))).toEqual([]);
    for (const line of text.split("\n")) expect(readViewLine(line)).toMatchObject({ line, masked: false });
  });
});
