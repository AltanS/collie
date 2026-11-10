// "Chat look": quick wins for the look of Chat, each idea beside today's look. Nothing here ships.
//
// Every option mounts the REAL `SessionStream` over one of five threads (chat-look-fixtures.ts) and differs
// from option 0 only by the words it hands `ChatLookContext` (lib/chat-look.ts). Option 0 hands the context
// nothing, so it draws exactly what the app draws. One Case switch, shared by every round, picks the thread
// for all of them at once. Light and dark follow the page's own Theme switch.
//
// DEV-ONLY, unreachable from the app entry.

import { useEffect, useRef, useState, type ReactNode } from "react";

import { SessionStream } from "@/components/session-stream";
import type { ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import type { ChatFeed } from "@/hooks/use-chat-window";
import { CHAT_LOOK, ChatLookContext, type ChatLook } from "@/lib/chat-look";
import { EMPTY_CHAT_WINDOW } from "@/lib/chat-window";
import { addPending, dropPending } from "@/lib/durable-pending";

import { Section, type SectionDef } from "../layout";
import { Round, type RoundOption } from "../round";
import { CHAT_LOOK_CASES, CHAT_LOOK_THREADS, WAITING_PENDING, type ChatLookCase } from "./chat-look-fixtures";

export const DEF: SectionDef = { id: "chat-look", title: "Chat look" };

const NO_OLDER = () => {};

function feedOf(c: ChatLookCase): ChatFeed {
  return {
    window: { ...EMPTY_CHAT_WINDOW, status: { kind: "live" }, rev: 1, entries: CHAT_LOOK_THREADS[c] },
    loadOlder: NO_OLDER,
    loadingOlder: false,
    asked: 1,
    answered: 1,
    tried: true,
  };
}

/** One phone's stream. `address` is the stream's own key, for its scroll memory and its pending line. */
function Stream({ address, caseValue, look }: { address: string; caseValue: ChatLookCase; look?: ChatLook }) {
  const listRef = useRef<ChatMessageListHandle>(null);
  const key = `${address}:${caseValue}`;
  // Case 5's pending line lives in the store the composer fills (lib/durable-pending.ts), so it goes in the same way.
  useEffect(() => {
    if (caseValue !== "waiting") return;
    addPending(key, { ...WAITING_PENDING, at: Date.now(), state: "sending" });
    return () => dropPending(key, [WAITING_PENDING.requestId]);
  }, [key, caseValue]);
  const stream = (
    <div className="relative min-h-0 flex-1">
      <div className="absolute inset-0">
        <SessionStream
          key={key}
          feed={feedOf(caseValue)}
          address={key}
          working={false}
          showToolCalls
          showCompactions={false}
          fontSize={14}
          listRef={listRef}
          agent="claude"
        />
      </div>
    </div>
  );
  if (look === undefined) return stream;
  return <ChatLookContext.Provider value={look}>{stream}</ChatLookContext.Provider>;
}

interface IdeaOption {
  readonly title: string;
  readonly look: Partial<ChatLook>;
}

interface Idea {
  readonly id: string;
  readonly title: string;
  readonly options: readonly IdeaOption[];
}

/** The pick for round Z, built from the rounds above it. */
const RECOMMENDED: Partial<ChatLook> = {
  rhythm: "airy",
  userTurn: "time-end",
  steps: "quiet",
  code: "neutral",
  table: "rules",
  prose: "15",
  quiet: "divided",
  gutter: "16",
  cardLabel: "muted",
};

const IDEAS: readonly Idea[] = [
  {
    id: "a",
    title: "A. Turn rhythm",
    options: [
      { title: "More air between turns", look: { rhythm: "airy" } },
      { title: "Air and a rule", look: { rhythm: "rule" } },
    ],
  },
  {
    id: "b",
    title: "B. Your turn",
    options: [
      { title: "No caption, time inline", look: { userTurn: "time-end" } },
      { title: "Hugs its text, right", look: { userTurn: "hug" } },
      { title: "Neutral well, orange icon", look: { userTurn: "neutral" } },
    ],
  },
  { id: "c", title: "C. Agent mark", options: [{ title: "Agent icon and time", look: { agentHead: "icon-time" } }] },
  {
    id: "d",
    title: "D. Tool steps",
    options: [
      { title: "Fold rows lose border", look: { steps: "quiet" } },
      { title: "One shared ground", look: { steps: "ground" } },
      { title: "Steps on a rail", look: { steps: "rail" } },
    ],
  },
  {
    id: "e",
    title: "E. Code blocks",
    options: [
      { title: "Neutral ground", look: { code: "neutral" } },
      { title: "Neutral at 12 px", look: { code: "neutral-12" } },
    ],
  },
  {
    id: "f",
    title: "F. Tables",
    options: [
      { title: "Rules only, muted header", look: { table: "rules" } },
      { title: "Rules and row bands", look: { table: "bands" } },
    ],
  },
  {
    id: "g",
    title: "G. Prose size",
    options: [
      { title: "Prose at 15 px", look: { prose: "15" } },
      { title: "15 px, larger headings", look: { prose: "15-headings" } },
    ],
  },
  { id: "h", title: "H. Quiet lines", options: [{ title: "Text between hairlines", look: { quiet: "divided" } }] },
  { id: "i", title: "I. Inline code", options: [{ title: "Neutral chips", look: { chip: "neutral" } }] },
  { id: "j", title: "J. Side gutter", options: [{ title: "16 px gutter", look: { gutter: "16" } }] },
  { id: "k", title: "K. Card labels", options: [{ title: "Muted kind word", look: { cardLabel: "muted" } }] },
  { id: "z", title: "Z. All together", options: [{ title: "Recommended set", look: RECOMMENDED }] },
];

/** The Round hands its case back as a plain string; this finds it among the five, or the first. */
function caseOf(value: string): ChatLookCase {
  return CHAT_LOOK_CASES.find((c) => c.value === value)?.value ?? CHAT_LOOK_CASES[0].value;
}

/** Each option's whole look, built once, so a context value never changes identity under a render. */
const LOOKS = new Map(IDEAS.map((idea) => [idea.id, idea.options.map((o): ChatLook => ({ ...CHAT_LOOK, ...o.look }))]));

function optionsOf(idea: Idea): RoundOption[] {
  const looks = LOOKS.get(idea.id) ?? [];
  const today: RoundOption = {
    n: 0,
    title: "Today",
    render: ({ caseValue }) => <Stream address={`pg-chat-look-${idea.id}-0`} caseValue={caseOf(caseValue)} />,
  };
  return [
    today,
    ...idea.options.map((o, i): RoundOption => ({
      n: i + 1,
      title: o.title,
      render: ({ caseValue }) => (
        <Stream address={`pg-chat-look-${idea.id}-${String(i + 1)}`} caseValue={caseOf(caseValue)} look={looks[i]} />
      ),
    })),
  ];
}

function RoundTitle({ children }: { children: ReactNode }) {
  return <h3 className="mt-8 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground first:mt-4">{children}</h3>;
}

export function ChatLookSection() {
  const [caseValue, setCaseValue] = useState<string>(CHAT_LOOK_CASES[0].value);
  return (
    <Section def={DEF}>
      {IDEAS.map((idea) => (
        <div key={idea.id} data-pg-chat-look="">
          <RoundTitle>{idea.title}</RoundTitle>
          <Round
            id={`chat-look-${idea.id}`}
            cases={CHAT_LOOK_CASES}
            caseValue={caseValue}
            onCaseChange={setCaseValue}
            options={optionsOf(idea)}
            frame={{ kind: "phone", height: 1120 }}
          />
        </div>
      ))}
    </Section>
  );
}
