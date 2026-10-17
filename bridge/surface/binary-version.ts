// The installed version of a harness, read from its binary (M56 spec 02). The profile says which
// command prints it and which expression finds it; the screen is never read. This is the same rule
// the canary uses (`installedVersion` in scripts/harness-canary/run.ts): run the version command with
// a short bound and take the first match in what it printed, on stdout or stderr. A command that will
// not run, or prints no version, gives null, and `profileFor` turns null into `provisional`.

import { homedir } from "node:os";

import { type Profile, versionFromOutput } from "../../web/src/lib/surface/profile.ts";
import { HOST, type Host } from "../host.ts";
import { createLoginPath, type LoginPath, type LoginPathDeps } from "../login-path.ts";
import { envGet, envKey, findTool } from "../tools.ts";

const VERSION_TIMEOUT_MS = 5000;

/** Runs a command and returns what it printed, or null when it would not run. */
export type RunVersionCommand = (command: readonly string[]) => string | null;

const spawnVersionCommand: RunVersionCommand = (command) => {
  try {
    const run = Bun.spawnSync([...command], { stdout: "pipe", stderr: "pipe", timeout: VERSION_TIMEOUT_MS });
    return `${run.stdout.toString()} ${run.stderr.toString()}`;
  } catch {
    return null;
  }
};

/** The version the profile's binary reports, or null when it cannot be read. */
export function binaryVersion(profile: Profile, run: RunVersionCommand = spawnVersionCommand): string | null {
  const output = run(profile.identity.versionCommand);
  return output === null ? null : versionFromOutput(profile, output);
}

/** Reads a binary's version without blocking, or null. Injected so tests run no process. */
export type AsyncVersionReader = (profile: Profile) => Promise<string | null>;

/** Runs a resolved command with `path` as its PATH and returns what it printed, or null when it would not run. */
export type RunResolvedCommand = (argv: readonly string[], path: string | undefined) => Promise<string | null>;

/** `env` is the bridge's own environment, whose PATH is searched after the login shell's. */
export interface VersionReaderDeps extends LoginPathDeps {
  loginPath?: LoginPath;
  /** The binary's file on `path`, or null. Defaults to {@link findTool}. */
  resolve?: (binary: string, path: string | undefined) => string | null;
  run?: RunResolvedCommand;
}

/**
 * The login shell's PATH first, the bridge's own after it, each directory once. The login PATH wins
 * because launchd gives a LaunchAgent only `/usr/bin:/bin:/usr/sbin:/sbin`. The bridge's own stays
 * as the tail because a systemd unit sets a PATH of its own (`~/.config/systemd/user/collie*.service`),
 * and a directory only that PATH holds must not drop out of the search.
 */
export function mergePaths(login: string | undefined, own: string | undefined, host: Host = HOST): string | undefined {
  const parts = [login, own].flatMap((p) => (p === undefined ? [] : p.split(host.path.delimiter)));
  const seen = new Set<string>();
  const merged = parts.filter((d) => d !== "" && !seen.has(d) && seen.add(d));
  return merged.length === 0 ? undefined : merged.join(host.path.delimiter);
}

/**
 * Reads a binary's version without blocking, from the binary the operator's login shell would run.
 * The bridge's own PATH is not enough: launchd gives a LaunchAgent `/usr/bin:/bin:/usr/sbin:/sbin`,
 * where no agent lives, and every send on such a host read the version as unread. The login PATH
 * alone is not enough either: it drops a directory only the systemd unit's PATH holds. So the search
 * runs over the login PATH, then the bridge's own ({@link mergePaths}). That merged PATH goes to the
 * child as well, because a script agent (`#!/usr/bin/env node`) finds its interpreter on it.
 */
export function createVersionReader(deps: VersionReaderDeps = {}): AsyncVersionReader {
  const env = deps.env ?? process.env;
  const host = deps.host ?? HOST;
  const loginPath = deps.loginPath ?? createLoginPath({ ...deps, env, host });
  const resolve =
    deps.resolve ?? ((binary: string, path: string | undefined) => findTool(binary, { ...env, PATH: path }, homedir(), host));
  const run = deps.run ?? spawnWithPath;
  return async (profile) => {
    const [command, ...args] = profile.identity.versionCommand;
    const path = mergePaths(await loginPath(), envGet(env, "PATH", host), host);
    const binary = command === undefined ? null : resolve(command, path);
    if (binary === null) return null;
    const output = await run([binary, ...args], path);
    return output === null ? null : versionFromOutput(profile, output);
  };
}

const spawnWithPath: RunResolvedCommand = async (argv, path) => {
  try {
    const env = path === undefined ? process.env : { ...process.env, [envKey(process.env, "PATH")]: path };
    const run = Bun.spawn([...argv], { env, stdout: "pipe", stderr: "pipe", timeout: VERSION_TIMEOUT_MS });
    const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
    await run.exited;
    return `${out} ${err}`;
  } catch {
    return null;
  }
};

/** The version command run with Bun.spawn, bounded by VERSION_TIMEOUT_MS, never blocking the event loop. */
export const spawnBinaryVersion: AsyncVersionReader = createVersionReader();

/** How long a version read is trusted before the next send reads it again. */
export const VERSION_CACHE_MS = 10 * 60_000;

/**
 * A per-profile cache of the binary's version for the send path (M56 spec 05). The first send on a
 * profile waits for the version, so its status is never guessed; later sends use the cached value
 * for VERSION_CACHE_MS. A version that could not be read is cached too, as null, which `profileFor`
 * turns into `provisional` and the probed path.
 */
export class VersionCache {
  private readonly known = new Map<string, { version: string | null; at: number }>();

  constructor(
    private readonly read: AsyncVersionReader = spawnBinaryVersion,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async versionOf(profile: Profile): Promise<string | null> {
    const hit = this.known.get(profile.id);
    if (hit !== undefined && this.now() - hit.at <= VERSION_CACHE_MS) return hit.version;
    const version = await this.read(profile);
    this.known.set(profile.id, { version, at: this.now() });
    return version;
  }
}
