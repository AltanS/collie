import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RootSnapshot } from "./changes-root.ts";
import { crewGate } from "./crew/peer-gate.ts";
import {
  compareEntries,
  decodeFileText,
  existingPaths,
  type FilesContext,
  filesQuery,
  gitIgnoredNames,
  listFolder,
  MAX_FILES_ENTRIES,
  MAX_EXIST_PATHS,
  MAX_FILES_READ_BYTES,
  NODE_FILES_FS,
  parseRelPath,
  readFile,
  UNKNOWN_PATH,
} from "./files-view.ts";
import { hostFor } from "./host.ts";
import { containedRealpath } from "./journal/files.ts";
import { filesExist, filesPrivateFolders, paneFiles, paneGateLevel, parseFilesExistBody, workspaceFiles } from "./server.ts";
import type { AgentView, FileEntry, FileReadAnswer, FilesListing, WorkspaceView } from "./types.ts";

// The Files view (ADR 0083) is the third place a client value becomes a path, so most of this file
// is an attacker's checklist run against a real folder on disk: traversal, encoded separators,
// symlink chains, a symlinked root, a root that holds the state folder, a link into `.git`, a FIFO.
// Every refusal must be the same `unknown-path`.

const LINUX = hostFor("linux");
const WIN = hostFor("win32");
const POSIX = process.platform !== "win32";

let base: string;
let home: string;
let root: string;
let state: string;
let config: string;
let outside: string;
let ctx: FilesContext;

function write(path: string, body: string | Uint8Array): void {
  writeFileSync(path, body);
}

beforeAll(() => {
  // realpath: macOS's tmpdir is itself a link (/var → /private/var), and the root's real path is
  // what containment compares against.
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "collie-files-view-")));
  home = join(base, "home");
  root = join(home, "projects", "ws");
  outside = join(base, "outside");
  state = join(root, ".collie-state");
  config = join(root, "collie-config");
  for (const dir of [root, outside, state, config, join(root, "c", "deep"), join(root, ".git"), join(root, "sub", ".git")]) {
    mkdirSync(dir, { recursive: true });
  }
  write(join(root, "a.txt"), "hello\n");
  write(join(root, "B.md"), "# B\n");
  write(join(root, "c", "inner.txt"), "inner\n");
  write(join(root, ".env"), "OPERATOR=yes\n");
  write(join(root, ".git", "config"), "[core]\n");
  write(join(root, "sub", ".git", "HEAD"), "ref: x\n");
  write(join(root, "sub", "code.ts"), "export {};\n");
  write(join(root, "%2e%2e"), "literal name\n");
  write(join(state, "paired-devices.json"), "{}");
  write(join(config, ".env"), "COLLIE_VAPID_PRIVATE=secret\n");
  write(join(outside, "secret.txt"), "secret\n");
  write(join(root, "bin.dat"), new Uint8Array([0x89, 0x50, 0, 1, 2]));

  // Links. Out of the root, inside it, a chain that ends outside, a loop, into the state folder,
  // into `.git`, and a folder link inside the root.
  symlinkSync(join(outside, "secret.txt"), join(root, "leak"));
  symlinkSync(outside, join(root, "leakdir"), "dir");
  symlinkSync("a.txt", join(root, "inside"));
  symlinkSync(join(outside, "secret.txt"), join(root, "chain2"));
  symlinkSync("chain2", join(root, "chain1"));
  symlinkSync("loop", join(root, "loop"));
  symlinkSync(state, join(root, "tostate"), "dir");
  symlinkSync(join(root, ".git", "config"), join(root, "gitlink"));
  symlinkSync(join(root, "c"), join(root, "clink"), "dir");

  // A SIBLING instance's state folder under the root (a root of `~/.local/state` holds every
  // instance's): not one of this bridge's private folders, so only the basename rule guards it.
  const sib = join(root, "sib", "collie-other");
  mkdirSync(sib, { recursive: true });
  for (const name of ["crew-trust.json", "PAIRED-DEVICES.json", "pairing-pending.json", "stt.json", "pack-trust.json"]) {
    write(join(sib, name), '{"token":"placeholder"}');
  }
  write(join(sib, "push-subscriptions.json.tmp"), "{}");
  write(join(sib, "standby-devices.json.4242.7.tmp"), "{}");
  write(join(sib, "activity.json"), "{}");
  write(join(sib, "crew-trust.json.bak"), "{}");
  symlinkSync(join(sib, "crew-trust.json"), join(root, "sib", "notes"));

  ctx = { root, home, privateFolders: [state, config] };
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

async function read(path: string, c: FilesContext = ctx): Promise<FileReadAnswer | typeof UNKNOWN_PATH> {
  return readFile(c, path);
}
async function list(dir: string, c: FilesContext = ctx): Promise<FilesListing | typeof UNKNOWN_PATH> {
  return listFolder(c, dir);
}
function names(listing: FilesListing | typeof UNKNOWN_PATH): string[] {
  if (listing === UNKNOWN_PATH || !listing.available) throw new Error(`no listing: ${JSON.stringify(listing)}`);
  return listing.entries.map((e) => e.name);
}

// ── The grammar, before any disk call ────────────────────────────────────────────────────────────

