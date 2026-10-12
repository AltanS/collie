// The scripted model of the example: Pi's faux provider, answering from a script, so the program needs no key.
// The local app (app.ts) and the Cloudflare example (../durable-member-cloudflare) both use it, so both show the
// same ticket. It imports pi-ai only, no runtime module, so it runs in Bun and in a Worker.

import type { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

export const INSTRUCTIONS = "You triage support tickets.";
/** For a real model, which does not read the script: the same steps, asked for in words. */
export const REAL_INSTRUCTIONS =
  "You triage support tickets. For every ticket: first call write_note with a one-sentence note, then call spawn_helper with a task that starts with 'HELPER:' and asks a helper to name the likely cause, then answer in one sentence.";

export interface ScriptTiming {
  /** The pause before each scripted answer, so states are visible. */
  stepMs: number;
  /** The slow answer to a follow-up, long enough to stop it. */
  slowMs: number;
  /** The helper's answer. Default: `stepMs`. */
  helperMs?: number;
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    if (ms <= 0 || signal?.aborted) return done();
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), done()), { once: true }); // no throw: the stream sees the abort
  });

type Msg = { role: string; content: unknown; toolName?: string; isError?: boolean };
const textOf = (c: unknown) =>
  typeof c === "string" ? c : (c as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text).join("");

/**
 * The script, read from the transcript, so it holds after a restart too:
 *   ticket -> write_note -> spawn_helper -> final text. A later user input -> a slow text.
 *   A first user message that starts with "HELPER:" is the helper, and it only answers.
 */
function scripted(messages: Msg[], slowMs: number, helperMs?: number) {
  const last = messages.at(-1)!;
  const first = messages.find((m) => m.role === "user");
  if (first && textOf(first.content).startsWith("HELPER:")) {
    return { msg: fauxAssistantMessage([fauxText("Probably an expired session cookie after the password reset.")]), slow: false, ms: helperMs };
  }
  if (first && textOf(first.content).startsWith("TWO:")) {
    // Two risky calls in ONE assistant message, then one final text once both results are in.
    if (last.role !== "toolResult") {
      const calls = ["first", "second"].map((n) => fauxToolCall("write_note", { note: `Two notes: ${n}` }));
      return { msg: fauxAssistantMessage(calls, { stopReason: "toolUse" }), slow: false };
    }
    const saved = messages.filter((m) => m.role === "toolResult" && !m.isError).length;
    return { msg: fauxAssistantMessage([fauxText(`Both notes handled, ${saved} saved.`)]), slow: false };
  }
  if (last.role === "toolResult" && last.toolName === "write_note") {
    if (last.isError) return { msg: fauxAssistantMessage([fauxText("The note was not saved. I stop here.")]), slow: false };
    const call = fauxToolCall("spawn_helper", { task: "HELPER: name the likely cause of the login failure in one sentence." });
    return { msg: fauxAssistantMessage([call], { stopReason: "toolUse" }), slow: false };
  }
  if (last.role === "toolResult" && last.toolName === "spawn_helper") {
    return { msg: fauxAssistantMessage([fauxText(`Triage done. The helper says: ${textOf(last.content)}`)]), slow: false };
  }
  const answered = messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes('"type":"text"'));
  if (last.role === "user" && answered) {
    const long = "Another thought, in detail. ".repeat(40);
    return { msg: fauxAssistantMessage([fauxText(long)]), slow: true, slowMs };
  }
  const call = fauxToolCall("write_note", { note: "Ticket 412: login failure after password reset." });
  return { msg: fauxAssistantMessage([call], { stopReason: "toolUse" }), slow: false };
}

/**
 * Put the scripted model on `models` as provider `faux`, model `faux-1`. The factory re-queues itself, because
 * faux answers from a queue and has no catch-all. Several copies are queued so two parallel calls never find it
 * empty.
 */
export function useScriptedModel(models: ReturnType<typeof createModels>, t: ScriptTiming) {
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const factory: FauxResponseFactory = async (context, options) => {
    faux.appendResponses([factory]);
    const step = scripted(context.messages as unknown as Msg[], t.slowMs, t.helperMs);
    await sleep(step.slow ? t.slowMs : (step.ms ?? t.stepMs), options?.signal);
    return step.msg;
  };
  faux.setResponses(Array.from({ length: 16 }, () => factory));
}
