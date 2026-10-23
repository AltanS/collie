// The policy that turns a tool call into the question the phone sees: the words, the two buttons, and the call's
// arguments cut to one line the person can read. One place, so a program that asks from a hook in its own process
// (`riskGuard` in `../pi`) and a host that writes the question to a journal and asks from another (spec M66)
// raise the same card for the same call. The card is built from the tool's name and its arguments, never from text the
// model wrote about the call (WIRE.md 7.3). No runtime import, like the rest of core/.

import { argumentsView } from "./approval.ts";
import { isRecord, isText } from "./rules.ts";
import type { Json, PermissionOption, ToolCall } from "./types.ts";

/** A string cut at `n` characters, with `...` when it was longer. */
export const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}...` : s);

/**
 * A tool call's arguments in words: the one text a call carries (a note, a task) as it is, else the call as
 * `name(key: value, key: value)` with each value as JSON. A person reads "Order 5521 was charged twice." where the JSON
 * would say `{"note":"Order 5521 was charged twice."}`, and `refund(order: "5521", amount: 40)` for a call with more.
 * Without a name, the arguments' JSON. Cut at 200 characters.
 */
export function summaryOf(args: Json | undefined, name?: string): string {
  if (isRecord(args)) {
    const values = Object.values(args);
    const first = values[0];
    if (values.length === 1 && isText(first)) return clip(first);
    if (name !== undefined) return clip(`${name}(${argumentsView(args)})`);
  }
  return clip(JSON.stringify(args) ?? "");
}

/** The words of the question a risky call raises: its title, its notification, and the labels of its two buttons. */
export interface RiskWords {
  title: string;
  push: { title: string; line: string };
  allow: string;
  deny: string;
}

/** The words for a call, from its summary. Undefined for a tool: the question names the tool. */
export type RiskWordsFor = (tool: string, summary: string) => RiskWords | undefined;

function defaultWords(tool: string, summary: string): RiskWords {
  return { title: `${tool} wants to run`, push: { title: `${tool} needs a yes`, line: summary }, allow: "Allow", deny: "Deny" };
}

/** The question for one tool call, ready to become a `permission` ask once it has an id and an item. */
export interface AskSpec {
  kind: "permission";
  title: string;
  options: PermissionOption[];
  tool: ToolCall;
  push: { title: string; line: string };
  /** The call's arguments as the card shows them: the one text, or `name(key: value, ...)`, cut at 200 characters. The same text is in `tool.summary`. */
  redactedArgs: string;
}

/**
 * The ask a risky call raises. The arguments go through {@link summaryOf} and nowhere else, so the card and the journal
 * carry the same redacted text. `words` (the program's own) may name the question; left out, or undefined for a tool,
 * the question names the tool: "write_note wants to run", with Allow and Deny.
 */
export function toAskSpec(o: { toolName: string; args: Json | undefined; words?: RiskWordsFor }): AskSpec {
  const summary = summaryOf(o.args, o.toolName);
  const words = o.words?.(o.toolName, summary) ?? defaultWords(o.toolName, summary);
  return {
    kind: "permission",
    title: words.title,
    options: [
      { id: "allow", label: words.allow, effect: "allow" },
      { id: "deny", label: words.deny, effect: "deny" },
    ],
    tool: { kind: "other", name: o.toolName, summary },
    // The words of the notification (WIRE.md section 6). The pane's name goes in front of the title.
    push: words.push,
    redactedArgs: summary,
  };
}
