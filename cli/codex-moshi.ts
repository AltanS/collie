import { join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import type { CancelOutcome, ProviderEnd, ProviderRun } from "./codex-broker.ts";
import type { Files } from "./sys.ts";

// THE MOSHI CAPABILITY GATE (`collie hooks install codex --native --hold-permissions --with-moshi`).
//
// Moshi answers a Codex permission from a phone through its own `PermissionRequest` hook. Collie
// answers the same permission from its phone view. Both cannot be handlers at once (cli/codex-broker.ts
// says why), so `--with-moshi` replaces Moshi's one entry with Collie's broker, which starts the
// ORIGINAL Moshi command with the unchanged payload next to the Collie hold. That is only correct when
// the broker can WITHDRAW whichever one loses: a Moshi prompt left on a phone after the person already
// answered in Collie is a second approval path nobody is watching.
//
// WHETHER MOSHI WITHDRAWS ON CANCEL IS A FACT ABOUT THE INSTALLED MOSHI, and nothing here can read it
// off the binary. A symbol in the binary, a clean exit after a signal, or "the process ended" prove
// that Moshi stopped, not that its remote request went away. So the gate is a RECORD of a runtime
// observation, made by whoever ran the real provider, and this module only decides whether the record
// still describes the Moshi that is installed now:
//
//  - the record names the cancellation method the observation used (the broker uses the same one),
//  - it says the remote request was observed withdrawn (`proof.kind` is `runtime-withdrawal` and
//    `remoteWithdrawn` is true; no other kind of evidence is accepted),
//  - it says the provider DECIDES (`proof.decides` is `hook-stdout`: the allow or deny is on the hook's
//    stdout) and BLOCKS until answered (`proof.blocksUntilAnswered` is true). A provider that exits at
//    once is silent to the broker, and its remote card would outlive the request,
//  - it names the exact entry command, the resolved executable and that executable's sha256, so a
//    Moshi that was updated, replaced or repointed is a different provider and the record no longer
//    applies (a version change always changes the digest).
//
// No record, a record that does not parse, or one that does not match: the install REFUSES before it
// writes anything, and a broker that is already installed answers Moshi-only (Moshi's own output,
// untouched) and never runs the Collie hold beside it.
//
// ── MOSHI 0.4.37 IS KNOWN NOT TO QUALIFY (root's spike, 2026-10-25, issue #595) ─────────────────────
// Its `codex-hook` is fire and forget: it posts one `session.update` to the Moshi daemon, gets an ack
// and exits 0 with empty stdout in well under a second. It never returns an allow or a deny, so it is
// not a decision provider at all, and the phone card lives in the daemon, where nothing Collie may call
// withdraws it by action id. A card whose prompt was never drawn (Collie decided first) stays for about
// twelve seconds, and a late answer to a stale card can type `y` into an UNRELATED approval prompt.
// So {@link KNOWN_INCOMPATIBLE} refuses that executable whatever record sits beside it. The broker
// contract (cli/codex-broker.ts) stays generic and tested for a provider that does decide and does
// withdraw; there is none yet, so nothing starts Moshi as one.

/** The one Moshi PermissionRequest entry this install knows how to take over, byte for byte. */
export const MOSHI_ENTRY_COMMAND = "'/opt/homebrew/bin/moshi' codex-hook";

/** The record's file name, in Collie's own config dir: it is Collie's evidence, not Codex's. */
export const CAPABILITY_FILE = "codex-moshi-capability.json";

export const capabilityPath = (configDir: string): string => join(configDir, CAPABILITY_FILE);

/** The ways a cancellation request reaches the provider. */
export const CANCEL_METHODS = ["sigterm", "sigint"] as const;
export type CancelMethod = (typeof CANCEL_METHODS)[number];

/** Executables that are known not to qualify, by sha256, and why. A record made for one of them is not read. */
export const KNOWN_INCOMPATIBLE: readonly { readonly digest: string; readonly reason: string }[] = [
  {
    digest: "46aa0cf959ca47d1286a8d4db330994071bf5f06c349ef5fbcd2bbd718e9f468",
    reason:
      "moshi-hook 0.4.37 cannot be a provider: its codex-hook never returns an allow or deny (it posts one update to the Moshi daemon and exits), and its phone card is not withdrawn when Collie decides first, so a late tap can answer an unrelated prompt (issue #595)",
  },
];

/** The argv of the exact Moshi entry, or null for any other command (a shell string is never guessed at). */
export function moshiArgvOf(command: string): string[] | null {
  const match = /^'([^'\n]+)' codex-hook$/u.exec(command);
  return match === null ? null : [match[1]!, "codex-hook"];
}

