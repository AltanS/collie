// THE WINDOWS TOOLS THAT READ AND SET AN ACCESS LIST, AND NOTHING ELSE (M43 spec 04).
//
// Every rule lives elsewhere (`sddl.ts` reads the text, `acl-policy.ts` decides what may change,
// `owner-only.ts` puts them together). This module only runs `icacls`, `whoami` and, for
// `collie doctor`, one PowerShell `Get-Acl`, and hands back what they wrote.
//
// BY ABSOLUTE PATH. Each tool is `%SystemRoot%\System32\<tool>.exe` (`C:\Windows` when SystemRoot is
// unset), never a bare name: Windows looks in the current folder first, so a cloned repository that
// carries its own `icacls.exe` would otherwise run in Collie's place.
//
// BOUNDED. Every call ends after {@link ACL_TIMEOUT_MS}; a call that ran out of time answers
// `timedOut`, which the caller treats as "not checked", never as "loose".

import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

/** The bound on one call. Ten seconds is far past the 10 to 60 ms a healthy call takes. */
export const ACL_TIMEOUT_MS = 10_000;

/** What a tool answered. `null` from a {@link Runner} means it did not start. */
export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly timedOut: boolean;
}

/** How a process is started: one argv, a bound, the answer. */
export interface Runner {
  run(argv: readonly string[], timeoutMs: number): RunResult | null;
}

/** The temp file `icacls /save` writes, in the user's own temp folder. */
export interface Scratch {
  file(): string;
  readUtf16(path: string): string | null;
  remove(path: string): void;
}

/** What a `/save` read gave: the text, or why there is none. */
export type SaveResult =
  | { readonly kind: "ok"; readonly code: number; readonly text: string }
  | { readonly kind: "timed-out" }
  | { readonly kind: "not-run" };

export interface AclTool {
  /** `icacls <path> /save <temp> [/T] /C /Q`, and the file read back. */
  save(path: string, tree: boolean): SaveResult;
  /**
   * `icacls <args…>`: the repair, one call. Not `/restore`: that needs the Restore privilege, which a
   * standard user does not hold (VM, 2026-10-02: error 1300).
   */
  icacls(args: readonly string[]): RunResult | null;
  /** `icacls <path> /reset /L /C /Q`: the entry inherits from its folder and keeps nothing of its own. */
  reset(path: string): RunResult | null;
  /** `whoami /user /fo csv /nh`. */
  whoami(): RunResult | null;
  /**
   * One PowerShell `Get-Acl` over `paths`: the whole SDDL of each, owner included, which `icacls`
   * never writes. Slower (about 150 ms), so `collie doctor` alone calls it. A path that failed is
   * absent from the map; `null` when PowerShell did not answer.
   */
  descriptors(paths: readonly string[]): Map<string, string> | null;
}

/** `<SystemRoot>\System32\<parts…>`, spelled with Windows separators on any host. */
export function systemTool(env: Readonly<Record<string, string | undefined>>, ...parts: string[]): string {
  const root = env.SystemRoot !== undefined && env.SystemRoot !== "" ? env.SystemRoot : "C:\\Windows";
  return nodePath.win32.join(root, "System32", ...parts);
}

/** A single-quoted PowerShell string: only the quote itself needs doubling. */
const psQuote = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/** The tools over a runner and a scratch folder. Production passes neither. */
export function aclTool(
  runner: Runner = bunRunner,
  env: Readonly<Record<string, string | undefined>> = process.env,
  scratch: Scratch = realScratch,
): AclTool {
  const icacls = systemTool(env, "icacls.exe");
  return {
    save(path, tree) {
      const file = scratch.file();
      try {
        const run = runner.run([icacls, path, "/save", file, ...(tree ? ["/T"] : []), "/C", "/Q"], ACL_TIMEOUT_MS);
        if (run === null) return { kind: "not-run" };
        if (run.timedOut) return { kind: "timed-out" };
        return { kind: "ok", code: run.code, text: scratch.readUtf16(file) ?? "" };
      } finally {
        scratch.remove(file);
      }
    },
    icacls(args) {
      return runner.run([icacls, ...args], ACL_TIMEOUT_MS);
    },
    reset(path) {
      return runner.run([icacls, path, "/reset", "/L", "/C", "/Q"], ACL_TIMEOUT_MS);
    },
    whoami() {
      return runner.run([systemTool(env, "whoami.exe"), "/user", "/fo", "csv", "/nh"], ACL_TIMEOUT_MS);
    },
    descriptors(paths) {
      if (paths.length === 0) return new Map();
      const list = paths.map(psQuote).join(",");
      const script =
        `$i = 0; foreach ($p in @(${list})) { try { [string]$i + [char]9 + (Get-Acl -LiteralPath $p).Sddl } catch { }; $i++ }`;
      const run = runner.run(
        [systemTool(env, "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-Command", script],
        ACL_TIMEOUT_MS,
      );
      if (run === null || run.timedOut) return null;
      const out = new Map<string, string>();
      for (const line of run.stdout.split(/\r?\n/)) {
        const tab = line.indexOf("\t");
        const path = paths[Number(line.slice(0, tab))];
        if (tab > 0 && path !== undefined) out.set(path, line.slice(tab + 1).trim());
      }
      return out;
    },
  };
}

/** `Bun.spawnSync` with the bound. Only ever reached on Windows. */
export const bunRunner: Runner = {
  run(argv, timeoutMs) {
    try {
      const r = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL" });
      const timedOut = r.exitedDueToTimeout === true;
      return { code: timedOut ? 124 : (r.exitCode ?? 124), stdout: r.stdout.toString(), timedOut };
    } catch {
      return null;
    }
  },
};

/**
 * Temp files in the user's own temp folder, which the profile keeps private. They hold access lists
 * of Collie's folders, not secrets, and each is removed when its call returns.
 */
export const realScratch: Scratch = {
  file: () => nodePath.join(tmpdir(), `collie-acl-${randomUUID()}.txt`),
  readUtf16(path) {
    try {
      return readFileSync(path).toString("utf16le");
    } catch {
      return null;
    }
  },
  remove(path) {
    rmSync(path, { force: true });
  },
};