describe("the relative path is refused on its shape", () => {
  test("absolute, traversal, dot and empty segments, NUL, backslash and an over-long path", () => {
    for (const bad of [
      "/etc/passwd",
      "..",
      "../x",
      "a/../b",
      "a/..",
      "./a",
      "a/./b",
      "a//b",
      "a/",
      "/",
      "a\\b",
      "..\\x",
      "a\0b",
      "x".repeat(4097),
    ]) {
      expect(parseRelPath(bad, LINUX)).toBeNull();
    }
    // 4096 bytes is the bound in BYTES: 2049 two-byte characters are 4098 bytes.
    expect(parseRelPath("é".repeat(2049), LINUX)).toBeNull();
    expect(parseRelPath("x".repeat(4096), LINUX)).toEqual(["x".repeat(4096)]);
  });

  test("a .git segment, in any case and at any depth", () => {
    for (const bad of [".git", ".git/config", "sub/.git/HEAD", ".GIT/config", "a/.Git"]) {
      expect(parseRelPath(bad, LINUX)).toBeNull();
    }
    // A name that merely contains it is a name.
    expect(parseRelPath("my.git/x", LINUX)).toEqual(["my.git", "x"]);
    expect(parseRelPath(".gitignore", LINUX)).toEqual([".gitignore"]);
  });

  test("the root is the empty string, and dot-files are names", () => {
    expect(parseRelPath("", LINUX)).toEqual([]);
    expect(parseRelPath(".env", LINUX)).toEqual([".env"]);
    expect(parseRelPath("a/b c/d.txt", LINUX)).toEqual(["a", "b c", "d.txt"]);
  });

  test("on Windows: a colon, a wildcard, a trailing dot or space, and a device name", () => {
    for (const bad of ["C:x", "a:b", "file.txt:stream", "a*", "a?", "a|b", "con", "NUL.txt", "com1", "lpt9.log", ".git.", "secret ", "dir./x"]) {
      expect(parseRelPath(bad, WIN)).toBeNull();
    }
    expect(parseRelPath("src/app.ts", WIN)).toEqual(["src", "app.ts"]);
    // The same names are ordinary on POSIX, apart from the .git and traversal rules.
    expect(parseRelPath("a:b", LINUX)).toEqual(["a:b"]);
    expect(parseRelPath("con", LINUX)).toEqual(["con"]);
  });

  test("on Windows: an 8.3 short name is refused, since it can spell a denied name", () => {
    for (const bad of ["PAIRED~1.JSO", "src/PROGRA~1", "a~1", ".GIT~1/config", "x~9.txt"]) {
      expect(parseRelPath(bad, WIN)).toBeNull();
    }
    // A tilde not followed by a digit is an ordinary name, and every name is ordinary on POSIX.
    expect(parseRelPath("notes~.txt", WIN)).toEqual(["notes~.txt"]);
    expect(parseRelPath("a~b", WIN)).toEqual(["a~b"]);
    expect(parseRelPath("PAIRED~1.JSO", LINUX)).toEqual(["PAIRED~1.JSO"]);
  });

  test("the query is decoded once, by URLSearchParams, and never again", () => {
    // An encoded separator is the separator, so `%2e%2e%2f` is `../` and refused.
    expect(filesQuery(new URL("http://x/?path=%2e%2e%2fsecret"))).toEqual({ mode: "read", path: "../secret" });
    expect(parseRelPath("../secret", LINUX)).toBeNull();
    expect(filesQuery(new URL("http://x/?path=a%5Cb"))).toEqual({ mode: "read", path: "a\\b" });
    // A double-encoded dot pair stays the literal name `%2e%2e`.
    expect(filesQuery(new URL("http://x/?path=%252e%252e"))).toEqual({ mode: "read", path: "%2e%2e" });
    expect(filesQuery(new URL("http://x/"))).toEqual({ mode: "list", dir: "" });
    expect(filesQuery(new URL("http://x/?dir=c"))).toEqual({ mode: "list", dir: "c" });
    // Both sent: the read wins.
    expect(filesQuery(new URL("http://x/?dir=c&path=a.txt"))).toEqual({ mode: "read", path: "a.txt" });
  });
});

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────────

