import { createBinaryReader, type BinaryRead } from "../bridge/surface/binary-version.ts";
import { compareSemver } from "../web/src/lib/semver.ts";
import { loadProfiles, profileFor, type Profile, type ProfileStatus } from "../web/src/lib/surface/profile.ts";
import { ok, warn, type Finding } from "./finding.ts";

// ── The harnesses table (1.24.1) ─────────────────────────────────────────────
//
// One row per harness Collie has a profile for. Each row says which binary the bridge would run for
// it (the file on the login shell's PATH, found by the same code the send path uses), which version
// that binary printed, and what the profile says about that version. The rows come from the profile
// files, so a new harness appears here when its profile lands and this module never names one.
//
// It is a READ, like the rest of `doctor`: it runs each harness's own version command and nothing
// else. The case it exists for is the one the send path hides. A binary that resolves but whose
// version command fails (a wrapper that needs `$HOME`, a broken install) reads as an unreadable
// version, and every send on that harness runs on a provisional profile with a turn Collie does not
// trust. Nothing on the phone says why. `warn` here names the file and the exit code.
//
// A harness with no binary on the PATH is not a fault: most hosts run two or three of them. Its row
// is `ok` and says "not installed", the same word the integration table uses.

/** Why a provisional version is trusted for what it is. */
const PROVISIONAL_ABOVE = "above the verified range; sends in a turn are trusted, dialogs may drift";
const PROVISIONAL_OTHER = "outside the verified range; sends in a turn are trusted, dialogs may drift";
const UNREAD_HINT = "a wrapper first on PATH that needs $HOME, or a broken install";
/** The most of a stderr line a row carries. */
const STDERR_CAP = 160;

/** A finding for one harness. The extra fields are what a script reads from `--json`. */
export interface HarnessFinding extends Finding {
  /** The profile id. */
  readonly harness: string;
  /** The file the version command resolved to on the login PATH, or null when nothing answers. */
  readonly binary: string | null;
  /** The version the binary printed, or null: not installed, or unread. */
  readonly version: string | null;
  /** The profile's verdict on that version: `verified`, `provisional`, `revoked`, or null with no version. */
  readonly profileStatus: ProfileStatus | null;
}

/** The seam: a harness's binary and version as the bridge reads them. Tests hand a fake. */
export type ReadHarness = (profile: Profile) => Promise<BinaryRead>;

/** The real reader: the bridge's own resolution and version command. */
export function harnessReader(env: Record<string, string | undefined>): ReadHarness {
  return createBinaryReader({ env });
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
  return line.length > STDERR_CAP ? `${line.slice(0, STDERR_CAP)}…` : line;
}

function unreadReason(read: BinaryRead): string {
  const { outcome } = read;
  if (outcome === null) return "the command would not run";
  if (outcome.exitCode === null) return "the command did not finish in time";
  const stderr = firstLine(outcome.stderr);
  if (outcome.exitCode === 0) return "exit 0, no version in its output";
  return stderr === "" ? `exit ${String(outcome.exitCode)}` : `exit ${String(outcome.exitCode)}: ${stderr}`;
}

function row(profile: Profile, read: BinaryRead): HarnessFinding {
  const check = `harness-${profile.id}`;
  const base = { harness: profile.id, binary: read.binary, version: read.version };
  if (read.binary === null) {
    return { ...ok(check, "not installed"), ...base, profileStatus: null };
  }
  if (read.version === null) {
    const detail = `${read.binary} · unread (${unreadReason(read)})`;
    const remedy =
      `${read.binary} resolves but its version did not read; ${UNREAD_HINT}. ` +
      `Until it reads, sends to ${profile.id} run on a provisional profile with an untrusted turn`;
    return { ...warn(check, detail, remedy), ...base, profileStatus: null };
  }
  const match = profileFor(profile.id, read.version, { log: () => {}, profiles: new Map([[profile.id, profile]]) });
  const status = match?.status ?? "provisional";
  const head = `${read.binary} · ${read.version}`;
  if (status === "verified") return { ...ok(check, `${head} · verified`), ...base, profileStatus: status };
  if (status === "revoked") {
    return {
      ...warn(check, `${head} · revoked`, `this version is revoked; Collie sends to ${profile.id} through the probed path until you move to a verified version`),
      ...base,
      profileStatus: status,
    };
  }
  const top = match?.range === null || match === null ? null : (match.range.high ?? match.range.low);
  const note = top !== null && compareSemver(read.version, top) > 0 ? PROVISIONAL_ABOVE : PROVISIONAL_OTHER;
  // A provisional version is a note, not a fault: `ok`, so `doctor` stays clean and `update --check` stays green.
  return { ...ok(check, `${head} · provisional, note: ${note}`), ...base, profileStatus: status };
}

/** The harnesses table: one finding per profile, in the order of the profile files. */
export async function harnessFindings(read: ReadHarness): Promise<HarnessFinding[]> {
  const profiles = [...loadProfiles().values()];
  const reads = await Promise.all(profiles.map((profile) => read(profile)));
  return profiles.map((profile, i) => row(profile, reads[i]!));
}
