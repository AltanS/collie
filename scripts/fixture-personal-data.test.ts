// Recorded screens are real screens, and a real screen can show who was logged in: the first name in
// Claude Code's "Welcome back <name>!" banner, or the account address on its status screens. This
// test keeps a person's data out of the fixtures. It holds no personal value: it checks the SHAPE,
// against an allow list of public and reserved names, and it names a file and a line, never the text.
//
// Scope: every tracked file under `web/src/fixtures/`, and every tracked file under `bridge/` whose
// path has a folder or file name that holds `fixtures`.
//
// (a) An email address must have a domain from ALLOWED_DOMAINS, or a reserved top level (RFC 2606
//     and RFC 6761: test, invalid, example, localhost).
// (b) A "Welcome back <word>!" banner must carry a name from NEUTRAL_NAMES. The bare "Welcome back!"
//     is fine.
//
// (c) The user segment of a home path (`/home/<x>/`, `/var/home/<x>/`, the flattened `-home-<x>-`),
//     the user of a shell prompt (`<x>@host:`), the user of a starship prompt (`<x> in 🌐`) and the
//     user folder of a Windows path (`X:\Users\<x>`, `X:\_ext\<x>`) must come from NEUTRAL_USERS.
//     This holds for the names of other people as well: a contributor's user name in a captured path
//     is personal data and is not ours to keep.
//
// A new fixture with a real address or a real name fails here: replace the value with a neutral one of
// the same length (the screens are character grids), or add a domain to ALLOWED_DOMAINS with a reason
// a reviewer accepts. Recordings under `web/e2e/rig/cassettes*/` are out of scope: their text is part
// of a replay key and `neutral-names.test.ts` and `replay/check.ts` own them.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

// A domain matches itself and every subdomain of it. Each entry is public or reserved, with its reason.
export const ALLOWED_DOMAINS = {
  "anthropic.com": "the vendor; noreply@ in a captured co-author line",
  "b.com": "a placeholder a test typed into a feedback box",
  "example.com": "reserved by RFC 2606",
  "example.net": "reserved by RFC 2606",
  "example.org": "reserved by RFC 2606; the neutral account address of the Claude status screens",
  "exampleco.dev": "an invented company in a lab capture",
  "github.com": "public; the ssh clone address of a repository",
  "paragraph.the": "prose in a captured screen, not an address",
} satisfies Record<string, string>;

// Top levels that can never belong to a person (RFC 2606, RFC 6761).
const RESERVED_TLDS = new Set(["example", "invalid", "localhost", "test"]);

export const NEUTRAL_NAMES: readonly string[] = ["alex", "charlie", "jordan", "robin", "sam"];

// Users of home paths and prompts that carry no person. Each entry says why it is neutral.
export const NEUTRAL_USERS = {
  a: "a one-letter placeholder",
  ada: "an invented name in a bridge test world",
  alice: "an invented name",
  casey: "the neutral name that replaced a contributor's user name",
  "collie-user": "the product's own demo account",
  demo: "a demo account",
  dev: "the neutral developer account",
  devel: "a short developer account",
  lab01: "a lab machine account",
  labuser: "a lab machine account",
  linuxbrew: "Homebrew's own account on Linux",
  m: "a path split across two JSON strings: the user is an invented name",
  operator: "a role name",
  operator1: "a role name",
  ops: "a role name",
  robin: "the neutral name that replaced the account owner's",
  robins: "`robin` plus the trailing S of the folder name in a Windows path",
  sam: "an invented name",
  someuse: "a clipped `someuser` in a narrow capture",
  someuser: "a placeholder",
  tester: "a role name",
  user: "a placeholder",
  user0: "a placeholder",
  x: "a one-letter placeholder",
  xuser: "a placeholder",
  you: "a placeholder",
} satisfies Record<string, string>;

const ESC = "\u001b";
const HOME_PATH = /\/(?:var\/)?home\/([A-Za-z0-9_][A-Za-z0-9._-]*)/g;
const FLAT_PATH = /-home-([A-Za-z0-9_.]+)-/g;
const SHELL_PROMPT = /([A-Za-z0-9._-]+)@[A-Za-z0-9-]+(?::|\s+[~/])/g;
const STARSHIP_PROMPT = new RegExp(`([A-Za-z0-9_-]+)(?:${ESC}\\[[0-9;]*m)* in (?:${ESC}\\[[0-9;]*m)*🌐`, "g");
const WINDOWS_PATH = new RegExp(`[A-Za-z]:[\\\\/]{1,2}(?:Users|_ext)[\\\\/]{1,2}([^\\\\/\\s"'${ESC}]+)`, "g");
const USER_FORMS: readonly RegExp[] = [HOME_PATH, FLAT_PATH, SHELL_PROMPT, STARSHIP_PROMPT, WINDOWS_PATH];

const ADDRESS = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;
const BANNER = /Welcome back +([A-Za-z]+)!/g;

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