describe("read one file", () => {
  test("a text file, whole", async () => {
    expect(await read("a.txt")).toEqual({
      available: true,
      root,
      path: "a.txt",
      size: 6,
      binary: false,
      truncated: false,
      text: "hello\n",
    });
    expect(await read("c/inner.txt")).toMatchObject({ path: "c/inner.txt", text: "inner\n" });
    // A dot-file is the operator's own file, and shown.
    expect(await read(".env")).toMatchObject({ text: "OPERATOR=yes\n" });
  });

  test("a literal %2e%2e file is read as the name it is", async () => {
    expect(await read("%2e%2e")).toMatchObject({ text: "literal name\n" });
  });

  test("traversal and absolute paths answer unknown-path", async () => {
    for (const bad of ["../outside/secret.txt", "../../../outside/secret.txt", "/etc/passwd", "c/../../x", "a\\b", "a\0b"]) {
      expect(await read(bad)).toBe(UNKNOWN_PATH);
    }
  });

  test("a symlink out of the root, a folder link out, a chain and a loop answer unknown-path", async () => {
    expect(await read("leak")).toBe(UNKNOWN_PATH);
    expect(await read("leakdir/secret.txt")).toBe(UNKNOWN_PATH);
    expect(await read("chain1")).toBe(UNKNOWN_PATH);
    expect(await read("chain2")).toBe(UNKNOWN_PATH);
    expect(await read("loop")).toBe(UNKNOWN_PATH);
  });

  test("a symlink that stays inside reads its target, under the asked name", async () => {
    expect(await read("inside")).toMatchObject({ path: "inside", text: "hello\n" });
    expect(await read("clink/inner.txt")).toMatchObject({ path: "clink/inner.txt", text: "inner\n" });
  });

  test(".git answers unknown-path, asked directly or through a link", async () => {
    expect(await read(".git/config")).toBe(UNKNOWN_PATH);
    expect(await read("sub/.git/HEAD")).toBe(UNKNOWN_PATH);
    expect(await read("gitlink")).toBe(UNKNOWN_PATH);
  });

  test("the state folder and the config folder answer unknown-path, directly or through a link", async () => {
    expect(await read(".collie-state/paired-devices.json")).toBe(UNKNOWN_PATH);
    expect(await read("collie-config/.env")).toBe(UNKNOWN_PATH);
    expect(await read("tostate/paired-devices.json")).toBe(UNKNOWN_PATH);
  });

  test("a sibling instance's state secrets answer unknown-path by basename, in any case and through a link", async () => {
    for (const name of [
      "crew-trust.json",
      "PAIRED-DEVICES.json",
      "paired-devices.json",
      "pairing-pending.json",
      "stt.json",
      "pack-trust.json",
      "push-subscriptions.json.tmp",
      "standby-devices.json.4242.7.tmp",
    ]) {
      expect(await read(`sib/collie-other/${name}`)).toBe(UNKNOWN_PATH);
    }
    // A link with an innocent name that leads to a secret is judged on its real path.
    expect(await read("sib/notes")).toBe(UNKNOWN_PATH);
    // The sibling's other files, and a name that only starts like a secret, stay readable.
    for (const name of ["activity.json", "crew-trust.json.bak"]) {
      const got = await read(`sib/collie-other/${name}`);
      if (got === UNKNOWN_PATH || !got.available) throw new Error(`${name} refused`);
    }
  });

  test("a folder read as a file, the root, and an absent file answer unknown-path", async () => {
    expect(await read("c")).toBe(UNKNOWN_PATH);
    expect(await read("")).toBe(UNKNOWN_PATH);
    expect(await read("nope.txt")).toBe(UNKNOWN_PATH);
  });

  test("a binary file carries no text", async () => {
    expect(await read("bin.dat")).toMatchObject({ binary: true, text: "", size: 5, truncated: false });
  });

  test("a file over the cap is cut, and the cut drops a split character", async () => {
    const dir = join(root, "big");
    mkdirSync(dir, { recursive: true });
    // One byte short of the cap, then a three-byte character: the cap falls inside it.
    write(join(dir, "big.txt"), `${"a".repeat(MAX_FILES_READ_BYTES - 1)}€tail`);
    const answer = await read("big/big.txt");
    if (answer === UNKNOWN_PATH || !answer.available) throw new Error("big file refused");
    expect(answer.truncated).toBe(true);
    expect(answer.size).toBe(MAX_FILES_READ_BYTES - 1 + 3 + 4);
    expect(answer.text.length).toBe(MAX_FILES_READ_BYTES - 1);
    expect(answer.text.endsWith("�")).toBe(false);
  });

  test("a FIFO is not a file, and the read does not hang on it", async () => {
    if (!POSIX) return; // Windows has no FIFO in the file system; the regular-file check is the same code.
    const fifo = join(root, "fifo");
    const made = Bun.spawnSync(["mkfifo", fifo]);
    if (made.exitCode !== 0) throw new Error("mkfifo failed");
    try {
      expect(await read("fifo")).toBe(UNKNOWN_PATH);
    } finally {
      rmSync(fifo, { force: true });
    }
  });
});

describe("decodeFileText: the binary sniff and the cut a listed file is read with", () => {
  test("a NUL in the first 8000 bytes is binary; past them it is text", () => {
    expect(decodeFileText(new Uint8Array([65, 0, 66]), false)).toEqual({ binary: true, text: "" });
    const late = new Uint8Array(8001).fill(65);
    late[8000] = 0;
    expect(decodeFileText(late, false).binary).toBe(false);
  });

  test("a cut answer holds back an incomplete character; a whole one replaces it", () => {
    const euroHead = new Uint8Array([0x61, 0xe2, 0x82]);
    expect(decodeFileText(euroHead, true).text).toBe("a");
    expect(decodeFileText(euroHead, false).text).toBe("a�");
  });
});

// ── Listings ──────────────────────────────────────────────────────────────────────────────────────

