import { fileURLToPath } from "node:url";

import type { Ctx, ServiceBackend, ShellCommand, ShellResult } from "../types.ts";

/** The backend surface plus the destructive operation needed by the uninstall verb. */
export type InstalledServiceBackend = ServiceBackend & {
  uninstall(ctx: Ctx): Promise<void>;
};

/** The checkout containing scripts/ctl when no test or embedding override is supplied. */
export const DEFAULT_CHECKOUT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Build an actionable ctl error for a non-zero command result. */
export function shellFailure(
  command: string,
  args: readonly string[],
  result: ShellResult,
): Error {
  const detail = result.stderr.trim() || result.stdout.trim();
  return new Error(
    `command failed (${result.exitCode}): ${[command, ...args].join(" ")}${
      detail.length > 0 ? `\n${detail}` : ""
    }`,
  );
}

/** Run a command and turn a non-zero result into an actionable ctl error. */
export async function checkedShell(
  ctx: Ctx,
  command: string,
  args: readonly string[] = [],
): Promise<ShellResult> {
  const result = await ctx.shell(command, args);
  if (result.exitCode !== 0) throw shellFailure(command, args, result);
  return result;
}

/** Run an idempotent supervisor cleanup operation, matching the shell implementation's semantics. */
export async function bestEffortShell(
  ctx: Ctx,
  command: string,
  args: readonly string[] = [],
): Promise<ShellResult | undefined> {
  try {
    const result = await ctx.shell(command, args);
    return result;
  } catch {
    return undefined;
  }
}

/** Normalize a tail count without allowing a command argument injection. */
export function logLineCount(lines: number | undefined): number {
  if (lines === undefined || !Number.isFinite(lines)) return 50;
  return Math.max(0, Math.floor(lines));
}

/** Build a platform-neutral command used by the info verb's injected log reader. */
export function tailCommand(file: string, lines: number | undefined): ShellCommand {
  return { command: "tail", args: ["-n", String(logLineCount(lines)), file] };
}

/** Resolve a generated service's checkout root while keeping fixture paths injectable. */
export function checkoutRoot(rootDir: string | undefined): string {
  return rootDir ?? DEFAULT_CHECKOUT_ROOT;
}

/** Resolve an absolute Bun executable while allowing explicit installation overrides. */
export function bunBinary(binary: string | undefined): string {
  return binary ?? process.env.BUN_BINARY ?? process.execPath;
}

/** Escape a value for use as PowerShell single-quoted string content. */
export function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The common lifecycle extension used by all three backend implementations. */
export interface BackendFactoryOptions {
  rootDir?: string;
  bun?: string;
}

/** Type guard-like helper for keeping backend factories honest at compile time. */
export function asInstalledBackend<T extends InstalledServiceBackend>(backend: T): T {
  return backend;
}