/** The words of a command line that is plain shell words: single and double quotes, no expansion, no operator. Null for anything else. */
function plainWords(command: string): string[] | null {
  const words: string[] = [];
  let word: string | null = null;
  let quote: "'" | '"' | null = null;
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === "$" || ch === "`" || ch === "\\")) return null;
      else word = (word ?? "") + ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      word = word ?? "";
    } else if (ch === " " || ch === "\t") {
      if (word !== null) words.push(word);
      word = null;
    } else if ("$`\\;&|<>(){}*?[]#~!\n".includes(ch)) {
      return null;
    } else {
      word = (word ?? "") + ch;
    }
  }
  if (quote !== null) return null;
  if (word !== null) words.push(word);
  return words;
}

/**
 * Whether a hook command is a Moshi `codex-hook` in ANY spelling: the first word's basename is `moshi`
 * (or `moshi-hook`, the name of the binary the `moshi` link points at), quoted or not, at any path, and
 * `codex-hook` is its next word. Used to REFUSE and to WARN, never to take over: only the exact entry
 * {@link MOSHI_ENTRY_COMMAND} can be replaced by the broker. A command that is not plain words (a pipe, a
 * substitution) is read by its text: one that names `moshi` and `codex-hook` is still counted as Moshi.
 */
export function isMoshiCommand(command: string): boolean {
  const words = plainWords(command);
  if (words === null) return /(^|[\s/'"])moshi(-hook)?['"]?\s+codex-hook\b/u.test(command);
  while (words[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0])) words.shift();
  const first = words[0];
  return first !== undefined && /^(?:moshi|moshi-hook)$/u.test(first.slice(first.lastIndexOf("/") + 1)) && words[1] === "codex-hook";
}

export interface MoshiCapability {
  readonly executable: string;
  readonly digest: string;
  readonly cancel: { readonly method: CancelMethod; readonly graceMs: number };
  readonly observer: string;
  readonly observedAt: string;
}

export type CapabilityVerdict = { readonly ok: true; readonly capability: MoshiCapability } | { readonly ok: false; readonly reason: string };

/** What the installed Moshi looks like right now: where the entry's path really points and the digest of that file. */
export interface MoshiNow {
  readonly executable: string;
  readonly digest: string;
}

/** The installed Moshi for an entry command, or null when it is not runnable. */
export function moshiNow(files: Files, command: string): MoshiNow | null {
  const argv = moshiArgvOf(command);
  if (argv === null) return null;
  const executable = files.realpath(argv[0]!);
  if (executable === null || !files.executable(executable)) return null;
  const digest = files.digest(executable);
  return digest === null ? null : { executable, digest };
}

const refusal = (reason: string): CapabilityVerdict => ({ ok: false, reason });

/** Decides whether the record at `text` still describes the Moshi installed now. Every doubt is a refusal. */
export function capabilityVerdict(text: string | null, command: string, now: MoshiNow | null): CapabilityVerdict {
  if (now === null) return refusal(`the Moshi at ${command} is not an installed, runnable executable`);
  const known = KNOWN_INCOMPATIBLE.find((row) => row.digest === now.digest);
  if (known !== undefined) return refusal(known.reason);
  if (text === null) return refusal("no recorded proof that Moshi withdraws its request when cancelled");
  const node = parseJsonObject(text);
  if (node === undefined) return refusal("the recorded proof is not valid JSON");
  if (asJsonNumber(node.schema) !== 1 || node.provider !== "moshi") return refusal("the recorded proof is not a v1 Moshi record");
  if (node.command !== command) return refusal("the recorded proof is for a different Moshi entry command");
  const proof = asJsonObject(node.proof);
  if (proof?.kind !== "runtime-withdrawal" || proof.remoteWithdrawn !== true) {
    return refusal("the recorded proof is not a runtime observation that the remote request was withdrawn");
  }
  // The broker obeys the hook contract: a provider is a DECISION provider only when its stdout carries the
  // allow or deny and it stays up until it has one. A fire-and-forget hook (0.4.37) exits at once, so its
  // card would outlive the request. The record must say both were observed; nothing else is accepted.
  if (proof.decides !== "hook-stdout" || proof.blocksUntilAnswered !== true) {
    return refusal("the recorded proof does not attest that the provider returns its decision on the hook's stdout and blocks until it has an answer");
  }
  const observer = asJsonString(proof.observer);
  const observedAt = asJsonString(proof.observedAt);
  const detail = asJsonString(proof.detail);
  if (observer === undefined || observer.trim() === "" || observedAt === undefined || Number.isNaN(Date.parse(observedAt)) || detail === undefined || detail.trim().length < 20) {
    return refusal("the recorded proof names no observer, time and account of what was observed");
  }
  const cancel = asJsonObject(node.cancel);
  const method = CANCEL_METHODS.find((word) => word === cancel?.method);
  const graceMs = asJsonNumber(cancel?.graceMs);
  if (method === undefined || graceMs === undefined || !Number.isInteger(graceMs) || graceMs < 500 || graceMs > 5000) {
    return refusal("the recorded cancellation method is not one the broker can send");
  }
  if (node.executable !== now.executable) return refusal(`Moshi now resolves to ${now.executable}, not the executable the proof was made on`);
  if (node.digest !== now.digest) return refusal("the Moshi executable changed since the proof was made (a new version needs a new proof)");
  return { ok: true, capability: { executable: now.executable, digest: now.digest, cancel: { method, graceMs }, observer, observedAt } };
}

/**
 * A proof record for the installed Moshi with every observation still to be made. It names the
 * executable, its digest and the cancellation the broker will send, and it says nothing was observed:
 * {@link capabilityVerdict} refuses it until the person who watched the request leave the phone sets
 * `remoteWithdrawn` to true and fills in who, when and what they saw. Nothing here observes anything.
 */
export function capabilityTemplate(command: string, now: MoshiNow, cancel: MoshiCapability["cancel"]): string {
  const record = {
    schema: 1,
    provider: "moshi",
    command,
    executable: now.executable,
    digest: now.digest,
    cancel,
    proof: { kind: "runtime-withdrawal", remoteWithdrawn: false, decides: "hook-stdout", blocksUntilAnswered: false, observer: "", observedAt: "", detail: "" },
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** The verdict for the installed Moshi, reading the record from Collie's config dir. */
export function moshiVerdict(files: Files, configDir: string, command: string): CapabilityVerdict {
  return capabilityVerdict(files.read(capabilityPath(configDir)), command, moshiNow(files, command));
}

// ── The real provider: the original command, started with the unchanged payload ─────────────────

/** The signal each method stands for. */
const SIGNALS = { sigterm: "SIGTERM", sigint: "SIGINT" } as const;

/**
 * Starts the provider with `payload` on stdin, byte for byte, and its stdout captured. Cancelling sends
 * the recorded signal, waits up to `graceMs` for the provider to end by itself, and only then kills it:
 * `exited` is a provider that ended after being asked (it had the chance to withdraw), `killed` is not.
 */
export function spawnProvider(argv: readonly string[], payload: string, cancel: MoshiCapability["cancel"] | null, env: Record<string, string | undefined> = process.env): ProviderRun {
  const child = Bun.spawn([...argv], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env });
  void (async () => {
    try {
      child.stdin.write(payload);
      await child.stdin.end();
    } catch {
      // A provider that closed its stdin early has its own reasons; its exit tells the rest.
    }
  })();
  let ended = false;
  const settled: Promise<ProviderEnd> = (async () => {
    try {
      const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      return { exitCode, stdout };
    } catch {
      return { exitCode: null, stdout: "" };
    } finally {
      ended = true;
    }
  })();
  return {
    settled,
    async cancel(graceMs): Promise<CancelOutcome> {
      if (ended || child.exitCode !== null) return "already-ended";
      try {
        child.kill(SIGNALS[cancel?.method ?? "sigterm"]);
      } catch {
        return "already-ended";
      }
      const timer = Promise.withResolvers<"late">();
      const handle = setTimeout(() => timer.resolve("late"), graceMs);
      const first = await Promise.race([child.exited.then(() => "exited" as const), timer.promise]);
      clearTimeout(handle);
      if (first === "exited") return "exited";
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone between the two calls.
      }
      await child.exited.catch(() => undefined);
      return "killed";
    },
  };
}

/**
 * Moshi-only routing: runs the original command with the unchanged payload and its own stdout and
 * stderr, and returns its exit code. Used when the capability record no longer applies, so the
 * broker's Collie half is off and Moshi behaves as it did before the install.
 */
export async function passThrough(argv: readonly string[], payload: string, env: Record<string, string | undefined> = process.env): Promise<number> {
  try {
    const child = Bun.spawn([...argv], { stdin: "pipe", stdout: "inherit", stderr: "inherit", env });
    child.stdin.write(payload);
    await child.stdin.end();
    return await child.exited;
  } catch {
    return 0;
  }
}
