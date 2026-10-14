// An approval in one call (WIRE.md 7.3 and 7.14). `requireApproval` asks the phone whether a tool call may run, and
// builds the card from what the call IS: the tool's name and a JSON view of its arguments. Never from the model's own
// words about the call: a model that wants a yes would describe the call kindly, and the card must show what runs.
// No runtime import, like the rest of core/.

import { AskClosed, askIdFor, type PaneHandle } from "./layout.ts";
import { CAPS, cut, isRecord, safeId } from "./rules.ts";
import type { DecidedBy, Json, PermissionAskInput } from "./types.ts";

/** The arguments of a call in one line, as `name(key: value, key: value)`, each value as JSON, cut to `max` bytes. */
export function callSummary(name: string, args: Json | undefined, max: number = CAPS.summary): string {
  return cut(`${name}(${argumentsView(args)})`, max);
}

/**
 * The arguments as the card shows them: an object as `key: value` pairs with each value as JSON, anything else as its
 * JSON. A value JSON cannot write (a cycle, a bigint) reads `(cannot be shown)`, never something softer.
 */
export function argumentsView(args: Json | undefined): string {
  try {
    if (isRecord(args)) {
      return Object.entries(args)
        .map(([key, value]) => `${key}: ${JSON.stringify(value) ?? "undefined"}`)
        .join(", ");
    }
    return args === undefined ? "" : (JSON.stringify(args) ?? "");
  } catch {
    return "(cannot be shown)";
  }
}

export interface ApprovalOptions {
  /** The pane that asks: the conversation the call belongs to. */
  pane: PaneHandle;
  /**
   * The tool call's own id, the same across a restart, so the ask keeps its id and an answer sent across a restart
   * lands (WIRE.md section 6). Any string: one that breaks the id rule is made safe.
   */
  toolCallId: string;
  /** The item the card sits under, usually the tool call's item. Default: the tool call id. */
  itemId?: string;
  /** How long the phone has, in milliseconds. Past it the ask closes as decided by `timeout` and the call is denied. */
  timeoutMs?: number;
  /** Abort it from the program's side: the ask closes as decided by the program and the call is denied. */
  signal?: AbortSignal;
  /** The two buttons' words. Default "Allow" and "Deny". */
  labels?: { allow?: string; deny?: string };
}

/** What the phone, the program or the clock decided, with the receipt: who and when. */
export interface Approval {
  readonly approved: boolean;
  readonly decidedBy: DecidedBy;
  /** ISO 8601. */
  readonly decidedAt: string;
  /** The ask's id on the wire, for the program's own record. */
  readonly askId: string;
}

/**
 * Ask the phone whether `toolName` may run with `args`, wait, and return the decision. The card's title is
 * "<toolName> wants to run", its tool line is the call as `toolName(key: value, ...)`, and the push says
 * "<toolName> needs a yes". Nothing on it comes from the model's prose. A deny, a timeout, a stop and an abort all
 * return `approved: false`; only Allow from the phone returns true.
 */
export async function requireApproval(toolName: string, args: Json | undefined, o: ApprovalOptions): Promise<Approval> {
  const name = cut(toolName, CAPS.toolName).trim();
  if (name === "") throw new TypeError("requireApproval needs the tool's name: the card is built from it");
  const toolCallId = safeId(o.toolCallId);
  const summary = callSummary(name, args);
  const shown = `${name}(${argumentsView(args)})`;
  const expiresAt = o.timeoutMs === undefined ? undefined : new Date(Date.now() + o.timeoutMs);
  const input: PermissionAskInput = {
    kind: "permission",
    toolCallId,
    itemId: o.itemId === undefined ? toolCallId : safeId(o.itemId),
    title: `${name} wants to run`,
    tool: { kind: "other", name, summary },
    push: { title: `${name} needs a yes`, line: summary },
    options: [
      { id: "allow", label: o.labels?.allow ?? "Allow", effect: "allow" },
      { id: "deny", label: o.labels?.deny ?? "Deny", effect: "deny" },
    ],
  };
  // The card says "Text shortened" when the person cannot see the whole call.
  if (summary !== shown) input.cleaned = true;
  if (expiresAt !== undefined) input.expiresAt = expiresAt;
  const pending = o.pane.ask(input, o.signal === undefined ? {} : { signal: o.signal });
  const askId = askIdFor(o.pane.id, toolCallId);
  try {
    const answer = await pending;
    const outcome = o.pane.outcomeOf(askId);
    return {
      approved: answer.optionId === "allow",
      decidedBy: outcome?.decidedBy ?? "phone",
      decidedAt: outcome?.decidedAt ?? new Date().toISOString(),
      askId,
    };
  } catch (e) {
    if (!(e instanceof AskClosed)) throw e;
    const outcome = o.pane.outcomeOf(askId);
    return { approved: false, decidedBy: e.decidedBy, decidedAt: outcome?.decidedAt ?? new Date().toISOString(), askId };
  }
}
