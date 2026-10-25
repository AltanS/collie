import type { HoldDecision } from "../web/src/lib/surface/hold.ts";
import { cleanShown } from "../web/src/lib/surface/hold.ts";
import { asJsonObject, asJsonString, parseJsonObject } from "../web/src/lib/json.ts";

// THE PERMISSION BROKER (`collie codex-hook`, event PermissionRequest).
//
// Codex runs EVERY matching PermissionRequest handler, waits for all of them, and lets any deny win
// (rust-v0.164.0 codex-rs/hooks/src/events/permission_request.rs). Two independent remote-approval
// handlers would therefore each hold the turn for the other's answer, and a late "no" from either one
// would overrule a "yes" the person already gave on the other. So when Collie and another provider
// both answer from a phone, there is ONE handler: this broker. It starts both at once and obeys these
// rules. It is the GENERIC contract for a provider that returns a decision and withdraws its request:
// moshi-hook 0.4.37 is neither (cli/codex-moshi.ts, issue #595), so nothing runs it as one today.
//
//  1. The FIRST VALID allow or deny wins, exactly once. Everything after it is ignored.
//  2. The loser is WITHDRAWN, not merely abandoned: a Collie hold is told "answered elsewhere" and a
//     provider is asked to cancel its pending remote request, and the broker waits (a few seconds,
//     bounded) for the provider to confirm it ended. Codex kills a hook's whole process group when
//     the hook ends, so a provider that is only abandoned never gets to withdraw.
//  3. Anything that is not a clean answer is NO DECISION, and no decision prints `{}`: Codex then asks
//     the person the way it always did. A provider that exits non-zero, prints nothing, prints
//     something else, asks for an input rewrite, or says `interrupt` is no decision. An error, an
//     offline bridge and a missed deadline are no decision. The broker NEVER decides by itself.
//  4. The output is built here from the decision, never copied from a provider: no `updatedInput`, no
//     `updatedPermissions`, no `interrupt` (Codex fails closed on all three) can leave this process.
//  5. The deadline is 290 s, inside the 300 s hook timeout, so the cancel and the print always fit.
//
// The two halves are seams (`ProviderRun`, `HoldRun`), so every ordering is tested with no process
// and no socket. The provider's withdrawal is a CAPABILITY that has to be proven against the real
// provider before it is relied on: cli/codex-moshi.ts holds the gate.

/** The most ms the broker waits for a decision: the profile's `hold.limitMs`. */
export const BROKER_DEADLINE_MS = 290_000;

/** The most ms the broker waits for a loser to confirm it ended. Codex's kill comes at the hook's end. */
export const CANCEL_GRACE_MS = 3000;

/** What a provider handler printed, and how it ended. */
export interface ProviderEnd {
  readonly exitCode: number | null;
  readonly stdout: string;
}

/** How a provider's cancellation ended: it exited after the request, it had to be killed, or it was over already. */
export type CancelOutcome = "exited" | "killed" | "already-ended";

/** A provider handler (Moshi) that was started with the unchanged payload. */
export interface ProviderRun {
  /** Settles once, when the provider ends on its own. Never rejects. */
  readonly settled: Promise<ProviderEnd>;
  /** Asks the provider to withdraw its pending request and end; resolves with how it ended within `graceMs`. Never rejects. */
  cancel(graceMs: number): Promise<CancelOutcome>;
}

/** A Collie hold on the local bridges. */
export interface HoldRun {
  /** Settles once: a person's decision, or null (closed, offline, released, or at its limit). Never rejects. */
  readonly settled: Promise<HoldDecision | null>;
  /** Tells the bridges another answer won ("answered elsewhere") and closes. Idempotent. */
  cancel(): void;
}

export interface BrokerDeps {
  /** Starts the provider. Null: there is none. */
  startProvider(): ProviderRun | null;
  /** Starts the hold. Null: this request cannot be held (no pane, no bridge, cut input). */
  startHold(): HoldRun | null;
  /** Runs `run` after `ms`; returns its cancel. */
  after(ms: number, run: () => void): () => void;
  /** The message a deny carries when the voice that denied gave none. */
  readonly denyMessage: string;
  readonly deadlineMs?: number;
  readonly graceMs?: number;
}

export type Voice = "provider" | "collie";

export interface BrokerResult {
  /** The line to print: a decision, or `{}`. */
  readonly output: string;
  readonly decision: HoldDecision | null;
  readonly winner: Voice | null;
  /** Why there is no decision, when there is none. */
  readonly why: "answered" | "no-answer" | "deadline" | "aborted" | "no-voices";
  /** How the provider's withdrawal ended, when it lost or the request ended without an answer. */
  readonly providerCancel: CancelOutcome | null;
  /** Whether the hold was told to stand down. */
  readonly holdCancelled: boolean;
}

