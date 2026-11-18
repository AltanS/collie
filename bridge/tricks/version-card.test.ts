import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { memoryHillReceipts } from "../hill/receipts.ts";
import { HillService } from "../hill/service.ts";
import { HillStore } from "../hill/store.ts";
import { HILL_SUMMARY_MAX, type HillDecision, type HillReceipt } from "../../web/src/lib/hill/wire.ts";
import { ACCESS_LINES, DECISION_VIEW_LIMITS, DRAFTS_SESSION_LINE, parseDecisionView, RULES_NEVER_AUTO, SHOWS_IN_WORDS, WATCH_MAX, WATCH_PATH_MAX, type TrickManifest, type ViewNode } from "../../web/src/lib/tricks/schema.ts";
import { parseJson } from "../../web/src/lib/json.ts";
import { TRICKS_DIR } from "./paths.ts";
import { PENDING_SETTLE_MS, TricksService, type TrickVersionSubject } from "./service.ts";
import { powersOfDir } from "./approved.ts";
import { trickCodeHash } from "./code-hash.ts";
import { withSwitch, writeSwitches } from "./switches.ts";
import { GROUP_MASKED_NOTE, GROUP_WRAP } from "./card-group.ts";
import { ACCESS_CHIPS, accessLine, addedDrafts, DRAFTS_SESSION_CHIP, showsIn, asksForSentence, ON_CHIP, newRights, raisedAccess, RULES_ON_MACHINE, VERSION_CARD_GONE, VERSION_MOVED, VERSION_NEW_RIGHTS, VERSION_NOT_SHOWN, VERSION_TOO_MUCH_START, VersionCards, KEEPS_RUNNING, RUNS_AS_YOU, newInputs, versionCard, versionRequestId, versionTitle, versionTooMuch, versionView } from "./version-card.ts";
import { diffArgv, readPatch, versionDiff, viewLine, type DiffRun, type VersionDiff } from "./version-diff.ts";
import { singleCodeCard, viewHasCode } from "../../web/src/lib/hill/code-card.ts";

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

  test("a file whose executable bit alone moved is listed +x, counted, and its code part says so in one line (review 7, 2026-11-17)", async () => {
    const base = await folder({ "trick.toml": MANIFEST, "legs.sh": "echo 1\n", "keep.sh": "echo 2\n" });
    const same = { "trick.toml": MANIFEST, "legs.sh": "echo 1\n", "keep.sh": "echo 2\n" };
    // A stored proposal is 0600: the bits it marked are passed in. This half runs on every platform, as Linux through the platform seam.
    const diff = await versionDiff({ base, next: await folder(same), nextExec: new Set(["legs.sh"]), platform: "linux" });
    expect(diff).toEqual({ files: [{ rel: "legs.sh", change: "changed", plus: 0, minus: 0, hunk: ["legs.sh: mode +x, it can now run as a program"], mode: "+x" }], counted: true });
    const view = JSON.stringify(versionView([], [], diff));
    expect(view).toContain('"text":"changed +x"');
    // The code part holds the change as text, so the card has code to show and its yes works after its end.
    expect(view).toContain('{"kind":"diff","text":"legs.sh: mode +x, it can now run as a program","attrs":{"file":"legs.sh"}}');
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

  test("on Windows the x bit is never part of a change: a mode-only change lists no file (the platform seam)", async () => {
    const files = { "trick.toml": MANIFEST, "legs.sh": "echo 1\n" };
    const base = await folder(files);
    const next = await folder(files);
    expect(await versionDiff({ base, next, nextExec: new Set(["legs.sh"]), platform: "win32" })).toEqual({ files: [], counted: false });
    expect((await versionDiff({ base, next, nextExec: new Set(["legs.sh"]), platform: "linux" })).files.map((file) => file.mode)).toEqual(["+x"]);
  });

  test("an empty file added, removed or renamed shows one line each, so the card has code (2026-11-17)", async () => {
    const base = await folder({ "trick.toml": MANIFEST, "old.txt": "", "gone.txt": "" });
    const next = await folder({ "trick.toml": MANIFEST, "new.txt": "", "gone2.txt": "" });
    const diff = await versionDiff({ base, next });
    expect(diff).toEqual({
      counted: true,
      files: [
        { rel: "gone.txt", change: "removed", plus: 0, minus: 0, hunk: ["gone.txt: an empty file, removed"] },
        { rel: "gone2.txt", change: "added", plus: 0, minus: 0, hunk: ["gone2.txt: an empty file, added"] },
        { rel: "new.txt", change: "added", plus: 0, minus: 0, hunk: ["new.txt: an empty file, added"] },
        { rel: "old.txt", change: "removed", plus: 0, minus: 0, hunk: ["old.txt: an empty file, removed"] },
      ],
    });
    const view = versionView([], [], diff);
    expect(view !== null && viewHasCode(view)).toBe(true);
  });

  test("a change of line ends alone still has lines to show: git prints them, the CR dropped (2026-11-17)", async () => {
    const base = await folder({ "trick.toml": MANIFEST, "legs.sh": "echo 1\n" });
    const next = await folder({ "trick.toml": MANIFEST, "legs.sh": "echo 1\r\n" });
    const diff = await versionDiff({ base, next });
    expect(diff.files.map((file) => [file.rel, file.hunk?.slice(1)])).toEqual([["legs.sh", ["-echo 1", "+echo 1"]]]);
  });

  test("a version whose change shows no code (a binary file, no git) offers Keep only (2026-11-17)", () => {
    const base = subject();
    for (const files of [
      [{ rel: "blob.bin", change: "changed", plus: null, minus: null, hunk: null }],
      [{ rel: "legs.sh", change: "changed", plus: null, minus: null, hunk: null }],
    ] satisfies VersionDiff["files"][]) {
      const card = versionCard(base, { counted: false, files });
      expect(card?.options?.map((option) => option.intent)).toEqual(["keep"]);
      expect(card?.recommends).toBeNull();
      expect(card?.view === undefined || !viewHasCode(card.view)).toBe(true);
    }
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
    const run = async (argv: readonly string[]): Promise<DiffRun> => ({ code: 1, stdout: patches.get(basename(argv.at(-1) ?? "")) ?? "", timedOut: false });
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
    const run = async (argv: readonly string[]): Promise<DiffRun> => ({ code: 1, stdout: patches.get(basename(argv.at(-1) ?? "")) ?? "", timedOut: false });
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
    const run = async (argv: readonly string[]): Promise<DiffRun> => ({ code: 1, stdout: patches.get(basename(argv.at(-1) ?? "")) ?? "", timedOut: false });
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

describe("access: the level a version raises (M105 spec 04)", () => {
  const manifest = (access?: "see" | "read"): TrickManifest => {
    const out: TrickManifest = { id: "legs", name: "Browser leg", run: "./legs.sh", mode: "once", contract: 3, icon: "plug", places: ["belt"] };
    if (access !== undefined) out.access = access;
    return out;
  };
  const withAccess = (next?: "see" | "read", was?: "see" | "read"): ReturnType<typeof versionCard> => {
    const base = subject();
    const pending = base.pending;
    if (pending === null) throw new Error("no pending");
    return versionCard({ ...base, base: { dir: "/y", manifest: manifest(was) }, pending: { ...pending, manifest: manifest(next) } }, DIFF);
  };

  test("raising it is a new right, and a lowering or a keeping is not", () => {
    expect(newRights(manifest(), manifest("see"))).toEqual([ACCESS_CHIPS.see]);
    expect(newRights(manifest(), manifest("read"))).toEqual([ACCESS_CHIPS.read]);
    expect(newRights(manifest("see"), manifest("read"))).toEqual([ACCESS_CHIPS.read]);
    expect(newRights(manifest("read"), manifest("see"))).toEqual([]);
    expect(newRights(manifest("see"), manifest("see"))).toEqual([]);
    expect(newRights(manifest("read"), manifest())).toEqual([]);
    expect(raisedAccess(manifest(), manifest("see"))).toBe("see");
    expect(raisedAccess(manifest("see"), manifest("read"))).toBe("read");
    expect(raisedAccess(manifest("read"), manifest("see"))).toBeUndefined();
    expect(raisedAccess(undefined, manifest("read"))).toBe("read");
  });

  test("the words of each level, exactly, and none for `none`", () => {
    // Plain since M105 spec 05 (decision 10): the bridge holds the level for the local API.
    expect(ACCESS_LINES.see).toBe("It reads your machines, sessions, usage and the Hill.");
    expect(ACCESS_LINES.read).toBe("It reads your sessions' screens.");
    expect(ACCESS_CHIPS.see).toBe("the state of your machines and sessions");
    expect(ACCESS_CHIPS.read).toBe("your sessions' screens");
    expect(accessLine(undefined)).toEqual([]);
    for (const text of [ACCESS_LINES.see, ACCESS_LINES.read, ACCESS_CHIPS.see, ACCESS_CHIPS.read]) expect(text).not.toMatch(/permission|can only/iu);
  });

  test("the card puts the line right after the honest line, names the right, and never recommends or offers always", () => {
    const card = withAccess("see");
    expect(card?.view?.[0]).toEqual({ kind: "para", text: RUNS_AS_YOU });
    expect(card?.view?.[1]).toEqual({ kind: "para", text: ACCESS_LINES.see });
    expect(card?.summary).toContain(`It now also asks for ${ACCESS_CHIPS.see}.`);
    expect(card?.recommends).toBeNull();
    expect(card?.options?.map((option) => option.intent)).toEqual(["use", "keep"]);
    expect(JSON.stringify(withAccess("read", "see")?.view)).toContain(ACCESS_LINES.read);
  });

  test("with a new setting too: the honest line, then the level's line, then the settings line", () => {
    const fields: NonNullable<TrickManifest["fields"]> = [{ key: "repo", kind: "text", label: "Repository" }];
    const base = subject();
    const pending = base.pending;
    if (pending === null) throw new Error("no pending");
    const card = versionCard({ ...base, base: { dir: "/y", manifest: manifest() }, pending: { ...pending, manifest: { ...manifest("see"), fields } } }, DIFF);
    const texts = (card?.view ?? []).map((node) => ("text" in node ? node.text : undefined));
    expect(texts[0]).toBe(RUNS_AS_YOU);
    expect(texts[1]).toBe(ACCESS_LINES.see);
    expect(texts.indexOf(asksForSentence(fields))).toBeGreaterThan(1);
  });

  test("a version that keeps or lowers the level carries no access line and no new right", () => {
    for (const card of [withAccess("see", "see"), withAccess("see", "read"), withAccess(undefined, "read")]) {
      expect(JSON.stringify(card?.view)).not.toContain(ACCESS_LINES.see);
      expect(JSON.stringify(card?.view)).not.toContain(ACCESS_LINES.read);
      expect(card?.view?.[0]).toEqual({ kind: "para", text: RUNS_AS_YOU });
    }
    expect(withAccess("see", "see")?.summary).toContain("It asks for no new rights.");
  });
});

describe("drafts: the right a version adds (1.29.1)", () => {
  const manifest = (drafts?: "session"): TrickManifest => {
    const out: TrickManifest = { id: "legs", name: "Browser leg", run: "./legs.sh", mode: "once", contract: 3, icon: "plug", places: ["session"] };
    if (drafts !== undefined) out.drafts = drafts;
    return out;
  };
  const withDrafts = (next?: "session", was?: "session"): ReturnType<typeof versionCard> => {
    const base = subject();
    const pending = base.pending;
    if (pending === null) throw new Error("no pending");
    return versionCard({ ...base, base: { dir: "/y", manifest: manifest(was) }, pending: { ...pending, manifest: manifest(next) } }, DIFF);
  };

  test("adding it is a new right with its chip, and keeping or dropping it is not", () => {
    expect(newRights(manifest(), manifest("session"))).toEqual([DRAFTS_SESSION_CHIP]);
    expect(newRights(manifest("session"), manifest("session"))).toEqual([]);
    expect(newRights(manifest("session"), manifest())).toEqual([]);
    expect(addedDrafts(manifest(), manifest("session"))).toBe("session");
    expect(addedDrafts(manifest("session"), manifest("session"))).toBeUndefined();
    expect(addedDrafts(undefined, manifest("session"))).toBe("session");
  });

  test("the card holds the line after the honest line, names the chip, and never recommends", () => {
    const card = withDrafts("session");
    expect(card?.view?.[0]).toEqual({ kind: "para", text: RUNS_AS_YOU });
    expect(card?.view?.[1]).toEqual({ kind: "para", text: DRAFTS_SESSION_LINE });
    expect(card?.summary).toContain(`It now also asks for ${DRAFTS_SESSION_CHIP}.`);
    expect(card?.recommends).toBeNull();
    for (const kept of [withDrafts("session", "session"), withDrafts(undefined, "session")]) expect(JSON.stringify(kept?.view)).not.toContain(DRAFTS_SESSION_LINE);
  });
});

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
    expect(view[0]).toEqual({ kind: "para", text: RUNS_AS_YOU });
    expect(view.map((node) => node.kind)).toEqual(["para", "para", "table", "diff", "diff", "diff"]);
    expect(parseDecisionView(parseJson(JSON.stringify(view))).refusals).toEqual([]);
  });

  test("B2: a file name the view would refuse is cleaned for display, so the view stays", () => {
    const pending = subject().pending!;
    const card = versionCard(
      { ...subject(), pending: { ...pending, info: { ...pending.info, files: { added: 0, changed: 1, removed: 0 } } } },
      { counted: true, files: [{ rel: "evil\u202egnp.ts", change: "changed", plus: 1, minus: 1, hunk: ["@@ -1 +1 @@", "-a", "+b"] }] },
    );
    expect(card?.view).toBeDefined();
    expect(card?.view?.[0]).toEqual({ kind: "para", text: RUNS_AS_YOU });
    // The honest line, then where the trick shows, then the table.
    const table = card?.view?.[2];
    expect(table?.kind).toBe("table");
    expect(table !== undefined && "kids" in table ? table.kids?.[4] : undefined).toEqual({ kind: "cell", text: "evil?gnp.ts" });
    expect(card?.view?.[3]).toMatchObject({ kind: "diff", attrs: { file: "evil?gnp.ts" } });
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
    // The honest line is never left out: with no view of the change, it is the view alone.
    expect(card?.view).toEqual([{ kind: "para", text: RUNS_AS_YOU }]);
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
    expect(view.shift()).toEqual({ kind: "para", text: RUNS_AS_YOU });
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
    expect(crew?.view?.[0]).toEqual({ kind: "para", text: RUNS_AS_YOU });
    expect(crew?.view?.[1]).toEqual({ kind: "para", text: "Reads TODO.md, notes/*.md in your agent sessions' folders on every machine of the crew." });
    const solo = versionCard(next, DIFF);
    expect(solo?.summary).toBe("3 files changed. It now also reads files in your agent sessions' folders.");
    expect(solo?.view?.[1]).toEqual({ kind: "para", text: "Reads TODO.md, notes/*.md in your agent sessions' folders." });
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
    expect(card?.view?.[0]).toEqual({ kind: "para", text: RUNS_AS_YOU });
    expect(card?.view?.[1]).toEqual({ kind: "para", text: "Reads TODO.md in your agent sessions' folders." });
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
      { ...base, pending: { ...pending, info: { ...pending.info, powersChanged: true, warnings: ["spawn", "network", "write", "model", "import", "api"].map((kind) => ({ kind, text: "x" })) }, manifest: { ...pending.manifest!, env } } },
      { counted: false, files: [] },
    );
    expect([...(card?.summary ?? "")].length).toBeLessThanOrEqual(HILL_SUMMARY_MAX);
    expect(card?.summary).toBe("3 files changed. It asks for new rights, listed below. 0 of 3 files shown.");
  });

  test("review 2 item 1: eight watch paths at the cap all show, and Use is offered", () => {
    const base = subject();
    const pending = base.pending!;
    const watch = Array.from({ length: WATCH_MAX }, (_, i) => `/home/dev/${String(i)}${"w".repeat(WATCH_PATH_MAX - 11)}`);
    for (const path of watch) expect([...path].length).toBe(WATCH_PATH_MAX);
    const card = versionCard({ ...base, pending: { ...pending, info: { ...pending.info, powersChanged: true }, manifest: { ...pending.manifest!, on: ["turn.end"], watch } } }, DIFF);
    const words = JSON.stringify(card?.view);
    for (const path of watch) expect(words).toContain(path);
    expect(words).toContain(ON_CHIP);
    expect(card?.view?.[0]).toEqual({ kind: "para", text: RUNS_AS_YOU });
    expect(card?.options?.map((option) => option.intent)).toEqual(["use", "keep"]);
    expect(card?.summary).not.toContain(VERSION_TOO_MUCH_START);
  });

  test("review 2 item 1: a version whose new rights do not fit the card offers Keep only, and the summary says where to read it", () => {
    const base = subject();
    const pending = base.pending!;
    // Every right within its own cap, together past the view's 8 KiB: four-byte characters in each path and glob.
    const wide = "𝔀";
    const watch = Array.from({ length: WATCH_MAX }, (_, i) => `/home/dev/${String(i)}${wide.repeat(WATCH_PATH_MAX - 11)}`);
    const env = Array.from({ length: 32 }, (_, i) => `TOKEN_${String(i).padStart(2, "0")}_${"X".repeat(55)}`);
    const next: TrickVersionSubject = { ...base, pending: { ...pending, info: { ...pending.info, powersChanged: true }, manifest: { ...pending.manifest!, env, watch } } };
    const card = versionCard(next, DIFF);
    expect(card?.options).toEqual([{ intent: "keep", label: "Keep the old version" }]);
    expect(card?.recommends).toBeNull();
    expect(card?.group).toBeUndefined();
    expect(card?.summary).toBe(`3 files changed. ${versionTooMuch("legs")}`);
    expect(card?.summary).not.toContain("listed below");
    expect(versionTooMuch("legs")).toBe("The new version asks for more than this card can show. Read it on the machine with collie trick check, then take it there with collie trick on legs.");
    expect([...(card?.summary ?? "")].length).toBeLessThanOrEqual(HILL_SUMMARY_MAX);
    // The honest line stays the first paragraph, and it is all the view holds.
    expect(card?.view).toEqual([{ kind: "para", text: RUNS_AS_YOU }]);
    // The same with no diff at all: still no Use.
    expect(versionCard(next, { counted: false, files: [] })?.options?.map((option) => option.intent)).toEqual(["keep"]);
  });

  test("review G point 2: a changed field list is something new, so a card that cannot show it whole offers Keep only", () => {
    const base = subject();
    const pending = base.pending!;
    const fields: NonNullable<TrickManifest["fields"]> = [{ key: "repo", kind: "text", label: "Repository" }];
    // More masked notes than one view holds: the head does not fit, whatever the change is.
    const files: VersionDiff["files"] = Array.from({ length: 30 }, (_, i) => ({ rel: `f${String(i)}.sh`, change: "changed", plus: 1, minus: 1, hunk: ["@@ -1 +1 @@", "-a", "+b"], masked: 1 }));
    const diff: VersionDiff = { counted: true, files };
    const withFields = versionCard({ ...base, pending: { ...pending, manifest: { ...pending.manifest!, fields } } }, diff);
    expect(withFields?.options).toEqual([{ intent: "keep", label: "Keep the old version" }]);
    expect(withFields?.summary).toContain(VERSION_TOO_MUCH_START);
    // With the field list unchanged the rule does not hold it back. That card shows no code either (its
    // masked notes fill the view), so it offers Keep only too (2026-11-17); a change that shows offers "Use".
    const same = versionCard({ ...base, pending: { ...pending, manifest: { ...pending.manifest! } } }, diff);
    expect(same?.summary).not.toContain(VERSION_TOO_MUCH_START);
    expect(same?.options?.map((option) => option.intent)).toEqual(["keep"]);
    // Every changed file whole and as it is (A5: a card that cannot show every byte offers no yes).
    const shows = versionCard({ ...base, pending: { ...pending, manifest: { ...pending.manifest! } } }, DIFF);
    expect(shows?.options?.map((option) => option.intent)).toContain("use");
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
  await writeSwitches(stateDir, withSwitch({ on: new Map() }, "legs", true, "2026-11-10T08:00:00Z", code.hash, await powersOfDir(dir, "legs")));
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
    feature: { on: () => true },
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

describe("an agent view's rules on the card (contract 2)", () => {
  const VIEW: TrickManifest = { id: "morph", name: "Morph", mode: "once", contract: 2, icon: "eye", places: [], agentView: true, rules: "rules.md" };
  const OLD = "Draw one screen.\nKeep it short.\n";
  const NEW = "Draw one screen.\nKeep it short.\nNever ask for a password.\n";
  const sha = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const view = (text: string): TrickManifest => ({ ...VIEW, rulesText: text, rulesSha256: sha(text) });
  const rulesSubject = (base: TrickManifest | undefined, next: TrickManifest, files = { added: 0, changed: 1, removed: 0 }): TrickVersionSubject => ({
    id: "morph",
    name: "Morph",
    waiting: true,
    pending: { hash: "b".repeat(64), dir: "/x", info: { hash: "b".repeat(64), files, powersChanged: true, warnings: [] }, manifest: next },
    base: base === undefined ? null : { dir: "/y", manifest: base },
  });
  // What git says of the rules file: masked, so the card never shows these rows for it.
  const gitRules = (text: string): VersionDiff => ({ counted: true, files: [{ rel: "rules.md", change: "changed", plus: 1, minus: 0, hunk: ["@@ -1,2 +1,3 @@", ...text.split("\n").slice(0, -1).map((line) => ` ${line}`)] }] });
  /** Every diff row of a view or a group, in order. */
  const rowsOf = (views: readonly (readonly ViewNode[])[]): string[] => views.flatMap((v) => v.flatMap((node) => (node.kind === "diff" ? node.text.split("\n") : [])));
  /** The new text the rows say: every row but `-` and the header, without its sign. */
  const newText = (rows: readonly string[]): string => `${rows.filter((row) => !row.startsWith("-") && !row.startsWith("@@")).map((row) => row.slice(1)).join("\n")}\n`;

  test("a changed rules text: the chip, the words, the whole diff, no stop-asking option and no recommendation", () => {
    const card = versionCard(rulesSubject(view(OLD), view(NEW)), gitRules(NEW));
    expect(card?.options?.map((o) => o.intent)).toEqual(["use", "keep"]);
    expect(card?.recommends).toBeNull();
    expect(card?.summary).toBe("1 file changed. It now also gives your agents new instructions.");
    expect(card?.group).toBeUndefined();
    const text = JSON.stringify(card?.view);
    expect(text).toContain('{"kind":"chip","text":"new agent instructions","attrs":{"tone":"warn"}}');
    expect(text).toContain('"text":"Gives your agents instructions written by its author."');
    expect(text).toContain('"text":"The agent instructions, every line:"');
    const rows = rowsOf([card?.view ?? []]);
    expect(rows).toEqual(["@@ -1,2 +1,3 @@", " Draw one screen.", " Keep it short.", "+Never ask for a password."]);
    expect(newText(rows)).toBe(NEW);
  });

  test("a new agent view with long rules shows every line on a group of cards, never 'not shown'", () => {
    const long = Array.from({ length: 70 }, (_, i) => `Rule ${String(i + 1)}: ${"draw one plain screen and keep each line short ".repeat(2).trim()}.`).join("\n").concat("\n");
    // Within the rules cap, but past what one card holds beside the facts.
    expect(long.length).toBeLessThanOrEqual(8 * 1024);
    const base: TrickManifest = { id: "morph", name: "Morph", run: "./p.sh", mode: "once", contract: 2, icon: "eye", places: ["belt"] };
    const card = versionCard(rulesSubject(base, view(long), { added: 1, changed: 1, removed: 0 }), { counted: true, files: [{ rel: "rules.md", change: "added", plus: 70, minus: 0, hunk: null }, { rel: "trick.toml", change: "changed", plus: 2, minus: 0, hunk: ["@@ -1 +1,2 @@", '+rules = "rules.md"', '+places = ["belt", "agent-view"]'] }] });
    expect(card?.summary).not.toContain(VERSION_NOT_SHOWN);
    expect(card?.options?.map((o) => o.intent)).toEqual(["use", "keep"]);
    const parts = card?.group?.parts ?? [];
    expect(parts.length).toBeGreaterThan(2);
    const first = JSON.stringify(parts[0]);
    expect(first).toContain('"text":"an agent view"');
    expect(first).toContain('"text":"new agent instructions"');
    expect(first).toContain("Adds a view of a session that the session's own agent draws. You switch it on per session.");
    expect(first).toContain("A tap in that view sends a message in your name to that session only.");
    // Every rules row on the cards, in order, before the other files: the bytes of the file, whole.
    const rows = rowsOf(parts.slice(1));
    const rulesRows = rows.slice(0, rows.indexOf('+rules = "rules.md"') === -1 ? rows.length : rows.indexOf("@@ -1 +1,2 @@"));
    expect(newText(rulesRows)).toBe(long);
    for (const part of parts) expect(parseDecisionView(parseJson(JSON.stringify(part))).view).toBeDefined();
  });

  test("a trick with rules whose rules did not change still never offers stop asking", () => {
    const card = versionCard(rulesSubject(view(OLD), { ...view(OLD), run: "./p.sh" }), DIFF);
    expect(card?.options?.map((o) => o.intent)).toEqual(["use", "keep"]);
    expect(JSON.stringify(card?.view)).not.toContain("new agent instructions");
  });

  test("the card's always answer is refused for a trick with rules", async () => {
    // The Hill offers no "always" on such a card; this is the seam behind it, should a claim name it anyway.
    // SAFETY: the card posts through these three calls only; the refusal comes before any other is reached.
    const hill = { postCollie: () => ({ ok: true }), withdrawCollie: () => ({ ok: true }), collieDecisions: () => [] } as never;
    const calls: string[] = [];
    // SAFETY: answer() reaches only these three calls of the tricks service.
    const tricks = { approvePending: async () => (calls.push("approve"), { ok: true }), declinePending: async () => ({ ok: true }), setAuto: async () => (calls.push("auto"), { ok: true }) } as never;
    const cards = new VersionCards({ hill, tricks: () => tricks, diff: async () => ({ counted: true, files: [] }) });
    const held = rulesSubject(view(OLD), { ...view(OLD), run: "./p.sh" });
    cards.sync([{ ...held, pending: held.pending === null ? null : { ...held.pending, info: { ...held.pending.info, powersChanged: false } } }]);
    await cards.settled();
    expect(await cards.answer({ type: "version", id: "morph", hash: "b".repeat(64) }, "always")).toEqual({ ok: false, reason: RULES_NEVER_AUTO });
    expect(calls).toEqual([]);
  });
});

describe("review 8 V-S1: no yes without the rules on screen", () => {
  const sha = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const view = (text: string): TrickManifest => ({ id: "morph", name: "Morph", mode: "once", contract: 2, icon: "eye", places: [], agentView: true, rules: "rules.md", rulesText: text, rulesSha256: sha(text) });
  const held = (old: string, now: string): TrickVersionSubject => ({
    id: "morph",
    name: "Morph",
    waiting: true,
    pending: { hash: "b".repeat(64), dir: "/x", info: { hash: "b".repeat(64), files: { added: 0, changed: 1, removed: 0 }, powersChanged: true, warnings: [] }, manifest: view(now) },
    base: { dir: "/y", manifest: view(old) },
  });
  const masked: VersionDiff = { counted: true, files: [{ rel: "rules.md", change: "changed", plus: 4000, minus: 4000, hunk: null }] };
  /** Every diff row on the cards after card 1, in order. */
  const rowsAfterFirst = (card: ReturnType<typeof versionCard>): string[] =>
    (card?.group?.parts ?? []).slice(1).flatMap((part) => part.flatMap((node) => (node.kind === "diff" ? node.text.split("\n") : [])));
  /** The text the `+` and context rows say, without the wrap marks of a long line. */
  const newOf = (rows: readonly string[]): string => {
    const lines: string[] = [];
    for (const row of rows) {
      if (row.startsWith("@@") || row.startsWith("-")) continue;
      const body = row.slice(1);
      if (body.startsWith(GROUP_WRAP)) lines[lines.length - 1] += body.slice(GROUP_WRAP.length);
      else lines.push(body);
    }
    return `${lines.join("\n")}\n`;
  };

  test("every card that shows rules is held to the code card rule: one card with a diff (no fold, yes after its end), else a group", () => {
    const small = versionCard(held("Draw.\n", "Draw one screen.\n"), { counted: true, files: [{ rel: "rules.md", change: "changed", plus: 1, minus: 1, hunk: ["@@ -1 +1 @@", "-Draw.", "+Draw one screen."] }] });
    // One card: no group, and its view holds the rules as a diff node, so the phone's singleCodeCard takes it.
    expect(small?.group).toBeUndefined();
    expect(viewHasCode(small?.view ?? [])).toBe(true);
    expect(JSON.stringify(small?.view)).toContain('"file":"rules.md"');
    // Too long for one card, line by line or whole: a group, whose yes needs every card opened.
    const long = (n: number): string => Array.from({ length: n }, (_, i) => `Line ${String(i)} of the rules.\n`).join("");
    const byLine = versionCard(held(long(300), long(340)), { counted: true, files: [{ rel: "rules.md", change: "changed", plus: 40, minus: 0, hunk: null }] });
    const whole = versionCard(held("a\n".repeat(4000), "b\n".repeat(4000)), masked);
    for (const card of [byLine, whole]) {
      expect(card?.group?.decline).toBe("keep");
      expect((card?.group?.parts.length ?? 0) > 1).toBe(true);
      expect(card?.group?.parts.slice(1).every((part) => viewHasCode(part))).toBe(true);
    }
    // No room at all: Keep alone, so there is no yes to hold.
    const none = versionCard(held("a\n".repeat(2000), "b\n".repeat(2000)), masked, false, 0);
    expect(none?.options?.map((o) => o.intent)).toEqual(["keep"]);
  });

  test("a change of 4000 lines for 4000 shows the new rules whole on cards of their own, and only then offers Use", () => {
    const old = "a\n".repeat(4000);
    const now = "b\n".repeat(4000);
    const card = versionCard(held(old, now), masked);
    const parts = card?.group?.parts ?? [];
    expect(parts.length).toBeGreaterThan(1);
    expect(newOf(rowsAfterFirst(card))).toBe(now);
    const first = JSON.stringify(parts[0]);
    expect(first).toContain("The change is too long to show line by line, so the new agent instructions show whole");
    expect(first).not.toContain("on card 2, every line");
    expect(card?.options?.map((o) => o.intent)).toEqual(["use", "keep"]);
    for (const part of parts) expect(parseDecisionView(parseJson(JSON.stringify(part))).view).toBeDefined();
  });

  test("the worst rules a file may hold fit: 8 KiB of the longest escapes, one character a line, or 160 a line", () => {
    for (const now of ['"\n'.repeat(4096), `${'"\\'.repeat(80)}\n`.repeat(50), "a\n\n".repeat(2730)]) {
      expect(now.length).toBeLessThanOrEqual(8 * 1024);
      const card = versionCard(held("x\n".repeat(4096), now), masked);
      expect(newOf(rowsAfterFirst(card)), JSON.stringify(now.slice(0, 8))).toBe(now);
      expect(card?.options?.map((o) => o.intent)).toEqual(["use", "keep"]);
    }
  });

  test("when the rules cannot be shown at all, the card offers only Keep and says to take it on the machine", () => {
    // No room for the rules' own cards: the case a larger cap would reach.
    const card = versionCard(held("a\n".repeat(2000), "b\n".repeat(2000)), masked, false, 0);
    expect(card?.options?.map((o) => o.intent)).toEqual(["keep"]);
    expect(card?.group).toBeUndefined();
    expect(card?.summary).toBe(`1 file changed. It now also gives your agents new instructions. ${RULES_ON_MACHINE}`);
    expect(RULES_ON_MACHINE).toBe("The new agent instructions do not fit on the phone, so this version can only be taken on the machine.");
    expect(JSON.stringify(card?.view)).toContain("Read them there, then take it with: collie trick on morph");
    expect(JSON.stringify(card)).not.toContain("on card 2");
  });
});

describe("the line of a trick that keeps running with no phone open (Altan, 2026-11-17)", () => {
  const manifest = (extra: Partial<TrickManifest> = {}): TrickManifest => ({ id: "legs", name: "Browser leg", run: "./legs.sh", mode: "once", contract: 3, icon: "plug", places: ["belt"], ...extra });
  const card = (next: TrickManifest, was: TrickManifest = manifest()): NonNullable<ReturnType<typeof versionCard>> => {
    const base = subject();
    const pending = base.pending;
    if (pending === null) throw new Error("no pending");
    const made = versionCard({ ...base, base: { dir: "/y", manifest: was }, pending: { ...pending, manifest: next } }, DIFF);
    if (made === null) throw new Error("no card");
    return made;
  };
  const texts = (view: readonly ViewNode[] | undefined): (string | undefined)[] => (view ?? []).map((node) => ("text" in node ? node.text : undefined));

  test("a new version with `on` or `watch` says it, after the rights lines", () => {
    for (const set of [{ on: ["turn.end" as const] }, { watch: ["~/notes/todo.md"] }]) {
      const view = card(manifest(set)).view;
      const at = texts(view).indexOf(KEEPS_RUNNING);
      expect(at).toBeGreaterThan(0);
      expect((view ?? []).findIndex((node) => node.kind === "bar")).toBeLessThan(at);
    }
  });

  test("a version that keeps the same watch still says it", () => {
    const watching = manifest({ watch: ["~/notes/todo.md"] });
    expect(texts(card({ ...watching, access: "see" }, watching).view)).toContain(KEEPS_RUNNING);
  });

  test("a tap-only trick, and a plain timer, do not", () => {
    expect(texts(card(manifest({ access: "see" })).view)).not.toContain(KEEPS_RUNNING);
    expect(texts(card(manifest({ every: "30s", everyMs: 30_000, access: "see" })).view)).not.toContain(KEEPS_RUNNING);
  });
});

// WHERE THE TRICK SHOWS (the operator, 2026-11-17: "I want to see where a trick is drawn"): one line on the approval
// card, built from the manifest's places in the schema's words, after the rights lines. No place, no line.
describe("the line of where a trick shows", () => {
  test("the words of each place, exactly, and the agent view last; each place once; none for a trick with neither", () => {
    expect(SHOWS_IN_WORDS).toEqual({
      belt: "the end of the Belt in each session",
      status: "the left end of the usage row of each session",
      session: "a page of its own (a row under Tricks on the Dashboard)",
      dashboard: "a tile in the strip at the top of the Dashboard",
      tabbar: "an item in the bottom bar of the Dashboard",
      menu: "rows in each session's settings",
      float: "a small moving picture over the app",
    });
    expect(showsIn({ places: ["status", "tabbar", "status"], agentView: true })).toEqual([
      { kind: "para", text: "It shows in: the left end of the usage row of each session, an item in the bottom bar of the Dashboard, a view of a session, beside Terminal and Chat." },
    ]);
    expect(showsIn({ places: [] })).toEqual([]);
    expect(showsIn(undefined)).toEqual([]);
  });

  const manifest = (extra: Partial<TrickManifest> = {}): TrickManifest => ({ id: "legs", name: "Browser leg", run: "./legs.sh", mode: "once", contract: 3, icon: "plug", places: ["belt"], ...extra });

  test("the version card carries it for the new version's places, after the rights lines", () => {
    const base = subject();
    const pending = base.pending;
    if (pending === null) throw new Error("no pending");
    const card = versionCard({ ...base, base: { dir: "/y", manifest: manifest() }, pending: { ...pending, manifest: manifest({ access: "see", places: ["status", "dashboard"] }) } }, DIFF);
    const texts = (card?.view ?? []).map((node) => ("text" in node ? node.text : undefined));
    expect(texts).toContain("It shows in: the left end of the usage row of each session, a tile in the strip at the top of the Dashboard.");
    expect(texts.indexOf("It shows in: the left end of the usage row of each session, a tile in the strip at the top of the Dashboard.")).toBeGreaterThan(texts.indexOf(ACCESS_LINES.see));
    const none = versionCard({ ...base, base: { dir: "/y", manifest: manifest() }, pending: { ...pending, manifest: manifest({ access: "see", places: [] }) } }, DIFF);
    expect(JSON.stringify(none?.view)).not.toContain("It shows in");
  });
});
