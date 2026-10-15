// The installed version of a harness, read from its binary (M56 spec 02). The profile says which
// command prints it and which expression finds it; the screen is never read. This is the same rule
// the canary uses (`installedVersion` in scripts/harness-canary/run.ts): run the version command with
// a short bound and take the first match in what it printed, on stdout or stderr. A command that will
// not run, or prints no version, gives null, and `profileFor` turns null into `provisional`.

import { type Profile, versionFromOutput } from "../../web/src/lib/surface/profile.ts";

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

/** The version command run with Bun.spawn, bounded by VERSION_TIMEOUT_MS, never blocking the event loop. */
export const spawnBinaryVersion: AsyncVersionReader = async (profile) => {
  try {
    const run = Bun.spawn([...profile.identity.versionCommand], { stdout: "pipe", stderr: "pipe", timeout: VERSION_TIMEOUT_MS });
    const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
    await run.exited;
    return versionFromOutput(profile, `${out} ${err}`);
  } catch {
    return null;
  }
};

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
