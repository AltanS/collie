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