describe("list one folder", () => {
  test("list: folders first, then by name case-insensitive; .git and private folders hidden", async () => {
    const listing = await list("");
    if (listing === UNKNOWN_PATH || !listing.available) throw new Error("root listing refused");
    expect(listing.root).toBe(root);
    expect(listing.dir).toBe("");
    expect(listing.truncated).toBe(false);
    const got = names(listing);
    expect(got).not.toContain(".git");
    expect(got).not.toContain(".collie-state");
    expect(got).not.toContain("collie-config");
    // Folders first. `big` exists once the cap test has run; the order rule is the same either way.
    const kinds = listing.entries.map((e) => e.kind);
    const firstNonDir = kinds.findIndex((k) => k !== "dir");
    expect(kinds.slice(firstNonDir).includes("dir")).toBe(false);
    expect(got.slice(0, firstNonDir).filter((n) => n !== "big")).toEqual(["c", "sib", "sub"]);
    // `B.md` sorts between `a.txt` and `bin.dat`: case-insensitive.
    expect(got.indexOf("a.txt")).toBeLessThan(got.indexOf("B.md"));
    expect(got.indexOf("B.md")).toBeLessThan(got.indexOf("bin.dat"));
    // Dot-files are shown.
    expect(got).toContain(".env");
  });

  test("list: a sibling instance's state secrets are hidden; its other files and a link to one are listed", async () => {
    expect(names(await list("sib/collie-other"))).toEqual(["activity.json", "crew-trust.json.bak"]);
    // The link keeps its row, like a link into `.git`; reading it is refused above.
    expect(names(await list("sib"))).toEqual(["collie-other", "notes"]);
  });

  test("list: a symlink is a link row, never followed, and only files carry a size", async () => {
    const listing = await list("");
    if (listing === UNKNOWN_PATH || !listing.available) throw new Error("root listing refused");
    const byName = new Map(listing.entries.map((e) => [e.name, e]));
    for (const link of ["leak", "leakdir", "inside", "chain1", "loop", "tostate", "gitlink", "clink"]) {
      expect(byName.get(link)).toEqual({ name: link, kind: "link" });
    }
    expect(byName.get("a.txt")).toEqual({ name: "a.txt", kind: "file", size: 6 });
    expect(byName.get("c")).toEqual({ name: "c", kind: "dir" });
  });

  test("list: a subfolder, and a folder link that stays inside", async () => {
    expect(await list("c")).toEqual({
      available: true,
      root,
      dir: "c",
      entries: [
        { name: "deep", kind: "dir" },
        { name: "inner.txt", kind: "file", size: 6 },
      ],
      truncated: false,
    });
    expect(names(await list("clink"))).toEqual(["deep", "inner.txt"]);
    // A nested repo's `.git` is hidden too.
    expect(names(await list("sub"))).toEqual(["code.ts"]);
  });

  test("list: outside, denied, a file listed as a folder, and absent answer unknown-path", async () => {
    for (const bad of ["leakdir", "..", "../outside", ".git", "sub/.git", "tostate", ".collie-state", "collie-config", "a.txt", "nope", "loop"]) {
      expect(await list(bad)).toBe(UNKNOWN_PATH);
    }
  });

  test("list: a folder over the cap is cut and says truncated; hidden entries do not count", async () => {
    const dir = join(root, "many");
    mkdirSync(join(dir, ".git"), { recursive: true });
    for (let i = 0; i < MAX_FILES_ENTRIES + 5; i++) write(join(dir, `f${String(i).padStart(5, "0")}`), "");
    const cut = await list("many");
    if (cut === UNKNOWN_PATH || !cut.available) throw new Error("many refused");
    expect(cut.entries).toHaveLength(MAX_FILES_ENTRIES);
    expect(cut.truncated).toBe(true);
    expect(cut.entries.some((e) => e.name === ".git")).toBe(false);

    const exact = join(root, "exact");
    mkdirSync(join(exact, ".git"), { recursive: true });
    for (let i = 0; i < MAX_FILES_ENTRIES; i++) write(join(exact, `f${i}`), "");
    const whole = await list("exact");
    if (whole === UNKNOWN_PATH || !whole.available) throw new Error("exact refused");
    expect(whole.entries).toHaveLength(MAX_FILES_ENTRIES);
    expect(whole.truncated).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    rmSync(exact, { recursive: true, force: true });
  });

  test("list: the order is total and stable", () => {
    const rows: FileEntry[] = [
      { name: "b", kind: "file" },
      { name: "A", kind: "file" },
      { name: "a", kind: "file" },
      { name: "z", kind: "dir" },
      { name: "Y", kind: "dir" },
      { name: "l", kind: "link" },
    ];
    expect(rows.toSorted(compareEntries).map((r) => r.name)).toEqual(["Y", "z", "A", "a", "b", "l"]);
  });
});

// ── The root ──────────────────────────────────────────────────────────────────────────────────────

describe("the root", () => {
  test("a root that is a symlink to home, or to /, is no-folder; one to a folder inside the bound is fine", async () => {
    const links = join(home, "links");
    mkdirSync(links, { recursive: true });
    symlinkSync(home, join(links, "tohome"), "dir");
    symlinkSync(join(home, ".."), join(links, "above"), "dir");
    symlinkSync(root, join(links, "tows"), "dir");
    for (const bad of ["tohome", "above"]) {
      const c = { ...ctx, root: join(links, bad) };
      expect(await list("", c)).toEqual({ available: false, reason: "no-folder" });
      expect(await read("a.txt", c)).toEqual({ available: false, reason: "no-folder" });
    }
    if (POSIX) {
      symlinkSync("/", join(links, "slash"), "dir");
      expect(await list("", { ...ctx, root: join(links, "slash") })).toEqual({ available: false, reason: "no-folder" });
    }
    const viaLink = { ...ctx, root: join(links, "tows") };
    // The answer names the root as the snapshot spelled it; containment runs on its real path.
    expect(await read("a.txt", viaLink)).toMatchObject({ root: join(links, "tows"), text: "hello\n" });
    expect(await read("leak", viaLink)).toBe(UNKNOWN_PATH);
  });

  test("a missing, relative or home root is no-folder", async () => {
    for (const r of [join(home, "gone"), "relative/dir", "", home]) {
      expect(await list("", { ...ctx, root: r })).toEqual({ available: false, reason: "no-folder" });
    }
  });

  test("a root inside the state folder shows nothing", async () => {
    expect(await list("", { ...ctx, root: state })).toBe(UNKNOWN_PATH);
    expect(await read("paired-devices.json", { ...ctx, root: state })).toBe(UNKNOWN_PATH);
  });

  test("a private folder spelled in another case is still denied: the deny check folds case", async () => {
    // On a case-insensitive disk `.Collie-State` IS `.collie-state`. The deny check folds on every
    // host, so the spelling the bridge was configured with never decides.
    const c = { ...ctx, privateFolders: [join(root, ".COLLIE-STATE"), join(root, "Collie-Config")] };
    expect(names(await list("", c))).not.toContain(".collie-state");
    expect(await read("collie-config/.env", c)).toBe(UNKNOWN_PATH);
  });

  test("containedRealpath: a root of / contains every real path (it once compared against //)", async () => {
    expect(await containedRealpath(join(root, "a.txt"), POSIX ? "/" : base)).toBe(join(root, "a.txt"));
    expect(await containedRealpath(join(root, "leak"), root)).toBeNull();
  });
});

// ── The routes ────────────────────────────────────────────────────────────────────────────────────

function pane(paneId: string, workspaceId: string, cwd: string): AgentView {
  // SAFETY: the Files routes read `paneId`, `workspaceId` and `cwd` off a view and nothing else.
  return { paneId, workspaceId, cwd } as AgentView;
}

