// The demo of the example: a small online shop's support desk, and Pi's faux provider answering from a script, so
// the program needs no key. The local app (app.ts) and the Cloudflare example (../../experiments/durable-member-cloudflare) both use
// it, so both show the same tickets. It imports pi-ai only, no runtime module, so it runs in Bun and in a Worker.
//
// Every word a person reads on the phone comes from here: the customers, the three kinds of ticket the New page
// starts, the note the program asks to save, the look-up it hands to a helper, and its answers.

import type { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

export const INSTRUCTIONS = "You answer support tickets for a small online shop.";
/** For a real model, which does not read the script: the same steps, asked for in words. */
export const REAL_INSTRUCTIONS =
  "You answer support tickets for a small online shop. For every ticket: first call write_note with a one-sentence note, then call spawn_helper with a task that starts with 'Look-up for <the customer's name>.' and asks one question, then answer in one or two sentences.";

// ── The desk ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The customers, in the order new tickets take them. */
export const CUSTOMERS = ["Maria Lopez", "Jonas Berg", "Priya Shah", "Tom Becker", "Aiko Sato", "Lena Novak"] as const;

/** The customer of a new ticket, from the program's own count, so a restart names it the same way. */
export const customerFor = (n: number): string => CUSTOMERS[(((n - 1) % CUSTOMERS.length) + CUSTOMERS.length) % CUSTOMERS.length]!;

/** The kinds of ticket the New page starts, one starter each. */
export type CaseId = "sign-in" | "double-charge" | "new-address";

export interface Case {
  /** The starter's label on the New page. */
  starter: string;
  /** The line under the conversation's title. */
  topic: string;
  /** What the customer wrote. */
  body: string;
}

export const CASES: Record<CaseId, Case> = {
  // The full run: a note to save (a yes or a no), a look-up by a helper, and an answer with next steps.
  "sign-in": {
    starter: "Sign-in problem",
    topic: "Can't sign in after a password reset",
    body: "I reset my password this morning, and now the app keeps saying my session expired. Can you help?",
  },
  // Questions: a note to save, then which team takes it (a choice), then what to tell the customer (a line).
  "double-charge": {
    starter: "Double charge",
    topic: "Charged twice for one order",
    body: "I was charged twice for order 5521. Please refund one of the two payments.",
  },
  // Two notes at once: two questions on the phone at the same time.
  "new-address": {
    starter: "Address change",
    topic: "New delivery address for two orders",
    body: "I moved last week. Please send my two open orders to my new address.",
  },
};

export const CASE_IDS = Object.keys(CASES) as CaseId[];

/** The first message of a ticket: the customer's own words, with their name in front. */
export const ticketText = (kind: CaseId, customer: string): string => `${customer} writes: ${CASES[kind].body}`;

/** The task a ticket hands to a helper. Its first sentence names the helper's conversation. */
export const lookupTask = (customer: string): string =>
  `Look-up for ${customer}. Why does sign-in fail right after a password reset? Answer in one sentence.`;

/** The helper's answer. */
export const LOOKUP_ANSWER = "The old session cookie on the phone outlived the reset, so the server turns it away.";

/** How the sign-in ticket's answer begins. The answer gets its next steps (a list, a command and a link) under it. */
export const SIGN_IN_DONE = "Found it.";

/** What the program calls a conversation: a title and a line under it, read back from its first message. */
export interface Look {
  title: string;
  subtitle?: string;
}

/**
 * The title and the line under it, from a conversation's first message. A ticket is named after its customer and
 * carries its topic; a helper is named after the customer it looks something up for and carries its question.
 * Anything else (a real model's own words) falls back to a plain name.
 */
export function lookOf(first: string | undefined, helper: boolean): Look {
  const text = (first ?? "").trim();
  const ticket = /^(.{1,60}?) writes: ([\s\S]*)$/.exec(text);
  if (ticket !== null && !helper) {
    const kind = CASE_IDS.find((id) => ticket[2]!.startsWith(CASES[id].body));
    return { title: ticket[1]!, subtitle: kind === undefined ? "Support ticket" : CASES[kind].topic };
  }
  const lookup = /^Look-up for (.{1,60}?)\. ([^?]{1,200}\?)/.exec(text);
  if (lookup !== null) return { title: `Look-up for ${lookup[1]}`, subtitle: lookup[2]! };
  return { title: helper ? "Look-up" : "Support ticket" };
}

/** The words of the question the phone gets before a note is saved: the note itself, with Save and Don't save. */
export function noteAsk(note: string) {
  return {
    title: "Save this note to the ticket?",
    push: { title: "A note needs your OK", line: note.length > 120 ? `${note.slice(0, 117)}...` : note },
    allow: "Save",
    deny: "Don't save",
  };
}

/** The question for the team, a choice. */
export const TEAM_QUESTION = "Which team should take this?";
export const TEAMS = [
  { id: "billing", label: "Billing" },
  { id: "accounts", label: "Accounts" },
  { id: "other", label: "Someone else" },
];
/** The question for the customer's line, a line of text. */
export const REPLY_QUESTION = "What should we tell the customer?";
export const REPLY_PLACEHOLDER = "We are looking into it.";

/**
 * How fast the scripted model writes, in tokens a second. Every answer is streamed at this rate, so a reply grows on
 * the phone while it is written and Stop has a moving reply to cut (WIRE.md 7.15). A token is about four characters.
 */
export const STREAM_TOKENS_PER_SECOND = 60;

/** How the long answer to a follow-up begins. */
export const LONG_ANSWER_START = "Happy to explain.";

// The long answer: a support agent walking a colleague through what happened. Read as written, it is about forty
// seconds of streaming; `longAnswer` cuts it to the time it should take, at a sentence end.
const LONG_SENTENCES = [
  `${LONG_ANSWER_START} When a customer resets a password, every session made with the old password should end.`,
  "The server does its part: it marks the old sessions as done the moment the new password is saved.",
  "The phone app does not hear about that. It keeps the old session cookie and sends it with every request.",
  "The server sees a cookie for a session that is over, and it answers that the session expired.",
  "That is the message the customer sees, and it is true, but it does not say what to do.",
  "Signing in again would fix it, but the app only offers that after the cookie is gone.",
  "So the fix on our side is to end every session of the customer on purpose, on every device.",
  "The next request from the phone then carries no valid cookie at all, and the app shows the sign-in screen.",
  "The customer signs in with the new password, and a fresh session starts.",
  "If the error comes back after that, the next thing to check is the clock on the phone.",
  "A clock that is far off makes a fresh session look expired as well, because the expiry is a time.",
  "Setting the phone to take the time from the network fixes that case.",
  "If neither helps, the ticket goes to the Accounts team with the time of the failed sign-in.",
  "They can read the server's own log for that minute and see which check said no.",
  "That covers every case we have seen this year. Most tickets end at the first step.",
  "For the customer, the short version is: we signed you out everywhere, please sign in once more.",
  "If you like, I can write that reply for you, or add a note to the ticket first.",
];

/** The slow answer to a follow-up: long enough that streaming it at {@link STREAM_TOKENS_PER_SECOND} takes about `slowMs`. */
export function longAnswer(slowMs: number): string {
  const chars = Math.max(1, (STREAM_TOKENS_PER_SECOND * slowMs * 4) / 1000);
  const parts: string[] = [];
  let length = 0;
  for (let i = 0; length < chars || parts.length < 2; i++) {
    const sentence = LONG_SENTENCES[i % LONG_SENTENCES.length]!;
    parts.push(sentence);
    length += sentence.length + 1;
  }
  return parts.join(" ");
}

export interface ScriptTiming {
  /** The pause before each scripted answer, so states are visible. */
  stepMs: number;
  /** How long the slow answer to a follow-up takes to write, long enough to stop it. */
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

/** Which kind of ticket a first message is, or undefined for a helper or a message of a person's own. */
function caseOf(first: string): CaseId | undefined {
  const body = /^.{1,60}? writes: ([\s\S]*)$/.exec(first)?.[1];
  return body === undefined ? undefined : CASE_IDS.find((id) => body.startsWith(CASES[id].body));
}

const say = (text: string) => ({ msg: fauxAssistantMessage([fauxText(text)]), slow: false });
const call = (...calls: ReturnType<typeof fauxToolCall>[]) => ({ msg: fauxAssistantMessage(calls, { stopReason: "toolUse" }), slow: false });

/**
 * The script, read from the transcript, so it holds after a restart too:
 *   sign-in:        write_note -> spawn_helper -> the answer. A later message from the phone -> the long answer.
 *   double-charge:  write_note -> ask_queue (a choice) -> ask_customer (a line) -> the answer.
 *   new-address:    two write_note calls in one message -> the answer.
 *   A first message that starts with "Look-up for" is a helper, and it only answers.
 */
function scripted(messages: Msg[], slowMs: number, helperMs?: number) {
  const last = messages.at(-1)!;
  const firstText = textOf(messages.find((m) => m.role === "user")?.content ?? "");
  if (firstText.startsWith("Look-up for ")) return { ...say(LOOKUP_ANSWER), ms: helperMs };
  const customer = /^(.{1,60}?) writes: /.exec(firstText)?.[1] ?? "the customer";
  const kind = caseOf(firstText) ?? "sign-in";
  const name = last.role === "toolResult" ? last.toolName : undefined;
  const result = (tool: string) => textOf(messages.findLast((m) => m.role === "toolResult" && m.toolName === tool)?.content ?? "");

  if (kind === "double-charge") {
    if (name === "write_note" && last.isError) return say("The note was not saved, so I stopped here.");
    if ((name === "ask_queue" || name === "ask_customer") && last.isError) return say("Nobody answered in time, so I stopped here.");
    if (name === "write_note") return call(fauxToolCall("ask_queue", {}));
    if (name === "ask_queue") return call(fauxToolCall("ask_customer", {}));
    if (name === "ask_customer") return say(`Handed to ${result("ask_queue")}. ${customer} gets your line: "${result("ask_customer")}"`);
    return call(fauxToolCall("write_note", { note: "Order 5521 was charged twice. One payment to refund." }));
  }
  if (kind === "new-address") {
    if (last.role !== "toolResult") {
      return call(
        fauxToolCall("write_note", { note: "Order 5530 ships to the new address." }),
        fauxToolCall("write_note", { note: "Order 5531 ships to the new address." }),
      );
    }
    const saved = messages.filter((m) => m.role === "toolResult" && !m.isError).length;
    return say(saved === 2 ? "Both orders now ship to the new address." : `${saved} of the 2 orders ship to the new address.`);
  }
  if (name === "write_note") {
    if (last.isError) return say("The note was not saved, so I stopped here.");
    return call(fauxToolCall("spawn_helper", { task: lookupTask(customer) }));
  }
  if (name === "spawn_helper") return say(`${SIGN_IN_DONE} ${result("spawn_helper")} Signing out on every device clears it.`);
  const answered = messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes('"type":"text"'));
  if (last.role === "user" && answered) return { msg: fauxAssistantMessage([fauxText(longAnswer(slowMs))]), slow: true };
  return call(fauxToolCall("write_note", { note: "Sign-in fails after a password reset. The old session may still be active." }));
}

/**
 * Put the scripted model on `models` as provider `faux`, model `faux-1`. The factory re-queues itself, because
 * faux answers from a queue and has no catch-all. Several copies are queued so two parallel calls never find it
 * empty.
 */
export function useScriptedModel(models: ReturnType<typeof createModels>, t: ScriptTiming) {
  // The provider writes each answer in chunks at a steady rate, and Pi Durable carries the growing text as it goes.
  const faux = fauxProvider({ tokensPerSecond: STREAM_TOKENS_PER_SECOND, tokenSize: { min: 3, max: 5 } });
  models.setProvider(faux.provider);
  const factory: FauxResponseFactory = async (context, options) => {
    faux.appendResponses([factory]);
    const step = scripted(context.messages as unknown as Msg[], t.slowMs, t.helperMs);
    // The slow answer is slow because it is long (see `longAnswer`), not because it waits before the first word.
    await sleep(("ms" in step ? step.ms : undefined) ?? t.stepMs, options?.signal);
    return step.msg;
  };
  faux.setResponses(Array.from({ length: 16 }, () => factory));
}

// ── What a finished sign-in ticket adds under its answer (WIRE.md 7.13) ─────────────────────────────────────────

/** Next steps, as markdown with a list. */
export const NEXT_STEPS =
  "**Next steps**\n\n- Sign the customer out on every device.\n- Ask them to sign in once more with the new password.\n- Close the ticket when it works.";
/** The command that signs a customer out everywhere, as a code block. */
export const SIGN_OUT_COMMAND = '# sign the customer out on every device\nshopctl sessions revoke --all --customer "$CUSTOMER_ID"';
/** The runbook, as a link. example.com is reserved for examples, so the link goes nowhere real. */
export const RUNBOOK = { href: "https://example.com/runbooks/sign-in-after-reset", label: "Runbook: sign-in after a reset" };
