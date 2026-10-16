// The old path of the Pi Durable helper, kept so the example and its Cloudflare twin import it as before. The helper
// itself is the SDK's Pi entry (`packages/durable-sdk/src/pi/index.ts`), which takes the words a program shows as options. This file
// binds the support desk's words (../script.ts) to it: the summary under a solved ticket, and the two questions.

import {
  askTools as askToolsWith,
  type ConversationLook,
  Mapper as SdkMapper,
  type MapperTarget,
  type PaneLocation,
  PaneRegistry,
  type PiHistoryOptions,
  piHistory as piHistoryWith,
  type ReplyExtras,
  showConversation as showConversationWith,
} from "../../../packages/durable-sdk/src/pi/index.ts";
import { NEXT_STEPS, REPLY_PLACEHOLDER, REPLY_QUESTION, RUNBOOK, SIGN_IN_DONE, SIGN_OUT_COMMAND, TEAM_QUESTION, TEAMS } from "../script.ts";

export * from "../../../packages/durable-sdk/src/pi/index.ts";

/** What a solved ticket adds under its reply: a markdown note with a list, a code block and a link (WIRE.md 7.13). */
export const ticketExtras: ReplyExtras = (text) =>
  text.startsWith(SIGN_IN_DONE)
    ? [
        { key: "todo", item: { kind: "markdown", text: NEXT_STEPS } },
        { key: "cmd", item: { kind: "code", lang: "sh", text: SIGN_OUT_COMMAND } },
        { key: "docs", item: { kind: "link", href: RUNBOOK.href, label: RUNBOOK.label } },
      ]
    : [];

/** The helper's Mapper with the desk's summary on a ticket (a pane that shows progress). */
export class Mapper extends SdkMapper {
  constructor(pane: MapperTarget, registry: PaneRegistry, withProgress: boolean, now: () => number = Date.now) {
    super(pane, registry, withProgress, now, withProgress ? ticketExtras : undefined);
  }
}

/** `showConversation` with the desk's summary on a ticket. */
export const showConversation: typeof showConversationWith = (loc: PaneLocation, ...rest) =>
  showConversationWith(loc.progress === true && loc.extras === undefined ? { ...loc, extras: ticketExtras } : loc, ...rest);

/** `piHistory` with the desk's summary on a ticket, as on the live pane. */
export function piHistory(o: PiHistoryOptions) {
  return piHistoryWith({
    ...o,
    describe: (record, first): ConversationLook => {
      const look = o.describe(record, first);
      return look.progress === true && look.extras === undefined ? { ...look, extras: ticketExtras } : look;
    },
  });
}

/** `askTools` with the desk's two questions. */
export function askTools(o: { panes: PaneRegistry; timeoutMs?: number; onTimeout?: (tool: string, title: string) => void }) {
  return askToolsWith({ ...o, words: { team: { question: TEAM_QUESTION, options: TEAMS }, reply: { question: REPLY_QUESTION, placeholder: REPLY_PLACEHOLDER } } });
}
