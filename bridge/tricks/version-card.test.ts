import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memoryHillReceipts } from "../hill/receipts.ts";
import { HillService } from "../hill/service.ts";
import { HillStore } from "../hill/store.ts";
import { HILL_SUMMARY_MAX, type HillDecision, type HillReceipt } from "../../web/src/lib/hill/wire.ts";
import { DECISION_VIEW_LIMITS, parseDecisionView } from "../../web/src/lib/tricks/schema.ts";
import { parseJson } from "../../web/src/lib/json.ts";
import { TRICKS_DIR } from "./paths.ts";
import { PENDING_SETTLE_MS, TricksService, type TrickVersionSubject } from "./service.ts";
import { trickCodeHash } from "./code-hash.ts";
import { withSwitch, writeSwitches } from "./switches.ts";
import { GROUP_MASKED_NOTE } from "./card-group.ts";
import { VERSION_CARD_GONE, VERSION_MOVED, VERSION_NEW_RIGHTS, VERSION_NOT_SHOWN, VersionCards, newInputs, versionCard, versionRequestId, versionTitle, versionView } from "./version-card.ts";
import { diffArgv, readPatch, versionDiff, viewLine, type DiffRun, type VersionDiff } from "./version-diff.ts";
import { singleCodeCard } from "../../web/src/lib/hill/code-card.ts";

// THE "NEW VERSION" CARD (crew slice 3): the diff of two copies, the card's words and view, and the
// card's life on a real Hill beside a real tricks runner.

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "collie-version-card-")));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function folder(files: Record<string, string | Uint8Array>): Promise<string> {
  const dir = await tempDir();
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  return dir;
}

const MANIFEST = 'id = "legs"\nname = "Browser leg"\nrun = "./legs.sh"\nevery = "30s"\nplaces = ["belt"]\n';
const HAS_GIT = Bun.which("git") !== null;
const gitTest = test.skipIf(!HAS_GIT);

