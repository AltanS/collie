// The phone's yes for a durable-harness session (M66), and the phone's send and stop.
//
// `withCollie(open, options)` wraps the opener you hand `resumeWith`. Each open gets a registry of its own: your
// registry's extensions plus a guard bound to that session, because a Pi hook does not learn which session it runs
// in. The guard is rerun-first: the session can be taken over, crash or be resumed on another machine at any point,
// so everything it knows is in the run's journal (`<runId>_collie`), never in this process. A risky call reads the
// journal; appends its `ask` if the journal does not hold one yet; polls the journal (1 s, then up to 5 s apart; a failed read is retried, never a verdict) until
// a terminal record closes the ask; and allows the call only on an `answer` whose option allows it, for the same
// arguments. A timeout, other arguments, a stop, or this process losing the session (`StorageFenced`) deny.
//
// `takeoverControls(open)` is how the route's send and stop reach a session it does not hold: take it over, act on its
// root conversation, let go. Erasable TypeScript only, so Node runs it as it is.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  type Extension,
  type Harness,
  hook,
  type Registry,
  type RegistryReader,
  ToolTask,
} from "@earendil-works/pi-durable";
import { foldJournal, type JournalAsk, type JournalRecord } from "../core/journal.ts";
import { sha256Hex } from "../core/hash.ts";
import { askIdFor } from "../core/layout.ts";
import { HttpError } from "../core/receipts.ts";
import { safeId } from "../core/rules.ts";
import { type RiskWordsFor, toAskSpec } from "../core/ask-policy.ts";
import type { Answer, Ask, Json } from "../core/types.ts";
import type { ControlCall, Controls, JournalPort } from "./route.ts";
import { busyOf, paneIdOfRun, turnIdOf } from "./pi-source.ts";
import { createWorldPort, isStorageFenced, type Opener, type WorldPort, type WorldStorage } from "./world-port.ts";

/** Your opener, with the registry to open the Harness with: `(storage, registry) => Harness.open(storage, { models, registry }, ctx)`. */
export type CollieOpener = (storage: WorldStorage, registry: Registry) => Promise<Harness>;

export interface WithCollieOptions {
  /** Your registry. Each session's registry follows it: what you install or remove later reaches every open session. */
  registry: RegistryReader;
  /** Tool names that need the phone's yes. */
  risky: ReadonlySet<string>;
  /** The words of a call's question, as for `riskGuard`. Left out: "<tool> wants to run", Allow and Deny. */
  words?: RiskWordsFor;
  /** How long the phone has to answer, in ms. Past it the ask closes as `timeout` and the call is blocked. Default: no expiry. */
  timeoutMs?: number;
  /** Called when a question timed out, with the call's tool name and the question's title. */
  onTimeout?: (tool: string, title: string) => void;
  /** The journal to use. Left out: the session's own World (`storage.world`). Tests pass a fake. */
  journal?: (storage: WorldStorage) => JournalPort;
  /** The first and the longest wait between two reads of the journal, in ms. Default 1000 and 5000. */
  pollMs?: { first: number; max: number };
  /** Called when a read of the journal inside the wait failed, with the error and the count of failed reads of this call. The guard reads again at the next wait. */
  onReadError?: (error: Error, count: number) => void;
}

/** The guard's extension name. One per session registry. */
export const GUARD = "collie-guard";

/** Wait `ms`, or less when `signal` aborts. Never rejects. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  const either = AbortSignal.any([signal, AbortSignal.timeout(ms)]);
  if (either.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => either.addEventListener("abort", () => resolve(), { once: true }));
}

/** Does the option this answer names allow the call? Only `allow` does: `allow-always` is off behind a token (WIRE.md 1B). */
function allows(ask: JournalAsk | undefined, answer: Answer): boolean {
  if (ask === undefined || !("optionId" in answer)) return false;
  return ask.ask.options.find((o) => o.id === answer.optionId)?.effect === "allow";
}

/** What the guard decides from the journal, or undefined while the ask is open. */
type Verdict = { allow: true } | { allow: false; reason: string; timedOut?: true };

function verdictOf(records: readonly JournalRecord[], askId: string, argsHash: string): Verdict | undefined {
  const folded = foldJournal(records);
  const winner = folded.winners.get(askId);
  if (winner === undefined) return undefined;
  if (winner.t === "expire") return winner.decidedBy === "program" ? { allow: false, reason: "stopped" } : { allow: false, reason: "timed out", timedOut: true };
  const ask = records.find((r): r is JournalAsk => r.t === "ask" && r.askId === askId);
  if (ask === undefined || ask.argsHash !== argsHash) return { allow: false, reason: "the answer was for other arguments" };
  return allows(ask, winner.answer) ? { allow: true } : { allow: false, reason: "denied from the phone" };
}

