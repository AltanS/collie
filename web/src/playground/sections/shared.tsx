// Helpers shared by more than one section of the states playground. Split out of app.tsx; see that
// file's header comment for the whole page's rules.

import { useState, type ReactNode } from "react";
import { Keyboard, Settings2, Slash, Terminal, Zap } from "lucide-react";

import type { GeneralAction } from "@/components/actions-row";
import { PhoneFrame } from "../harness";

/**
 * A phone frame that centres itself in its (two-column) card. Route-level components are written for
 * a screen; given a card's width they read as a widget, so they get 390px and their own scrollbar.
 */
export function PhoneFrameCard({ height, children }: { height?: number; children: ReactNode }) {
  return (
    <div className="flex justify-center">
      <PhoneFrame height={height}>{children}</PhoneFrame>
    </div>
  );
}

/**
 * A stub `send()` that accepted the text, which is what drives the harness echo's ✓. Shared because
 * more than one section mounts the real `ActionsRow`: "Actions row", which is about the belt itself,
 * and the belt design rounds, which stage the belt inside a phone-width mock.
 */
export const took = async () => true;

/**
 * One card's phone: 390px wide, or the column's width under the "Phone width" toggle. A BOX, not a
 * screen, and with no fixed height — these cards differ in where a word sits, and a frame that
 * pinned the height would only hide how little the chrome changes.
 *
 * `stage` turns the box into a containing block (`transform`) with its own clip, which is what a
 * `position: fixed` descendant needs to resolve against the card instead of escaping to the page.
 * The pull-up handle round wanted it, for a card that mounted a real `BottomSheet`; that round is
 * gone (2026-09-14 cleanup) and the flag stays for the next one that needs it.
 *
 * Shared because several sections draw the bottom (or the top) of the pane screen this way, and
 * copies of one box drift the way two already started to.
 */
export function PhoneMock({ stage = false, children }: { stage?: boolean; children: ReactNode }) {
  return (
    <div
      className="relative w-[390px] max-w-full overflow-hidden rounded-xl border border-border bg-background"
      style={stage ? { transform: "translate(0)" } : undefined}
    >
      {children}
    </div>
  );
}

/**
 * The chrome block, as `agent-chat.tsx` draws it: ONE surface closed against the terminal above by
 * ONE rule. The class string is copied from `data-slot="chrome-block"` there, because it is not
 * extractable — it is a `<div>` inside a 2,000-line component.
 */
export function ChromeBlock({ children }: { children: ReactNode }) {
  return (
    <div data-slot="chrome-block" className="border-t border-rule bg-chrome">
      {children}
    </div>
  );
}

/**
 * The roomy layout's five general actions, wired to local state so a card behaves: tapping Keys
 * really marks Keys as open. The composer owns these for real; this is the same shape, one card
 * deep — and it is one helper rather than two copies so the belt under a handle idea can never
 * drift from the belt the actions-row section is judging.
 */
export function useRoomyActions(): readonly GeneralAction[] {
  const [open, setOpen] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const toggle = (id: string) => () => setOpen((was) => (was === id ? null : id));
  return [
    { id: "keys", icon: Keyboard, label: "Keys", on: open === "keys", expanded: open === "keys", onSelect: toggle("keys") },
    { id: "type", icon: Terminal, label: "Type into terminal", word: "Type", on: typing, pressed: typing, onSelect: () => setTyping((was) => !was) },
    { id: "quick", icon: Zap, label: "Quick", on: open === "quick", expanded: open === "quick", onSelect: toggle("quick") },
    { id: "agent", icon: Slash, label: "Agent", onSelect: toggle("cmd") },
    { id: "display", icon: Settings2, label: "Display settings", word: "Display", on: open === "display", expanded: open === "display", onSelect: toggle("display") },
  ];
}