function space(workspaceId: string, label: string, folder?: string): WorkspaceView {
  const view: WorkspaceView = { workspaceId, number: 1, label, focused: false, activeTabId: "", tabCount: 1, paneCount: 1 };
  if (folder !== undefined) view.folder = folder;
  return view;
}

describe("GET /api/pane/:id/files and /api/workspace/:id/files", () => {
  let snap: RootSnapshot;
  const engine = { current: () => snap };
  const req = new Request("http://x/");
  const at = (q = "") => new URL(`http://x/api/x/files${q}`);
  const deny = (): string[] => [state, config];

  beforeAll(() => {
    snap = {
      agents: [pane("w1:p1", "w1", join(root, "c", "deep"))],
      shellPanes: [pane("w1:p2", "w1", join(root, "sub")), pane("w2:p1", "w2", home), pane("w3:p1", "w3", "")],
      workspaces: [space("w1", "ws"), space("w2", "home"), space("w3", "zellij")],
    };
  });

  test("both routes read the workspace root, and carry the Changes subject fields", async () => {
    const byPane = await paneFiles(engine, "w1:p1", at(), req, deny(), home);
    expect(byPane.status).toBe(200);
    expect(byPane.headers.get("content-type")).toContain("application/json");
    const body = await byPane.json();
    expect(body).toMatchObject({ paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "ws", available: true, root, dir: "" });
    const byWs = await (await workspaceFiles(engine, "w1", at(), req, deny(), home)).json();
    const { paneId: _paneId, ...rest } = body;
    expect(byWs).toEqual(rest);
    const file = await (await workspaceFiles(engine, "w1", at("?path=c%2Finner.txt"), req, deny(), home)).json();
    expect(file).toMatchObject({ workspaceId: "w1", available: true, path: "c/inner.txt", text: "inner\n" });
  });

  test("a refused path is 404 { error: unknown-path }, as JSON, on both routes", async () => {
    for (const q of ["?path=..%2F..%2Foutside%2Fsecret.txt", "?path=leak", "?dir=a.txt", "?path=.git%2Fconfig", "?path=%2Fetc%2Fpasswd"]) {
      for (const res of [
        await paneFiles(engine, "w1:p1", at(q), req, deny(), home),
        await workspaceFiles(engine, "w1", at(q), req, deny(), home),
      ]) {
        expect(res.status).toBe(404);
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(await res.json()).toEqual({ error: "unknown-path" });
      }
    }
  });

  test("a pane at home has no root: the fallback is bounded, so it is no-folder (unlike Changes)", async () => {
    expect(await (await paneFiles(engine, "w2:p1", at(), req, deny(), home)).json()).toEqual({
      paneId: "w2:p1",
      workspaceId: "w2",
      workspaceLabel: "home",
      available: false,
      reason: "no-folder",
    });
    expect(await (await workspaceFiles(engine, "w2", at(), req, deny(), home)).json()).toMatchObject({
      available: false,
      reason: "no-folder",
    });
  });

  test("a shell pane with no cwd (zellij) is no-folder; unknown ids are ordinary answers", async () => {
    expect(await (await paneFiles(engine, "w3:p1", at(), req, deny(), home)).json()).toMatchObject({ available: false, reason: "no-folder" });
    expect(await (await paneFiles(engine, "nope", at(), req, deny(), home)).json()).toEqual({
      paneId: "nope",
      available: false,
      reason: "no-pane",
    });
    expect(await (await workspaceFiles(engine, "nope", at(), req, deny(), home)).json()).toEqual({
      workspaceId: "nope",
      available: false,
      reason: "no-workspace",
    });
  });

  test("works with no git repository, for a shell pane", async () => {
    const plain = join(home, "plain");
    mkdirSync(plain, { recursive: true });
    write(join(plain, "notes.txt"), "no repo here\n");
    const s = { current: (): RootSnapshot => ({ agents: [], shellPanes: [pane("w9:p1", "w9", plain)], workspaces: [space("w9", "plain")] }) };
    expect(await (await paneFiles(s, "w9:p1", at("?path=notes.txt"), req, deny(), home)).json()).toMatchObject({
      available: true,
      text: "no repo here\n",
    });
  });

  test("the private folders are the state folder and the config folder", () => {
    expect(filesPrivateFolders({ stateDir: "/s/collie", commandsFile: "/c/collie/commands.toml" })).toEqual(["/s/collie", "/c/collie"]);
  });
});

// ── Which paths exist (ADR 0088) ──────────────────────────────────────────────────────────────────

describe("existingPaths: one lstat per path, under the same checks as a read", () => {
  test("a mixed batch answers the files and folders that are there, in the order asked, once each", async () => {
    const got = await existingPaths(ctx, ["a.txt", "nope.md", "c", "c/inner.txt", "a.txt", "sub/code.ts", "c/deep", "inside", "clink/inner.txt"]);
    expect(got).toEqual(["a.txt", "c", "c/inner.txt", "sub/code.ts", "c/deep", "inside", "clink/inner.txt"]);
  });

  test("traversal, an absolute path, an empty or dot segment and the root itself are absent", async () => {
    const asked = ["../outside/secret.txt", "c/../a.txt", "./a.txt", "/etc/passwd", `${root}/a.txt`, "", "c//inner.txt", "a.txt\0"];
    expect(await existingPaths(ctx, asked)).toEqual([]);
  });

  test("a symlink that escapes the root is absent, as a file, a folder, a chain or a loop", async () => {
    expect(await existingPaths(ctx, ["leak", "leakdir", "leakdir/secret.txt", "chain1", "chain2", "loop"])).toEqual([]);
  });

  test("the deny rules answer absent: .git, the private folders, and a state secret's basename", async () => {
    const asked = [
      ".git",
      ".git/config",
      ".GIT/config",
      "gitlink",
      ".collie-state",
      ".collie-state/paired-devices.json",
      "collie-config/.env",
      "tostate/paired-devices.json",
      "sib/collie-other/crew-trust.json",
      "sib/collie-other/PAIRED-DEVICES.json",
      "sib/notes",
    ];
    expect(await existingPaths(ctx, asked)).toEqual([]);
    // A sibling's other files are ordinary files.
    expect(await existingPaths(ctx, ["sib/collie-other/activity.json"])).toEqual(["sib/collie-other/activity.json"]);
  });

  test("nothing is opened: the check never calls readHead", async () => {
    let reads = 0;
    const fs = { ...NODE_FILES_FS, readHead: async () => (reads++, null) };
    expect(await existingPaths({ ...ctx, fs }, ["a.txt", "B.md"])).toEqual(["a.txt", "B.md"]);
    expect(reads).toBe(0);
  });

  test.if(POSIX)("a FIFO is neither a file nor a folder: absent", async () => {
    const fifo = join(root, "exist.fifo");
    Bun.spawnSync(["mkfifo", fifo]);
    try {
      expect(await existingPaths(ctx, ["exist.fifo"])).toEqual([]);
    } finally {
      rmSync(fifo, { force: true });
    }
  });

  test("a root that is not narrow enough answers nothing", async () => {
    expect(await existingPaths({ ...ctx, root: home }, ["projects"])).toEqual([]);
  });
});

