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
