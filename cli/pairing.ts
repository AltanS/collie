import { join } from "node:path";

import {
  coerceRegistry,
  DEVICES_FILENAME,
  generateCode,
  newPending,
  type PairedRegistry,
  PENDING_FILENAME,
  removeDevice,
} from "../bridge/pairing.ts";
import type { CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import { urlToEncode } from "./qr.ts";
import type { Exec, Files } from "./sys.ts";
import { renderQr } from "../scripts/qr.ts";

// `pair`, `devices list`, `devices revoke` — the operator's half of device pairing. The pure
// decisions all live in `bridge/pairing.ts`; this module is the terminal, the two files under the
// state dir, and the words an operator reads.
//
// ── WHY THE TERMINAL MINTS THE CODE, AND NOT THE WEB UI ──────────────────────
// Enrolment is a bootstrap problem: the phone asking to be paired is, by definition, the one party
// that cannot yet prove anything — it holds no token, and the header gate (if configured at all) only
// says what the network asserts about it. A "pair this device" button in Collie's own UI would
// therefore be authorised by nothing, and would hand a write credential to whoever loaded the page.
// The operator's shell on the host IS the proof: reaching it already implies the access pairing is
// there to fence off. So the code is minted where that proof already exists and carried out of band —
// eyes, from a terminal to a phone keyboard — and the UI's only job is to spend it.
//
// ── WHY THE CODE MAY ALSO BE A QR ────────────────────────────────────────────
// `pair` prints the code as a QR that opens Settings with it filled in. That gives away nothing: the
// terminal is already the out-of-band channel the code travels on, and whoever reads the QR is
// whoever reads the line above it. The QR only spares the phone keyboard eight characters. The code
// it carries is the same one — single-use, dead in 10 minutes, stored as a hash and never as itself
// — so a screenshot of this terminal is worth exactly what a photograph of it was already worth.
//
// The same reasoning runs the other way for revocation: a lost phone is revoked from the machine, not
// from the phone. `devices revoke` needs no service restart — the bridge re-reads
// `paired-devices.json` per request (`readRegistrySync` in bridge/pairing.ts), so the device loses
// write access on its very next call.

/** The `devices` sub-verbs, in the order the usage block prints them. */
export const DEVICES_SUBCOMMANDS = ["list", "revoke"] as const;

export interface PairingDeps {
  ctx: CliContext;
  io: Io;
  files: Files;
  /** The tailnet probes `urlToEncode` runs to decide whether the code is worth a QR. */
  exec: Exec;
  /** Injected so a test can pin the printed expiry; production leaves it. */
  now?: () => number;
  /** Injected so a test can pin the minted code; production leaves it. */
  random?: (n: number) => Buffer;
}

const pendingPath = (ctx: CliContext): string => join(ctx.stateDir, PENDING_FILENAME);
const registryPath = (ctx: CliContext): string => join(ctx.stateDir, DEVICES_FILENAME);

/**
 * The registry as it is on disk. Absent, unreadable or malformed all read as "nothing paired".
 *
 * Exported because `pack deputy` asks the same question for a different reason (RFC §6.4: a lead with
 * nothing paired could never arm a standby door), and two readers of one credential file is two
 * places for "is anything paired?" to answer differently.
 */
export function pairedRegistryOf(files: Files, stateDir: string): PairedRegistry {
  const raw = files.read(join(stateDir, DEVICES_FILENAME));
  if (raw === null) return coerceRegistry(null);
  try {
    return coerceRegistry(JSON.parse(raw));
  } catch {
    return coerceRegistry(null);
  }
}

function readRegistry(deps: PairingDeps): PairedRegistry {
  return pairedRegistryOf(deps.files, deps.ctx.stateDir);
}

/** Owner-only, and the directory too: both files are credentials-in-hash-form. */
function writeOwnerOnly<TDocument>(deps: PairingDeps, path: string, value: TDocument): void {
  deps.files.mkdirp(deps.ctx.stateDir, 0o700);
  deps.files.write(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

const stamp = (ms: number): string => (ms > 0 ? new Date(ms).toISOString() : "never");

// ── pair ─────────────────────────────────────────────────────────────────────

/**
 * `collie pair` — mint the one-time code the phone spends on `/api/pair`.
 *
 * Only the code's HASH is written, so the string printed here is the only copy that will ever exist;
 * a second `pair` overwrites the pending file, which kills the previous code (that is the intended
 * way to cancel one, and the output says so).
 *
 * The QR below the code is best-effort and never a failure: the pending file is already on disk by
 * the time it is drawn, so a missing URL or a broken renderer would only cost a keyboard shortcut.
 */
export async function cmdPair(deps: PairingDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const code = generateCode(deps.random);
  const pending = newPending(code, now);
  const path = pendingPath(deps.ctx);
  const replaced = deps.files.exists(path);

  try {
    writeOwnerOnly(deps, path, pending);
  } catch (err) {
    deps.io.err(`error: could not write ${path} — ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }

  const minutes = Math.round((pending.expiresAt - now) / 60_000);
  deps.io.out(code);
  deps.io.out("");
  deps.io.out(
    `  single-use · expires ${new Date(pending.expiresAt).toISOString()} (${minutes} minutes)`,
  );
  deps.io.out("  Open Collie on your phone, go to Settings, and enter this code there.");
  deps.io.out("  Shown once — only its hash is stored, and the bridge picks it up without a restart.");
  if (replaced) {
    deps.io.out("  A code from an earlier `collie pair` was still pending; it is now dead.");
  }
  await printPairQr(deps, code);
  return EXIT.OK;
}

/**
 * The scannable half. `urlToEncode` (cli/qr.ts) owns which URL is worth a QR and has already said on
 * stderr why it refused, so the line here only points at that and reassures: the code above stands
 * on its own, and the operator can still type it.
 */
async function printPairQr(deps: PairingDeps, code: string): Promise<void> {
  const base = urlToEncode({ ctx: deps.ctx, io: deps.io, exec: deps.exec });
  if (base === null) {
    deps.io.out("  No QR: the bridge URL is unknown, see the note above; the code above still works.");
    return;
  }
  // NO `#paired-devices` FRAGMENT, deliberately, even though the Settings card answers to one. HTML
  // runs the focusing steps on a fragment target once it exists, and it does that AFTER the page's
  // scripts — so the browser itself would pull focus onto the card and off the name field, which is
  // the only thing left to type. `pair` alone is the signal: the card scrolls itself into view when
  // it sees it (web/src/components/paired-devices.tsx). Measured in a browser, not reasoned about.
  // `CODE_ALPHABET` is URL-safe, so the encode is a no-op — it is here so it stays true if it isn't.
  const url = `${base.replace(/\/+$/, "")}/settings?pair=${encodeURIComponent(code)}`;
  let drawn: string;
  try {
    drawn = await renderQr(url);
  } catch (err) {
    deps.io.out(`  No QR: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  deps.io.out("");
  for (const line of drawn.split("\n")) deps.io.out(line);
  deps.io.out("");
  deps.io.out(url);
  deps.io.out("  Scan it: Collie opens Settings on the phone with the code filled in.");
}

// ── devices ──────────────────────────────────────────────────────────────────

/** `collie devices list` — who holds a write credential for this bridge. */
export function cmdDevicesList(deps: PairingDeps): number {
  const { devices } = readRegistry(deps);
  if (devices.length === 0) {
    deps.io.out("no devices paired — pairing is not enforced, and writes pass on the other gates alone.");
    deps.io.out("Run `collie pair` to enrol the first device; that is also what turns the requirement on.");
    return EXIT.OK;
  }
  const width = Math.max(...devices.map((d) => d.label.length));
  for (const d of devices) {
    deps.io.out(`${d.label.padEnd(width)}  created ${stamp(d.createdAt)}  last seen ${stamp(d.lastSeenAt)}`);
  }
  return EXIT.OK;
}

/** `collie devices revoke <label>` — drop one device's credential. */
export function cmdDevicesRevoke(deps: PairingDeps, args: readonly string[]): number {
  const label = args[0];
  if (label === undefined || label === "") {
    deps.io.err("usage: collie devices revoke <label>");
    return EXIT.USAGE;
  }
  const registry = readRegistry(deps);
  const next = removeDevice(registry, label);
  if (next === null) {
    deps.io.err(`error: no paired device labelled \`${label}\``);
    deps.io.err(
      registry.devices.length === 0
        ? "  nothing is paired on this machine — `collie devices list`."
        : `  paired: ${registry.devices.map((d) => d.label).join(", ")}`,
    );
    return EXIT.FAIL;
  }

  try {
    writeOwnerOnly(deps, registryPath(deps.ctx), next);
  } catch (err) {
    deps.io.err(
      `error: could not write ${registryPath(deps.ctx)} — ${err instanceof Error ? err.message : String(err)}`,
    );
    return EXIT.FAIL;
  }

  deps.io.out(`✓ revoked "${label}" — it loses write access on its next request (no restart needed).`);
  if (next.devices.length === 0) {
    deps.io.out("  That was the last paired device, so pairing is no longer enforced at all.");
  }
  return EXIT.OK;
}

export function devicesUsage(): string {
  return `usage: collie devices {${DEVICES_SUBCOMMANDS.join("|")}}`;
}

/**
 * The parent verb. Reached only when no sub-verb matched — a bare `collie devices`, or a misspelt
 * one — and it names each sub-verb with its summary, as `cmdPack` does.
 */
export function cmdDevices(deps: PairingDeps, args: readonly string[]): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return cmdDevicesList(deps);
    case "revoke":
      return cmdDevicesRevoke(deps, rest);
    default:
      if (sub !== undefined && sub !== "" && sub !== "help") {
        deps.io.err(`error: unknown devices subcommand \`${sub}\``);
      }
      deps.io.err(devicesUsage());
      deps.io.err("  list     the paired devices, with when each was paired and last seen");
      deps.io.err("  revoke   drop one device by label: `devices revoke <label>`");
      return EXIT.USAGE;
  }
}