describe("POST /api/pane/:id/files/exist and /api/workspace/:id/files/exist", () => {
  let snap: RootSnapshot;
  const engine = { current: () => snap };
  const deny = (): string[] => [state, config];
  const post = (body: string) => new Request("http://x/", { method: "POST", body, headers: { "content-type": "application/json" } });
  const ask = (paths: unknown[]) => post(JSON.stringify({ paths }));

  beforeAll(() => {
    snap = {
      agents: [pane("w1:p1", "w1", join(root, "c", "deep"))],
      shellPanes: [pane("w1:p2", "w1", join(root, "sub")), pane("w2:p1", "w2", home)],
      workspaces: [space("w1", "ws"), space("w2", "home")],
    };
  });

  test("both routes answer { exists } over the workspace root, with a mixed batch", async () => {
    const paths = ["a.txt", "missing.md", "../outside/secret.txt", "leak", ".git/config", "c/inner.txt", "c"];
    for (const subject of [{ kind: "pane", paneId: "w1:p1" }, { kind: "workspace", workspaceId: "w1" }] as const) {
      const res = await filesExist(engine, subject, ask(paths), deny(), home);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ exists: ["a.txt", "c/inner.txt", "c"] });
    }
  });

  test("an entry that is not a string is absent, never a refusal of the batch", async () => {
    const res = await filesExist(engine, { kind: "pane", paneId: "w1:p1" }, ask(["a.txt", 7, null, { p: 1 }, ["B.md"]]), deny(), home);
    expect(await res.json()).toEqual({ exists: ["a.txt"] });
  });

  test("64 paths is the cap: 64 are answered, 65 is a 400", async () => {
    const full = Array.from({ length: MAX_EXIST_PATHS }, (_, i) => (i === 0 ? "a.txt" : `none-${i}.md`));
    expect(MAX_EXIST_PATHS).toBe(64);
    expect(await (await filesExist(engine, { kind: "pane", paneId: "w1:p1" }, ask(full), deny(), home)).json()).toEqual({ exists: ["a.txt"] });
    const over = await filesExist(engine, { kind: "pane", paneId: "w1:p1" }, ask([...full, "B.md"]), deny(), home);
    expect(over.status).toBe(400);
  });

  test("a body of the wrong shape is a 400", async () => {
    for (const body of ["", "not json", "[]", "null", '{"paths":"a.txt"}', '{"path":["a.txt"]}']) {
      expect((await filesExist(engine, { kind: "pane", paneId: "w1:p1" }, post(body), deny(), home)).status).toBe(400);
    }
    expect(parseFilesExistBody({ paths: ["a", 1, "b"] })).toEqual(["a", "b"]);
  });

  test("no root, no pane and no workspace all answer an empty list", async () => {
    for (const subject of [
      { kind: "pane", paneId: "w2:p1" },
      { kind: "workspace", workspaceId: "w2" },
      { kind: "pane", paneId: "nope" },
      { kind: "workspace", workspaceId: "nope" },
    ] as const) {
      expect(await (await filesExist(engine, subject, ask(["projects", "a.txt"]), deny(), home)).json()).toEqual({ exists: [] });
    }
  });
});

// ── The gate ──────────────────────────────────────────────────────────────────────────────────────

describe("the gate: files is a read that needs an authorised device", () => {
  test("the pane route asks device-read for files, read for the other reads, write for the rest", () => {
    expect(paneGateLevel("files")).toBe("device-read");
    for (const action of [undefined, "history", "chat", "changes"]) expect(paneGateLevel(action)).toBe("read");
    for (const action of ["reply", "keys", "upload", "close", "rename", "focus"]) expect(paneGateLevel(action)).toBe("write");
  });

  test("on a crew member, device-read is decided by the member's own device policy, as a write is", () => {
    const on = { deviceHeader: "x-device-id", deviceAllowlist: ["phone"] };
    expect(crewGate("device-read", on, "phone")).toEqual({ ok: true });
    expect(crewGate("device-read", on, "tablet").ok).toBe(false);
    expect(crewGate("device-read", on, null).ok).toBe(false);
    expect(crewGate("read", on, "tablet")).toEqual({ ok: true });
    expect(crewGate("device-read", { deviceHeader: "", deviceAllowlist: [] }, null)).toEqual({ ok: true });
  });
});

// ── Ignored entries: one `git check-ignore` per listing (ADR 0083) ──────────────────────────────
// Real git in throwaway folders, as bridge/changes.test.ts does: the module's job is how it drives
// git, and a fake would test the fake.

