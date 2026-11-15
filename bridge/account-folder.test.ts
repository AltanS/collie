import { describe, expect, test } from "bun:test";

import { ACCOUNT_ADAPTERS } from "./account-adapters.ts";
import { accountTest } from "./accounts-skip.ts";
import {
  accountStartLine,
  checkFolder,
  checkLabel,
  displayFolder,
  displayStartLine,
  parseFolderPath,
  labelSlug,
  MAX_FOLDER_CHARS,
  quoteFolder,
  sameLabel,
  type FolderLook,
} from "./account-folder.ts";

const HOME = "/home/op";

describe("parseFolderPath: the hostile inputs", () => {
  const refused: [string, string][] = [
    ["a single quote", "/home/op/.claude-it's"],
    ["a double quote", '/home/op/.claude-"x"'],
    ["a backslash", "/home/op/.claude\\x"],
    ["a backtick", "/home/op/.claude-`id`"],
    ["a command substitution", "/home/op/.claude-$(id)"],
    ["a variable", "/home/op/$HOME"],
    ["a newline", "/home/op/.claude-a\nrm -rf ~"],
    ["a carriage return", "/home/op/.claude-a\r"],
    ["a tab", "/home/op/.claude\t-a"],
    ["a NUL", "/home/op/.claude\u0000a"],
    ["an escape", "/home/op/.claude\u001b[2J"],
    ["DEL", "/home/op/.claude\u007f"],
    ["a C1 control", "/home/op/.claude\u0085"],
    ["a bidi override", "/home/op/.claude‮"],
    ["a line separator", "/home/op/.claude "],
    ["a trailing space", "/home/op/.claude-work "],
    ["a leading space", " /home/op/.claude-work"],
    ["a relative path", ".claude-work"],
    ["a dot path", "./.claude-work"],
    ["another user's home", "~root/.claude"],
    ["a ~user path", "~op"],
    ["a dotdot segment", "/home/op/../root/.claude"],
    ["a 5000-character path", `/home/op/${"a".repeat(5000)}`],
    ["one over the cap", `/home/op/${"a".repeat(MAX_FOLDER_CHARS)}`],
    ["the empty string", ""],
    ["home itself", "~"],
    ["home itself, spelled out", "/home/op/"],
  ];
  for (const [what, raw] of refused) {
    test(`refuses ${what}`, () => {
      expect(parseFolderPath(raw, HOME).ok).toBe(false);
    });
  }

  accountTest("takes ~/x and an absolute path, and cleans both to one spelling", () => {
    expect(parseFolderPath("~/.claude-work", HOME)).toEqual({ ok: true, dir: "/home/op/.claude-work" });
    expect(parseFolderPath("/home/op/.claude-work/", HOME)).toEqual({ ok: true, dir: "/home/op/.claude-work" });
    expect(parseFolderPath("/home/op/./.claude-work", HOME)).toEqual({ ok: true, dir: "/home/op/.claude-work" });
    expect(parseFolderPath("/srv/claude one", HOME)).toEqual({ ok: true, dir: "/srv/claude one" });
  });

  accountTest("the typed line quotes the folder, and a passed folder can never close the quote", () => {
    const parsed = parseFolderPath("~/my work", HOME);
    if (!parsed.ok) throw new Error("expected ok");
    expect(accountStartLine(ACCOUNT_ADAPTERS.claude, parsed.dir, "claude")).toBe("CLAUDE_CONFIG_DIR='/home/op/my work' claude");
    expect(quoteFolder(parsed.dir).slice(1, -1)).not.toContain("'");
  });

  test("quoting throws on a folder that holds a ', whoever passed it", () => {
    expect(() => quoteFolder("/home/op/it's")).toThrow();
    expect(() => accountStartLine(ACCOUNT_ADAPTERS.claude, "/home/op/x' ; rm -rf ~ ; '", "claude")).toThrow();
    expect(quoteFolder("/home/op/plain")).toBe("'/home/op/plain'");
  });
});

/** A disk with the named paths present; realpath is the identity unless `links` says otherwise. */
function look(present: string[], links: Record<string, string> = {}): FolderLook {
  return {
    exists: (p) => Promise.resolve(present.includes(p)),
    realpath: (p) => Promise.resolve(present.includes(p) ? (links[p] ?? p) : null),
  };
}

