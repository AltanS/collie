// THE LOOK OF CHAT, AS A SET OF SWITCHES. A design round, not a setting.
//
// Each field names one idea from the chat look round (experiments/chat-look) and its options. The
// word `today` is what Chat draws now, and `CHAT_LOOK` holds `today` in every field, so a component
// that reads it with no provider above draws exactly what it drew before this file existed. Only
// the playground's "Chat look" section mounts a provider with other words.
//
// Nothing here is an operator preference and nothing persists it. When a word is picked, the pick
// lands in the components as the new default and its switch goes away.

import { createContext, useContext } from "react";

export interface ChatLook {
  /** A. The air between turns and inside one. `rule` adds a hairline above each user turn. */
  readonly rhythm: "today" | "airy" | "rule";
  /** B. The person's own turn. */
  readonly userTurn: "today" | "time-end" | "hug" | "neutral";
  /** C. A small agent mark at the start of each agent run. Chat draws none today. */
  readonly agentHead: "today" | "icon-time";
  /** D. How a run of tool steps is framed. */
  readonly steps: "today" | "quiet" | "ground" | "rail";
  /** E. A fenced code block. */
  readonly code: "today" | "neutral" | "neutral-12";
  /** F. A Markdown table. */
  readonly table: "today" | "rules" | "bands";
  /** G. The size of agent prose, and its headings. */
  readonly prose: "today" | "15" | "15-headings";
  /** H. Notices, the compaction line and the top-of-thread line. */
  readonly quiet: "today" | "divided";
  /** I. Inline code chips. */
  readonly chip: "today" | "neutral";
  /** J. The stream's side gutter. */
  readonly gutter: "today" | "16";
  /** K. A tool card's kind word in its head row. */
  readonly cardLabel: "today" | "muted";
}

export const CHAT_LOOK: ChatLook = {
  rhythm: "today",
  userTurn: "today",
  agentHead: "today",
  steps: "today",
  code: "today",
  table: "today",
  prose: "today",
  quiet: "today",
  chip: "today",
  gutter: "today",
  cardLabel: "today",
};

export const ChatLookContext = createContext<ChatLook>(CHAT_LOOK);

export function useChatLook(): ChatLook {
  return useContext(ChatLookContext);
}