/** A tool call as the guard reads it. */
export interface GuardCall {
  id: string;
  name: string;
  arguments?: unknown;
}

/** The session a guard runs in: its id, and whether this process still holds it (`WorldStorage` has both). */
export interface GuardSession {
  readonly sessionId: string;
  readonly isFenced: boolean;
  /** Aborted once the storage writes nothing more: closed, abandoned or fenced. */
  readonly signal: AbortSignal;
}

/**
 * The guard's decision for one risky call, rerun-first: read the journal; append the `ask` if it holds none for this
 * call; poll until a terminal record closes it; allow (undefined) only on an `answer` whose option allows, for the same
 * arguments. Everything else blocks, with the reason. A stop of the call (`stop`) throws, as `riskGuard` does.
 */
export async function askThroughJournal(call: GuardCall, session: GuardSession, journal: JournalPort, o: Pick<WithCollieOptions, "words" | "timeoutMs" | "onTimeout" | "pollMs" | "onReadError">, stop?: AbortSignal): Promise<{ block: string } | undefined> {
  const runId = session.sessionId;
  const poll = o.pollMs ?? { first: 1000, max: 5000 };
  const toolCallId = safeId(call.id);
  const askId = askIdFor(paneIdOfRun(runId), toolCallId);
  // SAFETY: a tool call's arguments are the JSON the model sent.
  const args = call.arguments as Json | undefined;
  const argsHash = sha256Hex(JSON.stringify(args ?? null));
  const spec = toAskSpec({ toolName: call.name, args, words: o.words });
  const signal = stop === undefined ? session.signal : AbortSignal.any([stop, session.signal]);
  const fenced = (): Verdict | undefined => (session.isFenced ? { allow: false, reason: "this process lost the session" } : undefined);

  let records = await journal.readJournal(runId);
  let verdict = fenced() ?? verdictOf(records, askId, argsHash);
  const asked = records.find((r): r is JournalAsk => r.t === "ask" && r.askId === askId);
  let expiresAt = asked?.expiresAt;
  if (verdict === undefined && asked === undefined) {
    // The first run of this call: raise the ask. A rerun finds it in the journal and waits for the same one.
    const openedAt = new Date().toISOString();
    if (o.timeoutMs !== undefined) expiresAt = new Date(Date.now() + o.timeoutMs).toISOString();
    const ask: Ask = { id: askId, kind: "permission", toolCallId, revision: 1, title: spec.title, itemId: toolCallId, options: spec.options, tool: spec.tool, push: spec.push };
    if (expiresAt !== undefined) ask.expiresAt = expiresAt;
    const record: JournalAsk = { t: "ask", askId, toolCallId, argsHash, ask, openedAt };
    if (expiresAt !== undefined) record.expiresAt = expiresAt;
    await journal.appendJournal(runId, record);
  } else if (verdict === undefined && asked !== undefined && asked.argsHash !== argsHash) {
    // A rerun that asks about other arguments: the open ask is not about this call. Close it and refuse.
    await journal.appendJournal(runId, { t: "expire", askId, at: new Date().toISOString(), decidedBy: "program" });
    verdict = { allow: false, reason: "the arguments changed" };
  }

  // The clock closes the ask on its own timer, so a phone that never answers does not keep the call for ever.
  let expiry: ReturnType<typeof setTimeout> | undefined;
  if (verdict === undefined && expiresAt !== undefined) {
    const at = expiresAt;
    expiry = setTimeout(() => {
      if (!session.isFenced) void journal.appendJournal(runId, { t: "expire", askId, at, decidedBy: "timeout" }).catch(() => {});
    }, Math.max(0, Date.parse(at) - Date.now()));
  }
  let failedReads = 0;
  try {
    for (let wait = poll.first; verdict === undefined; wait = Math.min(wait * 2, poll.max)) {
      await sleep(wait, signal);
      verdict = fenced();
      if (verdict !== undefined) break;
      // A stop of the call ends it, as `riskGuard` does: the throw blocks it.
      if (stop?.aborted === true) throw stop.reason ?? new Error("aborted");
      // A read that fails is never a verdict: the World may be down for a moment, and the ask is still open in the
      // journal. Count it, tell the caller, and read again at the next wait. The session and stop signals still end the loop.
      try {
        records = await journal.readJournal(runId);
      } catch (e) {
        failedReads++;
        o.onReadError?.(e instanceof Error ? e : new Error(String(e)), failedReads);
        continue;
      }
      verdict = verdictOf(records, askId, argsHash);
    }
  } finally {
    if (expiry !== undefined) clearTimeout(expiry);
  }
  if (verdict.allow) return undefined;
  if (verdict.timedOut === true) o.onTimeout?.(call.name, spec.title);
  return { block: verdict.reason };
}

