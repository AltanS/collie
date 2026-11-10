// THE LOOK OF CHAT, AS A SET OF SWITCHES. A design round that landed.
//
// `CHAT_LOOK` is the look Chat draws since 1.29.0, and every component that reads it with no provider
// above draws exactly that. The word `today` in a field names the drawing Chat had BEFORE 1.29.0, and
// `CHAT_LOOK_BEFORE` holds it in every field. The switch object remains for one reason: the playground's
// "Chat look" section mounts a provider so the two looks, and each word between them, can be shown side
// by side. Nothing else reads a word other than the default.
//
// Nothing here is an operator preference and nothing persists it.

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

/** The look Chat draws since 1.29.0. Four fields stay `today`: the operator did not pick a word for them. */
export const CHAT_LOOK: ChatLook = {
  rhythm: "airy",
  userTurn: "hug",
  agentHead: "today",
  steps: "ground",
  code: "neutral-12",
  table: "today",
  prose: "today",
  quiet: "divided",
  chip: "today",
  gutter: "today",
  cardLabel: "muted",
};

/** The look before 1.29.0, every field `today`. For the playground's compare only; no component defaults to it. */
export const CHAT_LOOK_BEFORE: ChatLook = {
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