export function domainAllowed(domain: string): boolean {
  const host = domain.toLowerCase();
  const tld = host.slice(host.lastIndexOf(".") + 1);
  if (RESERVED_TLDS.has(tld)) return true;
  return Object.keys(ALLOWED_DOMAINS).some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** Line numbers of every address whose domain is not allowed. The address itself is never returned. */
export function foreignAddressLines(text: string): number[] {
  const lines: number[] = [];
  for (const match of text.matchAll(ADDRESS)) {
    if (domainAllowed(match[1] ?? "")) continue;
    lines.push(lineOf(text, match.index));
  }
  return lines;
}

/** Line numbers of every named banner whose name is not neutral. The name itself is never returned. */
export function foreignBannerLines(text: string): number[] {
  const lines: number[] = [];
  for (const match of text.matchAll(BANNER)) {
    if (NEUTRAL_NAMES.includes((match[1] ?? "").toLowerCase())) continue;
    lines.push(lineOf(text, match.index));
  }
  return lines;
}

export function userNeutral(user: string): boolean {
  return Object.hasOwn(NEUTRAL_USERS, user.toLowerCase());
}

/** Line numbers of every home path or prompt whose user is not neutral. The user is never returned. */
export function foreignUserLines(text: string): number[] {
  const lines: number[] = [];
  for (const form of USER_FORMS) {
    for (const match of text.matchAll(form)) {
      if (userNeutral(match[1] ?? "")) continue;
      lines.push(lineOf(text, match.index));
    }
  }
  return lines.toSorted((a, b) => a - b);
}

export function inScope(file: string): boolean {
  if (file.startsWith("web/src/fixtures/")) return true;
  return file.startsWith("bridge/") && file.split("/").some((part) => part.includes("fixtures"));
}

function inGit(): boolean {
  try {
    return execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
  } catch {
    return false;
  }
}

function fixtureFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter((file) => file !== "" && inScope(file));
}

/** Every offence of the two rules in a tree, as `file:line (rule)`. `read` returns a file's text. */
export function offences(files: readonly string[], read: (file: string) => string): string[] {
  const found: string[] = [];
  for (const file of files) {
    const text = read(file);
    for (const line of foreignAddressLines(text)) found.push(`${file}:${line} (address with a domain that is not allowed)`);
    for (const line of foreignBannerLines(text)) found.push(`${file}:${line} (banner name is not neutral)`);
    for (const line of foreignUserLines(text)) found.push(`${file}:${line} (user of a path or prompt is not neutral)`);
  }
  return found;
}

describe.skipIf(!inGit())("personal data in fixtures", () => {
  test("every address in a fixture has an allowed domain and every banner a neutral name", () => {
    const files = fixtureFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(offences(files, (file) => readFileSync(resolve(ROOT, file), "latin1"))).toEqual([]);
  });
});

describe("the checks themselves", () => {
  test("a home path, a flattened path and a prompt with a user outside the neutral list fail, by line", () => {
    const text = ["ok /home/dev/x", "bad /var/home/zed/x", "-var-home-zed-proj", "zed@box:~$", "\u001b[1mzed\u001b[0m in \u001b[2m🌐 host", "dev@box:~$ and pkg@latest"].join("\n");
    expect(foreignUserLines(text)).toEqual([2, 3, 4, 5]);
  });

  test("a Windows user folder outside the neutral list fails, a neutral one passes", () => {
    expect(foreignUserLines("C:\\Users\\zed\\x\nD:\\\\_ext\\\\zed\\\\x\nC:/Users/zed/y\nC:\\Users\\dev\\z")).toEqual([1, 2, 3]);
  });

  test("a neutral user and a dot folder pass, case does not matter", () => {
    expect(foreignUserLines("/home/Robin/x\n/home/.cache/y\n-home-you-p\nUSER@box:~")).toEqual([]);
  });

  test("an address with a company domain fails, by line and not by value", () => {
    const text = "one\ntwo someone@acme-widgets.de's Organization\nthree";
    expect(foreignAddressLines(text)).toEqual([2]);
    expect(offences(["f.txt"], () => text)).toEqual(["f.txt:2 (address with a domain that is not allowed)"]);
  });

  test("reserved and listed domains pass, subdomains of a listed domain pass", () => {
    const text = ["a@example.com", "b@x.example.org", "c@corp.test", "d@host.invalid", "e@github.com", "f@users.noreply.github.com"].join("\n");
    expect(foreignAddressLines(text)).toEqual([]);
  });

  test("a version string or a scoped package is not an address", () => {
    expect(foreignAddressLines("npm i pkg@1.2.3-beta and @types/node and tool@latest")).toEqual([]);
  });

  test("a banner with a name outside the neutral list fails, a neutral or bare banner passes", () => {
    expect(foreignBannerLines("x\n\u001b[1mWelcome back Zed!\u001b[0m")).toEqual([2]);
    expect(foreignBannerLines("Welcome back Robin!\nWelcome back sam!\nWelcome back!")).toEqual([]);
  });
});
