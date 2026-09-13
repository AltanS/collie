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
 * two sections now mount the real `ActionsRow`: "Actions row", which is about the belt itself, and
 * "Pull-up handle ideas", which puts the belt under every handle it stages.
 */
export const took = async () => true;

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