/** The output of no decision: Codex asks the person as usual. */
export const NO_DECISION_OUTPUT = "{}";

/** The hook output for a decision, built from the decision alone. */
export function decisionLine(decision: HoldDecision, message: string | null): string {
  const body = decision === "deny" && message !== null ? { behavior: decision, message } : { behavior: decision };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: body } });
}

/** The longest deny message kept. A provider's own words are shown to the model, so they are bounded and cleaned. */
const MESSAGE_MAX = 500;

/** What a provider's output means: a decision (and its message), or null. */
export function providerDecision(end: ProviderEnd): { readonly decision: HoldDecision; readonly message: string | null } | null {
  if (end.exitCode !== 0) return null;
  const node = parseJsonObject(end.stdout.trim());
  if (node === undefined) return null;
  // Only the decision and a message for the person. Anything else is a request this broker will not
  // translate (`continue: false`, a rewritten input), so the provider's whole answer is set aside.
  if (Object.keys(node).some((key) => key !== "hookSpecificOutput" && key !== "systemMessage")) return null;
  if (node.hookSpecificOutput === undefined) return null;
  const specific = asJsonObject(node.hookSpecificOutput);
  if (specific === undefined || specific.hookEventName !== "PermissionRequest") return null;
  if (Object.keys(specific).some((key) => key !== "hookEventName" && key !== "decision")) return null;
  const body = asJsonObject(specific.decision);
  if (body === undefined) return null;
  if (Object.keys(body).some((key) => key !== "behavior" && key !== "message")) return null;
  const behavior = body.behavior;
  if (behavior !== "allow" && behavior !== "deny") return null;
  const raw = body.message === undefined ? undefined : asJsonString(body.message);
  if (body.message !== undefined && raw === undefined) return null;
  const message = raw === undefined ? null : cleanShown(raw).slice(0, MESSAGE_MAX).trim();
  return { decision: behavior, message: message === "" ? null : message };
}

/**
 * Runs the broker. Resolves once, with the line to print. `signal` is the process's own end (SIGTERM,
 * SIGHUP: Codex timing the hook out or the turn interrupted): no decision, both voices withdrawn.
 */
export function brokerPermission(deps: BrokerDeps, signal?: AbortSignal): Promise<BrokerResult> {
  const grace = deps.graceMs ?? CANCEL_GRACE_MS;
  const provider = deps.startProvider();
  const hold = deps.startHold();
  if (provider === null && hold === null) {
    return Promise.resolve({ output: NO_DECISION_OUTPUT, decision: null, winner: null, why: "no-voices", providerCancel: null, holdCancelled: false });
  }
  const { promise, resolve } = Promise.withResolvers<BrokerResult>();
  let done = false;
  let providerOpen = provider !== null;
  let holdOpen = hold !== null;
  let cancelDeadline: (() => void) | null = null;

  const finish = async (decision: HoldDecision | null, message: string | null, winner: Voice | null, why: BrokerResult["why"]): Promise<void> => {
    if (done) return;
    done = true;
    cancelDeadline?.();
    signal?.removeEventListener("abort", onAbort);
    // The hold stands down at once; the provider is asked and given a moment to confirm.
    const holdStand = hold !== null && winner !== "collie";
    if (holdStand) hold.cancel();
    const providerCancel = provider !== null && winner !== "provider" ? await provider.cancel(grace).catch((): CancelOutcome => "killed") : null;
    const output = decision === null ? NO_DECISION_OUTPUT : decisionLine(decision, decision === "deny" ? (message ?? deps.denyMessage) : null);
    resolve({ output, decision, winner, why, providerCancel, holdCancelled: holdStand });
  };

  const noneLeft = (): void => {
    if (!providerOpen && !holdOpen) void finish(null, null, null, "no-answer");
  };

  function onAbort(): void {
    void finish(null, null, null, "aborted");
  }
  if (signal?.aborted === true) {
    onAbort();
    return promise;
  }
  signal?.addEventListener("abort", onAbort, { once: true });

  cancelDeadline = deps.after(deps.deadlineMs ?? BROKER_DEADLINE_MS, () => void finish(null, null, null, "deadline"));

  void (async () => {
    const end = await provider?.settled;
    if (end === undefined) return;
    providerOpen = false;
    const verdict = providerDecision(end);
    if (verdict !== null) await finish(verdict.decision, verdict.message, "provider", "answered");
    else noneLeft();
  })();
  void (async () => {
    const decision = await hold?.settled;
    if (decision === undefined) return;
    holdOpen = false;
    if (decision !== null) await finish(decision, null, "collie", "answered");
    else noneLeft();
  })();
  return promise;
}