describe("list: entries git ignores carry ignored: true", () => {
  let ibase: string;
  let ihome: string;
  let repoRoot: string;
  let plainRoot: string;

  /** Plain git for building fixtures. The listing under test uses the hardened runner instead. */
  function git(cwd: string, ...args: string[]): void {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
    }
    const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  }

  function put(path: string, body = "x\n"): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }

  const ictx = (r: string): FilesContext => ({ root: r, home: ihome, privateFolders: [] });
  const flags = (listing: FilesListing | typeof UNKNOWN_PATH): Record<string, true | undefined> => {
    if (listing === UNKNOWN_PATH || !listing.available) throw new Error("no listing");
    return Object.fromEntries(listing.entries.map((e) => [e.name, e.ignored]));
  };

  beforeAll(() => {
    ibase = realpathSync.native(mkdtempSync(join(tmpdir(), "collie-files-ignored-")));
    ihome = join(ibase, "home");
    repoRoot = join(ihome, "ws");
    plainRoot = join(ihome, "plain");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(plainRoot, { recursive: true });
    git(repoRoot, "init", "-q");
    put(
      join(repoRoot, ".gitignore"),
      ["node_modules/", "build/", "*.log", "!keep.log", "tracked.txt", "-dash*", "*.tmp", "vendor-clone/", ""].join("\n"),
    );
    put(join(repoRoot, "src", "main.ts"));
    put(join(repoRoot, "node_modules", "pkg", "index.js"));
    put(join(repoRoot, "build", "out.js"));
    put(join(repoRoot, "debug.log"));
    put(join(repoRoot, "keep.log"));
    put(join(repoRoot, "tracked.txt"));
    put(join(repoRoot, "readme.md"));
    // `build` is also the name of a FILE elsewhere: a directory-only rule must not hit it.
    put(join(repoRoot, "docs", "build"));
    git(repoRoot, "add", "-f", "tracked.txt");
    git(repoRoot, "add", ".gitignore", "src", "readme.md");
    git(repoRoot, "commit", "-q", "-m", "init");
    if (POSIX) {
      // A folder link named for an ignored folder: git treats a link as a file, so `build/` skips it.
      symlinkSync("build", join(repoRoot, "blink"), "dir");
      put(join(repoRoot, "-dash.txt"));
      put(join(repoRoot, "line\nbreak.tmp"));
      // Pathspec magic spelled as names: each is one literal file.
      put(join(repoRoot, ":(top)magic.tmp"));
      put(join(repoRoot, ":!bang.tmp"));
      put(join(repoRoot, ":plain"));
    }
    put(join(plainRoot, "a.log"));

    // A nested clone: the outer repo ignores the folder, the inner repo has its own rules.
    const inner = join(repoRoot, "vendor-clone");
    mkdirSync(inner, { recursive: true });
    git(inner, "init", "-q");
    put(join(inner, ".gitignore"), "*.cache\n");
    put(join(inner, "x.cache"));
    put(join(inner, "x.log"));
    put(join(inner, "code.ts"));
  });

  afterAll(() => rmSync(ibase, { recursive: true, force: true }));

  test("a file rule, a directory rule, a negation and a tracked file that matches a rule", async () => {
    const got = flags(await list("", ictx(repoRoot)));
    expect(got["debug.log"]).toBe(true); // file rule
    expect(got["node_modules"]).toBe(true); // directory rule, applied to a directory
    expect(got["build"]).toBe(true);
    expect(got["vendor-clone"]).toBe(true);
    expect(got["keep.log"]).toBeUndefined(); // negation
    expect(got["tracked.txt"]).toBeUndefined(); // tracked wins over the rule: no --no-index
    expect(got["src"]).toBeUndefined();
    expect(got["readme.md"]).toBeUndefined();
    expect(got[".gitignore"]).toBeUndefined();
  });

  test("a directory-only rule does not hit a file of that name, and a link is never ignored by it", async () => {
    expect(flags(await list("docs", ictx(repoRoot)))["build"]).toBeUndefined();
    if (POSIX) expect(flags(await list("", ictx(repoRoot)))["blink"]).toBeUndefined();
  });

  test("a listing inside an ignored folder is ignored whole, however deep", async () => {
    expect(flags(await list("node_modules", ictx(repoRoot)))).toEqual({ pkg: true });
    expect(flags(await list("node_modules/pkg", ictx(repoRoot)))).toEqual({ "index.js": true });
    expect(flags(await list("build", ictx(repoRoot)))).toEqual({ "out.js": true });
  });

  test("a folder git does not ignore carries no flag at all", async () => {
    const listing = await list("src", ictx(repoRoot));
    expect(names(listing)).toEqual(["main.ts"]);
    expect(JSON.stringify(listing)).not.toContain(`"ignored"`);
  });

  test("names travel on stdin: a leading dash, a newline and pathspec magic are one literal path each", async () => {
    if (!POSIX) return;
    const got = flags(await list("", ictx(repoRoot)));
    expect(got["-dash.txt"]).toBe(true);
    expect(got["line\nbreak.tmp"]).toBe(true);
    expect(got[":(top)magic.tmp"]).toBe(true);
    expect(got[":!bang.tmp"]).toBe(true);
    expect(got[":plain"]).toBeUndefined();
  });

  test("a nested repository answers by its own rules, not the outer one's", async () => {
    const got = flags(await list("vendor-clone", ictx(repoRoot)));
    expect(got["x.cache"]).toBe(true);
    expect(got["x.log"]).toBeUndefined(); // the outer `*.log` does not apply inside another repo
    expect(got["code.ts"]).toBeUndefined();
  });

  test("no repository: the listing answers, with no flags", async () => {
    const listing = await list("", ictx(plainRoot));
    expect(names(listing)).toEqual(["a.log"]);
    expect(JSON.stringify(listing)).not.toContain(`"ignored"`);
  });

  test("a probe that answers null, throws or finds nothing leaves the listing whole", async () => {
    for (const ignoreProbe of [
      async () => null,
      async (): Promise<null> => {
        throw new Error("git is gone");
      },
      async () => new Set<string>(),
    ]) {
      const listing = await list("", { ...ictx(repoRoot), ignoreProbe });
      expect(names(listing)).toContain("debug.log");
      expect(JSON.stringify(listing)).not.toContain(`"ignored"`);
    }
  });

  test("the probe is asked once per listing, with the kept entries, after the deny filter", async () => {
    const asked: string[][] = [];
    const ignoreProbe = async (_dir: string, entries: readonly FileEntry[]) => {
      asked.push(entries.map((e) => e.name));
      return new Set(["readme.md"]);
    };
    const listing = await list("", { ...ictx(repoRoot), ignoreProbe });
    expect(asked.length).toBe(1);
    expect(asked[0]).not.toContain(".git");
    expect(flags(listing)["readme.md"]).toBe(true);
    expect(flags(listing)["src"]).toBeUndefined();
  });

  test("a git run past its timeout is no answer; the read of an ignored file is unchanged", async () => {
    const entries: FileEntry[] = [{ name: "debug.log", kind: "file", size: 2 }];
    if (POSIX) {
      // A "git" that never answers: the run is killed at the timeout and the listing gets no flags.
      const slow = join(ibase, "slow-git");
      writeFileSync(slow, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
      const started = Date.now();
      expect(await gitIgnoredNames(repoRoot, entries, { git: slow, timeoutMs: 150 })).toBeNull();
      expect(Date.now() - started).toBeLessThan(5000);
      // A "git" that fails: exit 128 is no answer either.
      const broken = join(ibase, "broken-git");
      writeFileSync(broken, "#!/bin/sh\ncat >/dev/null\nexit 128\n", { mode: 0o755 });
      expect(await gitIgnoredNames(repoRoot, entries, { git: broken })).toBeNull();
      // A "git" that records its argv: one run, and no file name in it.
      const real = Bun.which("git");
      if (real === null) throw new Error("git is needed for this test");
      const log = join(ibase, "argv.log");
      const spy = join(ibase, "spy-git");
      writeFileSync(spy, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
      const found = await gitIgnoredNames(repoRoot, entries, { git: spy });
      expect([...(found ?? [])]).toEqual(["debug.log"]);
      const argv = readFileSync(log, "utf8");
      expect(argv).toContain("check-ignore");
      expect(argv).not.toContain("debug.log");
      expect(argv.split("\n").filter((l) => l === "check-ignore").length).toBe(1);
    }
    expect([...((await gitIgnoredNames(repoRoot, entries)) ?? [])]).toEqual(["debug.log"]);
    expect(await gitIgnoredNames(plainRoot, entries)).toBeNull();
    expect(await gitIgnoredNames(join(ibase, "absent"), entries)).toBeNull();
    // A view filter, not a gate.
    const answer = await readFile(ictx(repoRoot), "debug.log");
    if (answer === UNKNOWN_PATH || !answer.available) throw new Error("an ignored file must still read");
    expect(answer.text).toBe("x\n");
  });
});