describe("checkFolder", () => {
  const none: string[] = [];
  const base = { home: HOME, defaultDir: "/home/op/.claude", taken: none };

  accountTest("a missing folder under home is fine, and is to be made", async () => {
    expect(await checkFolder({ ...base, raw: "~/.claude-work", look: look(["/home/op/.claude"]) })).toEqual({ ok: true, dir: "/home/op/.claude-work", exists: false });
  });

  accountTest("a missing folder outside home is refused, an existing one outside home is taken", async () => {
    expect(await checkFolder({ ...base, raw: "/srv/new", look: look([]) })).toMatchObject({ ok: false, code: "accounts.bad_folder" });
    expect(await checkFolder({ ...base, raw: "/srv/old", look: look(["/srv/old"]) })).toEqual({ ok: true, dir: "/srv/old", exists: true });
  });

  accountTest("the default folder is refused, also through a link", async () => {
    expect(await checkFolder({ ...base, raw: "~/.claude", look: look(["/home/op/.claude"]) })).toMatchObject({ problem: "the agent's default folder" });
    const linked = look(["/home/op/.claude", "/home/op/alias"], { "/home/op/alias": "/home/op/.claude" });
    expect(await checkFolder({ ...base, raw: "~/alias", look: linked })).toMatchObject({ problem: "the agent's default folder" });
  });

  accountTest("a folder another account holds is taken, by spelling and by real path", async () => {
    expect(await checkFolder({ ...base, taken: ["/home/op/.claude-a"], raw: "~/.claude-a/", look: look([]) })).toEqual({ ok: false, code: "accounts.folder_taken" });
    const linked = look(["/home/op/.claude-a", "/home/op/b"], { "/home/op/b": "/home/op/.claude-a" });
    expect(await checkFolder({ ...base, taken: ["/home/op/.claude-a"], raw: "~/b", look: linked })).toEqual({ ok: false, code: "accounts.folder_taken" });
  });
});

describe("the label", () => {
  test("1 to 24 characters after trim, with a slug", () => {
    expect(checkLabel("  Work  ")).toEqual({ ok: true, label: "Work", slug: "work" });
    expect(checkLabel("My Team 2")).toEqual({ ok: true, label: "My Team 2", slug: "my-team-2" });
    expect(checkLabel("a".repeat(24)).ok).toBe(true);
    expect(checkLabel("a".repeat(25)).ok).toBe(false);
    expect(checkLabel("   ").ok).toBe(false);
    expect(checkLabel("").ok).toBe(false);
  });

  test("a control character, a newline or a bidi mark is refused, and an empty slug too", () => {
    expect(checkLabel("Work\n").ok).toBe(false);
    expect(checkLabel("Wo\u001brk").ok).toBe(false);
    expect(checkLabel("Work‮").ok).toBe(false);
    expect(checkLabel("äöü").ok).toBe(false);
    expect(checkLabel("!!!").ok).toBe(false);
  });

  test("the slug keeps only a-z, 0-9 and single dashes", () => {
    expect(labelSlug("Work -- Client's  Box!")).toBe("work-clients-box");
    expect(labelSlug("$(id)")).toBe("id");
  });

  test("labels collide without case", () => {
    expect(sameLabel("Work", "wORK")).toBe(true);
    expect(sameLabel("Work", "Work 2")).toBe(false);
  });
});

describe("what the page shows", () => {
  test("a folder under home reads with ~, and the desktop line uses it only when it pastes as it reads", () => {
    expect(displayFolder("/home/op/.claude-work", HOME)).toBe("~/.claude-work");
    expect(displayFolder("/srv/x", HOME)).toBe("/srv/x");
    expect(displayStartLine(ACCOUNT_ADAPTERS.claude, "/home/op/.claude-work", "claude", HOME)).toBe("CLAUDE_CONFIG_DIR=~/.claude-work claude");
    expect(displayStartLine(ACCOUNT_ADAPTERS.claude, "/home/op/my work", "claude", HOME)).toBe("CLAUDE_CONFIG_DIR='/home/op/my work' claude");
    expect(displayStartLine(ACCOUNT_ADAPTERS.codex, "/srv/codex", "codex", HOME)).toBe("CODEX_HOME='/srv/codex' codex");
  });
});