/** The guard of one session: an extension whose `beforeTool` asks through the journal. */
function guardFor(storage: GuardSession, journal: JournalPort, o: WithCollieOptions): Extension {
  return defineExtension({
    name: GUARD,
    hooks: [
      hook(ToolTask, {
        beforeTool: (call, _api, ctx) => (o.risky.has(call.name) ? askThroughJournal(call, storage, journal, o, ctx.abortSignal) : undefined),
      }),
    ],
  });
}

/**
 * A registry of one session: every extension of `base`, in its order, then the guard, kept in step with `base`.
 * The returned `read` says whether the opener read it at all, so an opener that ignored it fails closed.
 */
interface SessionRegistry {
  registry: Registry;
  /** Did the opener read the registry (a snapshot or a subscription)? */
  read: () => boolean;
  /** Stop following the program's registry. */
  stop: () => void;
}

function sessionRegistry(base: RegistryReader, guard: Extension): SessionRegistry {
  const own = createRegistry();
  let names: string[] = [];
  const sync = () => {
    const now = base.snapshot().installed().filter((e) => e.name !== GUARD);
    for (const name of names) if (!now.some((e) => e.name === name)) own.uninstall({ name });
    own.uninstall(guard);
    for (const e of now) own.install(e);
    own.install(guard);
    names = now.map((e) => e.name);
  };
  sync();
  const stop = base.subscribe(sync);
  let read = false;
  const registry: Registry = {
    install: (e) => own.install(e),
    uninstall: (e) => own.uninstall(e),
    snapshot: () => {
      read = true;
      return own.snapshot();
    },
    subscribe: (listener) => {
      read = true;
      return own.subscribe(listener);
    },
  };
  return { registry, read: () => read, stop };
}

/**
 * Wrap your opener so every session it opens asks the phone before a risky call. Hand the result to `resumeWith`, and
 * open sessions with it everywhere (`acquireHarness(id, opener)`, `collieRoute({ open: opener })`):
 *
 * ```ts
 * export const open = resumeWith(withCollie((storage, registry) => Harness.open(storage, { models, registry }, ctx), { registry, risky }));
 * ```
 */
export function withCollie(open: CollieOpener, o: WithCollieOptions): Opener {
  return async (storage) => {
    const journal = o.journal?.(storage) ?? createWorldPort({ world: storage.world });
    const { registry, read, stop } = sessionRegistry(o.registry, guardFor(storage, journal, o));
    let harness: Harness;
    try {
      harness = await open(storage, registry);
    } catch (e) {
      stop();
      throw e;
    }
    if (!read()) {
      stop();
      await harness.close(BACKGROUND_CONTEXT).catch(() => {});
      throw new Error("collie: the opener did not open the Harness with the registry withCollie gave it, so no call would ask the phone");
    }
    storage.signal.addEventListener("abort", stop, { once: true });
    return harness;
  };
}

export interface TakeoverOptions {
  /** The World port. Left out: one on the environment's World, with `open`. */
  port?: WorldPort;
}

/**
 * The route's default controls: send and stop by taking the session over for the act. A send is taken only while the
 * session is idle (Pi has no way to tell a taken-over turn to steer). A stop aborts the root conversation; the route then
 * closes every question its turn left open, as decided by the program.
 */
export function takeoverControls(open: Opener, o: TakeoverOptions = {}): Controls {
  const port = o.port ?? createWorldPort({ open });
  const ctx = BACKGROUND_CONTEXT;

  /** Take the session, check the turn is still the one the phone saw, act, let go. */
  async function withSession(call: ControlCall, act: (harness: Harness, busy: boolean) => Promise<void>) {
    const lease = await port.openHarness(call.journal);
    try {
      const view = await port.readSession(call.journal);
      if (turnIdOf(view) !== call.turnId) throw new HttpError(409, "stale");
      await act(lease.harness, busyOf(view));
    } catch (e) {
      if (e instanceof Error && isStorageFenced(e)) throw new HttpError(409, "stale");
      throw e;
    } finally {
      await lease.release();
    }
  }

  return {
    async send(call) {
      await withSession(call, async (harness, busy) => {
        if (busy) throw new HttpError(409, "stale");
        const root = await harness.root(ctx);
        await root.submit({ type: "input", content: call.text, requestId: call.requestId, whenBusy: "followUp" }, ctx);
      });
    },
    async abort(call) {
      // The route closes the turn's open questions after this, as decided by the program (WIRE.md A.2).
      await withSession(call, async (harness) => {
        const root = await harness.root(ctx);
        await root.abort(ctx);
      });
    },
  };
}