describe("the diff of two copies", () => {
  gitTest("lists added, changed and removed code files with their line counts and masked hunks", async () => {
    const base = await folder({ "trick.toml": MANIFEST, "legs.sh": "#!/bin/sh\necho 1\necho keep\n", "old.sh": "gone\n" });
    const next = await folder({ "trick.toml": MANIFEST, "legs.sh": '#!/bin/sh\necho 2\necho keep\nKEY="sk-or-v1-your-key-here-placeholder00"\n', "new.sh": "a\nb\n" });
    const diff = await versionDiff({ base, next });
    expect(diff.counted).toBe(true);
    expect(diff.files.map((file) => [file.rel, file.change, file.plus, file.minus])).toEqual([
      ["legs.sh", "changed", 2, 1],
      ["new.sh", "added", 2, 0],
      ["old.sh", "removed", 0, 1],
    ]);
    const hunk = diff.files[0]?.hunk ?? [];
    expect(hunk[0]).toStartWith("@@");
    expect(hunk.join("\n")).not.toContain("0123456789abcdef");
    expect(hunk.join("\n")).toContain("+echo 2");
  });

  test("a file whose executable bit alone moved is listed +x, counted, and its row is the whole change (review 7)", async () => {
    const base = await folder({ "trick.toml": MANIFEST, "legs.sh": "echo 1\n", "keep.sh": "echo 2\n" });
    const same = { "trick.toml": MANIFEST, "legs.sh": "echo 1\n", "keep.sh": "echo 2\n" };
    // A stored proposal is 0600: the bits it marked are passed in. This half runs on every platform.
    const diff = await versionDiff({ base, next: await folder(same), nextExec: new Set(["legs.sh"]) });
    expect(diff).toEqual({ files: [{ rel: "legs.sh", change: "changed", plus: 0, minus: 0, hunk: [], mode: "+x" }], counted: true });
    expect(JSON.stringify(versionView([], [], diff))).toContain('"text":"changed +x"');
    // A folder by hand: the bits are read off the disk, which only a POSIX file mode holds. Inline, not a
    // skip: the Windows run's skip budget (scripts/windows-suites.ps1) counts every skipped test.
    if (process.platform === "win32") return;
    const next = await folder(same);
    await chmod(join(next, "legs.sh"), 0o755);
    await chmod(join(base, "keep.sh"), 0o755);
    expect((await versionDiff({ base, next })).files.map((file) => [file.rel, file.mode])).toEqual([
      ["keep.sh", "-x"],
      ["legs.sh", "+x"],
    ]);
  });

  test("with no git, every file is listed by what happened to it, with no counts and no hunks", async () => {
    const base = await folder({ "trick.toml": MANIFEST, "legs.sh": "1\n" });
    const next = await folder({ "trick.toml": MANIFEST, "legs.sh": "2\n" });
    expect(await versionDiff({ base, next, git: null })).toEqual({ files: [{ rel: "legs.sh", change: "changed", plus: null, minus: null, hunk: null }], counted: false });
  });

  test("git runs hardened from argv only; a binary file and a failed run are listed, not counted", async () => {
    const base = await folder({ "trick.toml": MANIFEST, "a.sh": "1\n", "pic.bin": new Uint8Array([0, 1, 2]) });
    const next = await folder({ "trick.toml": MANIFEST, "a.sh": "2\n", "pic.bin": new Uint8Array([0, 1, 3]) });
    const argvs: (readonly string[])[] = [];
    const run = async (argv: readonly string[]): Promise<DiffRun> => {
      argvs.push(argv);
      return { code: 2, stdout: "", timedOut: false };
    };
    const diff = await versionDiff({ base, next, git: "/usr/bin/git", run });
    expect(diff.counted).toBe(false);
    expect(argvs).toHaveLength(1);
    expect(argvs[0]).toEqual(diffArgv("/usr/bin/git", join(base, "a.sh"), join(next, "a.sh")));
    const argv = argvs[0] ?? [];
    expect(argv.slice(0, 2)).toEqual(["/usr/bin/git", "--no-pager"]);
    for (const flag of ["--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "-U2", "core.hooksPath=/dev/null", "diff.external=", "core.fsmonitor=false"]) expect(argv).toContain(flag);
    expect(argv.indexOf("--")).toBe(argv.length - 3);
  });

  test("a patch's counts skip its headers; a view line is masked and holds no control character", () => {
    expect(readPatch("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n")).toEqual({ plus: 1, minus: 1, hunk: ["@@ -1 +1 @@", "-a", "+b"] });
    expect(viewLine("+\tx\u0007\u{202e}")).toBe("+  x??");
    // B2: every character a Decision's view refuses becomes a `?`, so one line never drops the view.
    expect(viewLine("+a\u200bb\u2060c\ufeffd\u061ce\u{e0041}f")).toBe("+a?b?c?d?e?f");
  });

  test("B6: a diff cut at the output cap, or a line with a key masked, is marked cut", async () => {
    const base = await folder({ "trick.toml": MANIFEST, "a.sh": "1\n", "b.sh": "1\n" });
    const next = await folder({ "trick.toml": MANIFEST, "a.sh": "2\n", "b.sh": "2\n" });
    const run = async (argv: readonly string[]): Promise<DiffRun> =>
      argv.at(-1)?.endsWith("a.sh") === true
        ? { code: 1, stdout: "@@ -1 +1 @@\n-1\n+2\n", timedOut: false, truncated: true }
        : { code: 1, stdout: '@@ -1 +1 @@\n-1\n+KEY="sk-or-v1-your-key-here-placeholder00"\n', timedOut: false };
    const diff = await versionDiff({ base, next, git: "/usr/bin/git", run });
    expect(diff.files.map((file) => [file.rel, file.cut])).toEqual([
      ["a.sh", true],
      ["b.sh", true],
    ]);
  });

  test("a changed line with a bidi mark or a control character is marked cut, and the card does not recommend use", async () => {
    const base = await folder({ "trick.toml": MANIFEST, "a.sh": "1\n", "b.sh": "1\n", "c.sh": "1\n", "d.sh": "1\n" });
    const next = await folder({ "trick.toml": MANIFEST, "a.sh": "2\n", "b.sh": "2\n", "c.sh": "2\n", "d.sh": "2\n" });
    const patches = new Map<string, string>([
      // U+202E turns the rest of the line around on screen: the person would not read it as it is.
      ["a.sh", '@@ -1 +1 @@\n-1\n+if [ "$x" = "\u202e1 nimda" ]; then rm -rf ~; fi\n'],
      // A control character (BEL) the view cannot draw.
      ["b.sh", "@@ -1 +1 @@\n-1\n+echo hi\u0007\n"],
      // A tab is two spaces and a CRLF line end is the line's end: both are read as they are.
      ["c.sh", "@@ -1 +1 @@\n-1\r\n+\techo 2\r\n"],
      ["d.sh", "@@ -1 +1 @@\n-1\n+echo 2\n"],
    ]);
    const run = async (argv: readonly string[]): Promise<DiffRun> => ({ code: 1, stdout: patches.get(argv.at(-1)?.split("/").at(-1) ?? "") ?? "", timedOut: false });
    const diff = await versionDiff({ base, next, git: "/usr/bin/git", run });
    expect(diff.files.map((file) => [file.rel, file.cut === true])).toEqual([
      ["a.sh", true],
      ["b.sh", true],
      ["c.sh", false],
      ["d.sh", false],
    ]);
    expect(diff.files[0]?.hunk?.[2]).toBe('+if [ "$x" = "?1 nimda" ]; then rm -rf ~; fi');
    expect(diff.files[2]?.hunk).toEqual(["@@ -1 +1 @@", "-1", "+  echo 2"]);
    const pending = subject().pending!;
    const one = (files: VersionDiff["files"]): TrickVersionSubject => ({ ...subject(), pending: { ...pending, info: { ...pending.info, files: { added: 0, changed: files.length, removed: 0 } } } });
    // A cut line shows as the mask leaves it, on a group whose card says so, and nothing is recommended.
    for (const file of diff.files.slice(0, 2)) {
      const card = versionCard(one([file]), { counted: true, files: [file] });
      expect(card?.recommends).toBeNull();
      expect(card?.summary).toBe("1 file changed. It asks for no new rights. It shows on 2 cards.");
      expect(JSON.stringify(card?.group?.parts[1])).toContain(GROUP_MASKED_NOTE);
    }
    const clean = diff.files.slice(2);
    expect(versionCard(one(clean), { counted: true, files: clean })?.recommends).toMatchObject({ intent: "use" });
  });

  test("a CR inside a changed line marks the file's lines as old or mixed line ends; a CRLF line end does not", async () => {
    const base = await folder({ "trick.toml": MANIFEST, "a.sh": "1\n", "b.sh": "1\n", "c.sh": "1\n" });
    const next = await folder({ "trick.toml": MANIFEST, "a.sh": "2\n", "b.sh": "2\n", "c.sh": "2\n" });
    const patches = new Map<string, string>([
      ["a.sh", "@@ -1 +1 @@\n-1\r\n+a();\rb();\r\n"],
      ["b.sh", "@@ -1 +1 @@\n-1\r\n+echo 2\r\n"],
      ["c.sh", '@@ -1 +1,2 @@\n-1\n+a();\rb();\n+KEY="sk-or-v1-your-key-here-placeholder00"\n'],
    ]);
    const run = async (argv: readonly string[]): Promise<DiffRun> => ({ code: 1, stdout: patches.get(argv.at(-1)?.split("/").at(-1) ?? "") ?? "", timedOut: false });
    const diff = await versionDiff({ base, next, git: "/usr/bin/git", run });
    expect(diff.files.map((file) => [file.rel, file.masked, file.strayCr])).toEqual([
      ["a.sh", 1, true],
      ["b.sh", undefined, undefined],
      ["c.sh", 2, undefined],
    ]);
  });

  test("a version made by hand with masked lines says in Collie's words how many lines it could not show, and names the file", async () => {
    const base = await folder({ "trick.toml": MANIFEST, "legs.sh": "1\n", "tool.sh": "1\n", "pic.bin": new Uint8Array([0, 1, 2]) });
    const next = await folder({ "trick.toml": MANIFEST, "legs.sh": "2\n", "tool.sh": "2\n", "pic.bin": new Uint8Array([0, 1, 3]) });
    const patches = new Map<string, string>([
      // A key, a bidi mark and a control character: three lines the mask changed, one kept as it is.
      ["legs.sh", '@@ -1 +1,4 @@\n-1\n+KEY="sk-or-v1-your-key-here-placeholder00"\n+echo "‮ok"\n+echo hi\u0007\n+echo 2\n'],
      ["tool.sh", '@@ -1 +1 @@\n-1\n+TOKEN="sk-or-v1-your-key-here-placeholder11"\n'],
    ]);
    const run = async (argv: readonly string[]): Promise<DiffRun> => ({ code: 1, stdout: patches.get(argv.at(-1)?.split("/").at(-1) ?? "") ?? "", timedOut: false });
    const diff = await versionDiff({ base, next, git: "/usr/bin/git", run });
    expect(diff.files.map((file) => [file.rel, file.masked])).toEqual([
      ["legs.sh", 3],
      ["pic.bin", undefined],
      ["tool.sh", 1],
    ]);
    const three = "Collie could not show 3 lines of legs.sh as they are (a key, or a hidden character), so they show masked.";
    const one = "Collie could not show 1 line of tool.sh as it is (a key, or a hidden character), so it shows masked.";
    const pending = subject().pending!;
    const of = (files: VersionDiff["files"]): TrickVersionSubject => ({ ...subject(), pending: { ...pending, info: { ...pending.info, files: { added: 0, changed: files.length, removed: 0 } } } });
    // Text files only: a group of cards, and card 1 says it for each file, before the code cards show the lines masked.
    const text = diff.files.filter((file) => file.rel !== "pic.bin");
    const group = versionCard(of(text), { counted: true, files: text });
    expect(group?.group?.parts[0]).toEqual(expect.arrayContaining([{ kind: "para", text: three }, { kind: "para", text: one }]));
    expect(JSON.stringify(group?.group?.parts[1])).toContain(GROUP_MASKED_NOTE);
    expect(group?.recommends).toBeNull();
    // With a file that is not text there is no group: the one card says it in its facts.
    const single = versionCard(of(diff.files), diff);
    expect(single?.group).toBeUndefined();
    expect(single?.view).toEqual(expect.arrayContaining([{ kind: "para", text: three }, { kind: "para", text: one }]));
    // A file with nothing masked gets no such sentence.
    expect(JSON.stringify(versionCard(subject(), DIFF))).not.toContain("Collie could not show");
  });
});

const subject = (over: Partial<TrickVersionSubject> = {}): TrickVersionSubject => ({
  id: "legs",
  name: "Browser leg",
  waiting: true,
  pending: { hash: "b".repeat(64), dir: "/x", info: { hash: "b".repeat(64), files: { added: 0, changed: 3, removed: 0 }, powersChanged: false, warnings: [] }, manifest: { id: "legs", name: "Browser leg", run: "./legs.sh", mode: "once", contract: 1, icon: "plug", places: ["belt"] } },
  base: { dir: "/y", manifest: { id: "legs", name: "Browser leg", run: "./legs.sh", mode: "once", contract: 1, icon: "plug", places: ["belt"] } },
  ...over,
});

const DIFF: VersionDiff = {
  counted: true,
  files: [
    { rel: "legs.sh", change: "changed", plus: 2, minus: 1, hunk: ["@@ -1,2 +1,3 @@", " #!/bin/sh", "-echo 1", "+echo 2", "+echo 3"] },
    { rel: "lib/a.ts", change: "added", plus: 1, minus: 0, hunk: ["@@ -0,0 +1 @@", "+export {};"] },
    { rel: "old.ts", change: "removed", plus: 0, minus: 4, hunk: ["@@ -1,4 +0,0 @@", "-a", "-b", "-c", "-d"] },
  ],
};

describe("the card's words and view", () => {
  test("no new rights: three options, Collie recommends use, and the summary says so in two sentences", () => {
    const card = versionCard(subject(), DIFF);
    expect(card).toMatchObject({
      title: "Use the new version of Browser leg?",
      summary: "3 files changed. It asks for no new rights.",
      text: "none",
      priority: "today",
      recommends: { intent: "use", why: "It asks for no new rights, and a text search of its code finds nothing new." },
    });
    expect(card?.options).toEqual([
      { intent: "use", label: "Use the new version" },
      { intent: "always", label: "Use it and stop asking", detail: "Later changes are taken without asking, unless they ask for new rights or do something new." },
      { intent: "keep", label: "Keep the old version" },
    ]);
    const view = card?.view ?? [];
    // Every changed file's whole hunk fits, so all three are shown (B6: no fixed cap of two).
    expect(view.map((node) => node.kind)).toEqual(["table", "diff", "diff", "diff"]);
    expect(parseDecisionView(parseJson(JSON.stringify(view))).refusals).toEqual([]);
  });

  test("B2: a file name the view would refuse is cleaned for display, so the view stays", () => {
    const pending = subject().pending!;
    const card = versionCard(
      { ...subject(), pending: { ...pending, info: { ...pending.info, files: { added: 0, changed: 1, removed: 0 } } } },
      { counted: true, files: [{ rel: "evil\u202egnp.ts", change: "changed", plus: 1, minus: 1, hunk: ["@@ -1 +1 @@", "-a", "+b"] }] },
    );
    expect(card?.view).toBeDefined();
    const table = card?.view?.[0];
    expect(table?.kind).toBe("table");
    expect(table !== undefined && "kids" in table ? table.kids?.[4] : undefined).toEqual({ kind: "cell", text: "evil?gnp.ts" });
    expect(card?.view?.[1]).toMatchObject({ kind: "diff", attrs: { file: "evil?gnp.ts" } });
  });

  test("F1: fourteen new environment names of 64 characters all show in full, none cut, none dropped", () => {
    const env = Array.from({ length: 14 }, (_, i) => `TOKEN_${String(i).padStart(2, "0")}_${"X".repeat(55)}`);
    const base = subject();
    const pending = base.pending;
    if (pending === null) throw new Error("no pending");
    const card = versionCard({ ...base, pending: { ...pending, manifest: { id: "legs", name: "Browser leg", run: "./legs.sh", mode: "once", contract: 1, icon: "plug", places: ["belt"], env } } }, DIFF);
    const words = JSON.stringify(card?.view);
    for (const name of env) expect(words).toContain(`${name}`);
    expect(card?.view?.[0]).toMatchObject({ kind: "para" });
    expect(card?.recommends).toBeNull();
  });

  test("B2: a card whose view could not be made carries no recommendation and says to read the change on the machine", () => {
    const card = versionCard(subject(), { counted: false, files: [] });
    expect(card?.view).toBeUndefined();
    expect(card?.recommends).toBeNull();
    expect(card?.summary).toBe(`3 files changed. It asks for no new rights. ${VERSION_NOT_SHOWN}`);
    expect(VERSION_NOT_SHOWN).toBe("The change is too large to show here. Read it on the machine before you say yes.");
  });

  test("B6: a binary or uncounted file, a cut line, a long hunk or a masked line means no recommendation, and the summary says how much is shown", () => {
    const two = (): TrickVersionSubject => {
      const pending = subject().pending!;
      return { ...subject(), pending: { ...pending, info: { ...pending.info, files: { added: 0, changed: 2, removed: 0 } } } };
    };
    const shown = { rel: "legs.sh", change: "changed" as const, plus: 1, minus: 1, hunk: ["@@ -1 +1 @@", "-echo 1", "+echo 2"] };
    const cases: VersionDiff["files"][number][] = [
      { rel: "pic.bin", change: "changed", plus: null, minus: null, hunk: null },
      { rel: "pad.ts", change: "changed", plus: 1, minus: 0, hunk: ["@@ -1 +1,2 @@", ` ok`, `+const pad = "${" ".repeat(240)}"; run();`] },
      { rel: "long.ts", change: "added", plus: 60, minus: 0, hunk: ["@@ -0,0 +1,60 @@", ...Array.from({ length: 60 }, (_, i) => `+line ${String(i)}`)] },
      { rel: "key.ts", change: "changed", plus: 1, minus: 1, hunk: ["@@ -1 +1 @@", "-a", "+b"], cut: true },
    ];
    // A binary file cannot show on a group: the one card as before, with how much it shows.
    const binary = versionCard(two(), { counted: true, files: [shown, cases[0]!] });
    expect(binary?.recommends).toBeNull();
    expect(binary?.group).toBeUndefined();
    expect(binary?.summary).toBe("2 files changed. It asks for no new rights. 1 of 2 files shown.");
    // A long line or a long hunk shows whole on a group of cards; a masked line shows masked, and recommends nothing.
    for (const second of cases.slice(1)) {
      const card = versionCard(two(), { counted: true, files: [shown, second] });
      expect(card?.summary).toBe("2 files changed. It asks for no new rights. It shows on 2 cards.");
      expect(card?.recommends === null).toBe(second.cut === true);
    }
    const all = versionCard(two(), { counted: true, files: [shown, { ...shown, rel: "other.sh" }] });
    expect(all?.recommends).toMatchObject({ intent: "use" });
    expect(all?.summary).toBe("2 files changed. It asks for no new rights.");
  });

  test("a new right and a new warning: no always, no recommendation, a chip per right in a bar, the warning in words", () => {
    const base = subject();
    const pending = base.pending!;
    const card = versionCard(
      { ...base, pending: { ...pending, info: { ...pending.info, powersChanged: true, warnings: [{ kind: "network", text: "x" }] }, manifest: { ...pending.manifest!, env: ["GITHUB_TOKEN"], places: ["belt", "status"] } } },
      DIFF,
    );
    expect(card?.summary).toBe("3 files changed. It now also asks for GITHUB_TOKEN and the status line, and reaches the network.");
    expect(card?.recommends).toBeNull();
    expect(card?.options?.map((option) => option.intent)).toEqual(["use", "keep"]);
    const view = card?.view ?? [];
    expect(view[0]).toEqual({ kind: "bar", attrs: { label: "New rights" }, kids: [{ kind: "chip", text: "GITHUB_TOKEN", attrs: { tone: "warn" } }, { kind: "chip", text: "the status line", attrs: { tone: "warn" } }] });
    expect(view[1]).toEqual({ kind: "para", text: "This trick reaches the network." });
  });

  test("a new inputs glob (contract 2) is a new right: no always, and the view says the one sentence, crew or solo", () => {
    const base = subject();
    const pending = base.pending!;
    const next: TrickVersionSubject = { ...base, pending: { ...pending, info: { ...pending.info, powersChanged: true }, manifest: { ...pending.manifest!, contract: 2, inputs: ["TODO.md", "notes/*.md"] } } };
    const crew = versionCard(next, DIFF, true);
    expect(crew?.summary).toBe("3 files changed. It now also reads files in your agent sessions' folders on every machine of the crew.");
    expect(crew?.options?.map((option) => option.intent)).toEqual(["use", "keep"]);
    expect(crew?.recommends).toBeNull();
    expect(crew?.view?.[0]).toEqual({ kind: "para", text: "Reads TODO.md, notes/*.md in your agent sessions' folders on every machine of the crew." });
    const solo = versionCard(next, DIFF);
    expect(solo?.summary).toBe("3 files changed. It now also reads files in your agent sessions' folders.");
    expect(solo?.view?.[0]).toEqual({ kind: "para", text: "Reads TODO.md, notes/*.md in your agent sessions' folders." });
    // A glob the approved version already read is no new right.
    const same: TrickVersionSubject = { ...next, base: { dir: "/y", manifest: { ...base.base!.manifest!, contract: 2, inputs: ["notes/*.md", "TODO.md"] } } };
    expect(newInputs(same.base?.manifest, same.pending?.manifest)).toEqual([]);
  });

  test("a new inputs glob holds the card even when the runner's powers flag says nothing moved, and even with every file shown", () => {
    const base = subject();
    const pending = base.pending!;
    // A pending info from a runner that did not hash inputs yet: the card reads the manifests itself.
    const next: TrickVersionSubject = { ...base, pending: { ...pending, info: { ...pending.info, powersChanged: false, warnings: [] }, manifest: { ...pending.manifest!, contract: 2, inputs: ["TODO.md"] } } };
    const card = versionCard(next, DIFF);
    expect(card?.summary).toBe("3 files changed. It now also reads files in your agent sessions' folders.");
    expect(card?.options?.map((option) => option.intent)).toEqual(["use", "keep"]);
    expect(card?.recommends).toBeNull();
    expect(card?.view?.[0]).toEqual({ kind: "para", text: "Reads TODO.md in your agent sessions' folders." });
  });

  test("a long name is cut so the title stays a short question; a big change fits 8 KiB, with 'and N more files'", () => {
    expect(versionTitle("A very long trick name that goes on and on and on")).toBe("Use the new version of A very long trick name that goes on…?");
    expect([...versionTitle("A very long trick name that goes on and on and on")].length).toBeLessThanOrEqual(60);
    const wide = "x".repeat(190);
    const files = Array.from({ length: 30 }, (_, i) => ({ rel: `file-${String(i).padStart(2, "0")}.ts`, change: "changed" as const, plus: 40, minus: 0, hunk: ["@@ -1 +1,40 @@", ...Array.from({ length: 40 }, () => `+${wide}`)] }));
    const view = versionView([], [], { counted: true, files }) ?? [];
    expect(new TextEncoder().encode(JSON.stringify(view)).byteLength).toBeLessThanOrEqual(DECISION_VIEW_LIMITS.bytes);
    expect(view.at(-1)).toEqual({ kind: "line", text: "and 18 more files", attrs: { role: "note" } });
    expect(parseDecisionView(parseJson(JSON.stringify(view))).refusals).toEqual([]);
    // B6: such a change is never recommended, and the summary says how little of it is shown.
    const pending = subject().pending!;
    const card = versionCard({ ...subject(), pending: { ...pending, info: { ...pending.info, files: { added: 0, changed: 30, removed: 0 } } } }, { counted: true, files });
    expect(card?.recommends).toBeNull();
    expect(card?.summary).toBe("30 files changed. It asks for no new rights. 0 of 30 files shown.");
  });

  test("B6: a summary with a long list of new rights stays within the Hill's cap and keeps the shown sentence", () => {
    const base = subject();
    const pending = base.pending!;
    const env = Array.from({ length: 6 }, (_, i) => `A_VERY_LONG_ENVIRONMENT_VARIABLE_NAME_NUMBER_${String(i)}`);
    const card = versionCard(
      { ...base, pending: { ...pending, info: { ...pending.info, powersChanged: true, warnings: ["spawn", "network", "write", "model", "import"].map((kind) => ({ kind, text: "x" })) }, manifest: { ...pending.manifest!, env } } },
      { counted: false, files: [] },
    );
    expect([...(card?.summary ?? "")].length).toBeLessThanOrEqual(HILL_SUMMARY_MAX);
    expect(card?.summary).toBe("3 files changed. It asks for new rights, listed below. 0 of 3 files shown.");
  });

  test("a request id is a canonical UUID that moves with the trick, the hash and the count", () => {
    const one = versionRequestId("legs", "a".repeat(64), 0);
    expect(one).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(versionRequestId("legs", "a".repeat(64), 1)).not.toBe(one);
  });
});

// ── The card's life: a real tricks runner, a real Hill, the card between them ─────────────────────

const T0 = Date.parse("2026-11-10T09:00:00Z");

interface Life {
  configDir: string;
  stateDir: string;
  dir: string;
  clock: { t: number };
  hill: HillService;
  store: HillStore;
  cards: VersionCards;
  service: TricksService;
}

/** A stand-in for `git diff --no-index`: the whole old file out, the whole new file in, so every line shows. */
async function wholeFileDiff(argv: readonly string[]): Promise<DiffRun> {
  const lines = async (path: string | undefined): Promise<string[]> => (path === undefined || path === "/dev/null" ? [] : (await readFile(path, "utf8")).split("\n").filter((line) => line !== ""));
  const [left, right] = await Promise.all([lines(argv.at(-2)), lines(argv.at(-1))]);
  const patch = [`@@ -1,${String(left.length)} +1,${String(right.length)} @@`, ...left.map((line) => `-${line}`), ...right.map((line) => `+${line}`)];
  return { code: 1, stdout: `${patch.join("\n")}\n`, timedOut: false };
}

async function life(): Promise<Life> {
  const root = await tempDir();
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const dir = join(configDir, TRICKS_DIR, "legs");
  await mkdir(dir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(dir, "trick.toml"), MANIFEST);
  await writeFile(join(dir, "legs.sh"), "#!/bin/sh\necho 1\n", { mode: 0o755 });
  const code = await trickCodeHash(dir);
  if (!code.ok) throw new Error(code.reason);
  await writeSwitches(stateDir, withSwitch({ on: new Map() }, "legs", true, "2026-11-10T08:00:00Z", code.hash));
  const clock = { t: T0 };
  const store = new HillStore(null, () => clock.t);
  let n = 0;
  let service: TricksService | null = null;
  let cards: VersionCards | null = null;
  const hill = new HillService({
    store,
    receipts: memoryHillReceipts(),
    place: () => null,
    send: async () => "typed",
    crewMode: () => "solo",
    walkyOn: () => true,
    memberId: "lodge",
    machine: "lodge",
    now: () => clock.t,
    mintId: () => `dc_ver${String((n += 1)).padStart(9, "0")}`,
    onCollieAnswer: (ref, intent) => cards?.answer(ref, intent) ?? Promise.resolve({ ok: false, reason: "no cards" }),
  });
  cards = new VersionCards({ hill, tricks: () => service, diff: (base, next) => versionDiff({ base, next, git: "/fake/git", run: wholeFileDiff }) });
  service = new TricksService({
    configDir,
    stateDir,
    memberId: "lodge",
    world: () => ({ machine: "lodge", sessions: [], spaces: [] }),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    now: () => clock.t,
    warn: () => undefined,
    revBase: 1000,
    run: async () => ({ kind: "exited", code: 0, stdout: JSON.stringify({ v: 1, parts: [] }), stderr: "", ms: 1 }),
    versions: cards,
  });
  await scan({ clock, service, cards }, T0);
  return { configDir, stateDir, dir, clock, hill, store, cards, service };
}

async function scan(l: Pick<Life, "clock" | "service" | "cards">, t: number): Promise<void> {
  l.clock.t = t;
  await l.service.refresh(true);
  await l.cards.settled();
}

/** Edit the program and let the folder settle, so the snapshot is taken and its card posted. */
async function edit(l: Life, at: number, text: string, manifest = MANIFEST): Promise<string> {
  await writeFile(join(l.dir, "trick.toml"), manifest);
  await writeFile(join(l.dir, "legs.sh"), text);
  await scan(l, at);
  await scan(l, at + PENDING_SETTLE_MS);
  const code = await trickCodeHash(l.dir);
  if (!code.ok) throw new Error(code.reason);
  return code.hash;
}

const cardsOf = (l: Life): HillDecision[] => l.hill.collieDecisions("version");
const openCard = (l: Life): HillDecision | undefined => cardsOf(l).find((decision) => decision.state === "open");

/** A tap from a phone that showed the card's code to its end: a single card of code names its hash and card 1 (C-A2). */
async function tap(l: Life, decision: HillDecision, rid: number, intent: string): Promise<HillReceipt> {
  const request = { rid: `00000000-0000-4000-8000-${String(rid).padStart(12, "0")}`, node: `hill/${decision.id}`, intent, value: { text: null } };
  const one = singleCodeCard(decision);
  const outcome = await l.hill.answer(one === null ? request : { ...request, group: { digest: one.digest, opened: [1] } }, decision.id, "Pixel 9");
  if (outcome.kind !== "receipt") throw new Error(outcome.kind);
  return outcome.receipt;
}

async function switchFile(l: Life): Promise<{ hash: string; auto: boolean; declined?: string }> {
  return JSON.parse(await readFile(join(l.stateDir, TRICKS_DIR, "switches.json"), "utf8")).on.legs;
}

describe("the card's life", () => {
  test("a waiting version gets one card; use approves exactly that version and closes it answered", async () => {
    const l = await life();
    expect(cardsOf(l)).toEqual([]);
    const v2 = await edit(l, T0 + 1000, "#!/bin/sh\necho 2\n");
    const card = openCard(l);
    expect(card?.from).toMatchObject({ kind: "collie", label: "Collie", ref: { type: "version", id: "legs", hash: v2 } });
    expect(card).toMatchObject({ title: "Use the new version of Browser leg?", summary: "1 file changed. It asks for no new rights.", priority: "today" });
    // A second scan posts nothing more.
    await scan(l, T0 + 20_000);
    expect(cardsOf(l)).toHaveLength(1);
    expect(await tap(l, card!, 1, "use")).toMatchObject({ code: "ok", state: "answered", delivery: "none" });
    expect((await switchFile(l)).hash).toBe(v2);
    await scan(l, T0 + 30_000);
    expect(cardsOf(l).map((decision) => decision.state)).toEqual(["answered"]);
  });

  test("a newer version supersedes the card; the folder going back withdraws it; keep declines", async () => {
    const l = await life();
    const v2 = await edit(l, T0 + 1000, "#!/bin/sh\necho 2\n");
    const first = openCard(l);
    const v3 = await edit(l, T0 + 20_000, "#!/bin/sh\necho 3\n");
    expect(l.store.get(first!.id)?.state).toBe("superseded");
    expect(openCard(l)?.from.ref?.hash).toBe(v3);
    expect(v3).not.toBe(v2);
    await edit(l, T0 + 40_000, "#!/bin/sh\necho 1\n");
    expect(openCard(l)).toBeUndefined();
    expect(cardsOf(l).at(-1)).toMatchObject({ state: "withdrawn", closedReason: VERSION_CARD_GONE });
    const v4 = await edit(l, T0 + 60_000, "#!/bin/sh\necho 4\n");
    const card = openCard(l);
    expect(card?.from.ref?.hash).toBe(v4);
    expect(await tap(l, card!, 2, "keep")).toMatchObject({ code: "ok", state: "answered" });
    expect((await switchFile(l)).declined).toBe(v4);
    await scan(l, T0 + 80_000);
    expect(openCard(l)).toBeUndefined();
  });

  test("a folder that moved after the card refuses the answer in plain words and keeps the card open", async () => {
    const l = await life();
    await edit(l, T0 + 1000, "#!/bin/sh\necho 2\n");
    const card = openCard(l);
    await writeFile(join(l.dir, "legs.sh"), "#!/bin/sh\necho moved\n");
    expect(await tap(l, card!, 1, "use")).toMatchObject({ code: "rejected", reason: VERSION_MOVED, state: "open" });
    expect(l.store.get(card!.id)?.state).toBe("open");
  });

  test("always approves and turns auto on; Settings then shows it and the next change is taken without asking", async () => {
    const l = await life();
    const v2 = await edit(l, T0 + 1000, "#!/bin/sh\necho 2\n");
    expect(await tap(l, openCard(l)!, 1, "always")).toMatchObject({ code: "ok" });
    expect(await switchFile(l)).toMatchObject({ hash: v2, auto: true });
    const v3 = await edit(l, T0 + 20_000, "#!/bin/sh\necho 3\n");
    expect((await switchFile(l)).hash).toBe(v3);
    const row = (await l.service.reply(undefined)).tricks[0];
    expect(row).toMatchObject({ auto: true, autoAt: new Date(T0 + 20_000 + PENDING_SETTLE_MS).toISOString() });
    expect(openCard(l)).toBeUndefined();
    // Undo goes back; the row then has nothing to undo.
    expect(await l.service.undoRoute("lodge", "legs")).toMatchObject({ status: 200 });
    expect((await l.service.reply(undefined)).tricks[0]?.autoAt).toBeUndefined();
  });

  test("a version that asks for new rights has no always; a forged always is refused", async () => {
    const l = await life();
    await edit(l, T0 + 1000, "#!/bin/sh\necho 2\n", `${MANIFEST}env = ["GH_TOKEN"]\n`);
    const card = openCard(l);
    expect(card?.options.map((option) => option.intent)).toEqual(["use", "keep"]);
    expect(card?.recommends).toBeNull();
    expect(card?.summary).toBe("2 files changed. It now also asks for GH_TOKEN.");
    expect(await tap(l, card!, 1, "always")).toMatchObject({ code: "rejected", reason: "not an option of this decision" });
    expect(await l.cards.answer(card!.from.ref!, "always")).toEqual({ ok: false, reason: VERSION_NEW_RIGHTS });
  });

  test("a warning is new by its kind: another line of a kind the approved copy had keeps the recommendation", async () => {
    const l = await life();
    await edit(l, T0 + 1000, "#!/bin/sh\ncurl https://example.invalid/a\n");
    const first = openCard(l);
    expect(first?.recommends).toBeNull();
    expect(first?.summary).toBe("1 file changed. It now also reaches the network.");
    expect(await tap(l, first!, 1, "use")).toMatchObject({ code: "ok" });
    await edit(l, T0 + 20_000, "#!/bin/sh\ncurl https://example.invalid/a\ncurl https://example.invalid/b\n");
    const second = openCard(l);
    expect(second?.summary).toBe("1 file changed. It asks for no new rights.");
    expect(second?.recommends?.intent).toBe("use");
  });

  test("switching the trick off withdraws its card", async () => {
    const l = await life();
    await edit(l, T0 + 1000, "#!/bin/sh\necho 2\n");
    expect(openCard(l)).toBeDefined();
    expect(await l.service.setSwitch("lodge", "legs", false)).toMatchObject({ status: 200 });
    await l.cards.settled();
    expect(openCard(l)).toBeUndefined();
    expect(cardsOf(l)[0]?.closedReason).toBe(VERSION_CARD_GONE);
  });

  test("the auto route writes the switch, and is refused for a trick that is off", async () => {
    const l = await life();
    expect(await l.service.autoRoute("lodge", "legs", true)).toMatchObject({ status: 200, body: { auto: true } });
    expect((await switchFile(l)).auto).toBe(true);
    expect(await l.service.autoRoute("elsewhere", "legs", true)).toEqual({ status: 404, body: { error: "unknown-host" } });
    await l.service.setSwitch("lodge", "legs", false);
    expect(await l.service.autoRoute("lodge", "legs", true)).toMatchObject({ status: 409, body: { error: "off" } });
    expect(await l.service.undoRoute("lodge", "nope")).toEqual({ status: 404, body: { error: "unknown-trick" } });
  });
});