// A file body is file content, and the Files view opens `.env` files on request. The mirror's mask
// (bridge/redact.ts) runs on every body the Files routes serve, gated by `cfg.redact` as the mirror
// is. Placeholder secrets only.
describe("Files view bodies are masked like the mirror", () => {
  let maskBase: string;
  let maskHome: string;
  let app: string;
  let snap: RootSnapshot;
  const engine = { current: () => snap };
  const req = new Request("http://x/");
  const at = (q = "") => new URL(`http://x/api/x/files${q}`);
  const BODY = "NAME=collie\npassword=placeholder1234\nAuthorization: Bearer placeholderplaceholder0000\n";

  beforeAll(() => {
    maskBase = realpathSync.native(mkdtempSync(join(tmpdir(), "collie-files-mask-")));
    maskHome = join(maskBase, "home");
    app = join(maskHome, "projects", "app");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "settings.env"), BODY);
    snap = {
      agents: [pane("w1:p1", "w1", app)],
      shellPanes: [],
      workspaces: [space("w1", "app", app)],
    };
  });
  afterAll(() => rmSync(maskBase, { recursive: true, force: true }));

  test("a file read hides the values, keeps the names, and keeps every line and column", async () => {
    for (const res of [
      await workspaceFiles(engine, "w1", at("?path=settings.env"), req, [], maskHome, true),
      await paneFiles(engine, "w1:p1", at("?path=settings.env"), req, [], maskHome, true),
    ]) {
      const body = await res.json();
      expect(body.available).toBe(true);
      expect(body.text).not.toContain("placeholder1234");
      expect(body.text).not.toContain("placeholderplaceholder0000");
      expect(body.text).toContain("NAME=collie\npassword=•");
      expect(body.text.split("\n").map((l: string) => l.length)).toEqual(BODY.split("\n").map((l) => l.length));
    }
  });

  test("COLLIE_REDACT=off serves the body as it is on disk", async () => {
    const body = await (await workspaceFiles(engine, "w1", at("?path=settings.env"), req, [], maskHome, false)).json();
    expect(body.text).toBe(BODY);
  });

  test("a listing is names only, and is answered as before", async () => {
    const masked = await (await workspaceFiles(engine, "w1", at(), req, [], maskHome, true)).json();
    const plain = await (await workspaceFiles(engine, "w1", at(), req, [], maskHome, false)).json();
    expect(masked).toEqual(plain);
    expect(masked.entries.map((e: { name: string }) => e.name)).toEqual(["settings.env"]);
  });
});
