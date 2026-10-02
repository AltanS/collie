import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The Windows installer, scripts/install.ps1 (M43 spec 07).
//
// Two halves. The first reads the script as TEXT, so it runs on every host, Linux CI included: the
// promises in the header, plain ASCII (Windows PowerShell 5.1 reads a file with no byte-order mark as
// the ANSI code page, so one non-ASCII byte would change what it runs), and the one entry call as the
// last line, so a download of `irm | iex` that stops half way runs nothing. The second half runs the
// script in Windows PowerShell 5.1 against a release mirror served from this process, and only runs
// on Windows.

const SCRIPT = join(import.meta.dir, "install.ps1");
const TEXT = readFileSync(SCRIPT, "utf8");
const LINES = TEXT.split(/\r?\n/);
/** The comment block at the top: everything before the first line that is not a comment. */
const HEADER = LINES.slice(0, LINES.findIndex((l) => l.trim() !== "" && !l.startsWith("#"))).join("\n");
/** The lines that are code, not comments. */
const CODE = LINES.filter((l) => !l.trimStart().startsWith("#"));
/** The code lines with every double-quoted string blanked, so a printed hint such as Herdr's own
 *  `irm ... | iex` is not read as a call. A backtick escapes a quote in PowerShell. */
const BARE = CODE.map((l) => l.replace(/"(?:[^"`]|`.)*"/g, '""'));
const offending = (pattern: RegExp): string[] => BARE.filter((l) => pattern.test(l));
const ENTRY = "Install-Collie $MyInvocation.MyCommand.Path $args";

describe("scripts/install.ps1, read as text", () => {
  test("the header states what it will never do, as install.sh does", () => {
    expect(HEADER).toMatch(/never asks for admin rights/);
    expect(HEADER).toMatch(/never writes outside COLLIE_DIR, except one entry in your user PATH/);
    expect(HEADER).toMatch(/never starts a service, a task or a program/);
    expect(HEADER).toMatch(/never sends anything anywhere/);
    expect(HEADER).toMatch(/never installs a download whose sha256 does not match/);
    expect(HEADER).toMatch(/ends by PRINTING the next steps/);
    expect(HEADER).toContain("irm https://colliepwa.dev/install.ps1 | iex");
  });

  test("the same three steering variables as install.sh, and the two test switches, are named", () => {
    for (const name of ["COLLIE_DIR", "COLLIE_UPDATE_REPO", "COLLIE_TAG", "COLLIE_NO_PATH_EDIT", "COLLIE_INSTALL_MIRROR"]) {
      expect(HEADER).toContain(name);
    }
    const sh = readFileSync(join(import.meta.dir, "install.sh"), "utf8");
    for (const name of ["COLLIE_DIR", "COLLIE_UPDATE_REPO", "COLLIE_TAG"]) expect(sh).toContain(name);
  });

  test("is plain ASCII, with no byte-order mark and no dash a reader cannot type", () => {
    const bytes = readFileSync(SCRIPT);
    expect(bytes[0]).not.toBe(0xef);
    const wide = [...bytes].findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d));
    expect(wide).toBe(-1);
  });

  test("ends with the one entry call, and every other top-level line is a function", () => {
    const lastLine = LINES.findLast((l) => l.trim() !== "");
    expect(lastLine).toBe(ENTRY);
    const topLevel = CODE.filter((l) => l !== "" && !l.startsWith(" ") && !l.startsWith("\t"));
    const strays = topLevel.filter((l) => !/^function [A-Za-z-]+( *\(.*\))? *\{$/.test(l) && l !== "}" && l !== ENTRY);
    expect(strays).toEqual([]);
    expect(TEXT.split(ENTRY).length - 1).toBe(1);
  });

  test("every web call works in Windows PowerShell 5.1: basic parsing, TLS 1.2, no progress bar", () => {
    const calls = BARE.filter((l) => /Invoke-WebRequest|Invoke-RestMethod|\birm\b/.test(l));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain("-UseBasicParsing");
    expect(TEXT).toContain("[Net.SecurityProtocolType]::Tls12");
    expect(TEXT).toContain('$ProgressPreference = "SilentlyContinue"');
  });

  test("runs nothing it downloads, starts nothing, and asks for no admin", () => {
    expect(offending(/Invoke-Expression|\biex\b/)).toEqual([]);
    expect(offending(/Start-Process|Start-ScheduledTask|Register-ScheduledTask|schtasks|Start-Service|New-Service/i)).toEqual([]);
    expect(offending(/RunAs|HKLM|LocalMachine|SymbolicLink/i)).toEqual([]);
    // "Machine" is a string, so it is looked for in the code with its strings left in.
    expect(CODE.filter((l) => /"Machine"|'Machine'/.test(l))).toEqual([]);
    // No line calls a program with `&`, so no line runs the collie.exe it laid down.
    expect(offending(/(^|[\s(;])&\s/)).toEqual([]);
  });

  test("a junction is removed by itself, never through a recursive delete", () => {
    for (const line of CODE.filter((l) => l.includes("-Recurse"))) {
      expect(line).not.toMatch(/\$current|\$staged|current"/);
    }
    expect(TEXT).toContain("[System.IO.Directory]::Delete($Path, $false)");
  });

  test("stops on a missing sidecar and on a digest that does not match", () => {
    expect(TEXT).toContain("Refusing to install an unverified binary");
    expect(TEXT).toContain("CHECKSUM MISMATCH");
    expect(TEXT).toContain("[StringComparison]::OrdinalIgnoreCase");
  });
});
