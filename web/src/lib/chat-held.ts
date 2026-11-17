import type { ChatWindow } from "@/lib/chat-window";
import { onWipe, type WipeContext } from "@/lib/wipe";
import { paneScopeKey } from "@/lib/scope";

// THE LAST LIVE CHAT WINDOW OF EACH PANE, IN MEMORY, so a pane that is switched to draws its thread in its
// first frame (operator, 2026-11-18: "when I switch session there are some white frames").
//
// A pane view is keyed by pane (`routes/detail.tsx`), so a switch builds the Chat body again, and its window
// (`hooks/use-chat-window.ts`) used to start from nothing: the read had not been asked yet, so the reading
// area drew its ground and nothing else until the answer came back, 30 ms on a LAN and several frames on a
// tailnet. The window a pane held when the operator last left it, or the first page the loader asked for
// while the switch was still pending (`lib/loaders.ts`), is what this module keeps. It is a live window, not
// the saved copy: it carries no `savedAt`, it is replaced by the next read (which asks for what changed since
// its cursor, so an unchanged pane answers 304), and it dies with the page. The device store is the other
// keeper (`lib/chat-tail.ts`), the one that survives a killed PWA; this one is only for the next switch.
//
// BOUNDED, newest last, and it never holds a window that is not a live one with turns in it: an empty,
// unavailable or saved window would draw what the phone does not know, in the first frame.

/** How many panes keep a window. A phone's switcher is a handful of panes; sixteen is more than it opens in a sitting. */
const HELD_MAX = 16;

interface Held {
  readonly window: ChatWindow;
  readonly instance: string | undefined;
}

const held = new Map<string, Held>();

/**
 * Keep a pane's window, or drop what is kept for it when this one is not a live window with turns.
 * `address` is `paneScopeKey(scope, paneId)`.
 */
export function holdChat(address: string, instance: string | undefined, window: ChatWindow): void {
  held.delete(address);
  if (window.status.kind !== "live" || window.savedAt !== null || window.entries.length === 0) return;
  held.set(address, { window, instance });
  if (held.size <= HELD_MAX) return;
  const oldest = held.keys().next().value;
  if (oldest !== undefined) held.delete(oldest);
}

/**
 * The window kept for a pane, or `null`. A kept window belongs to one session instance: it is used when the
 * pane's instance is unknown on either side, as the hook's own switch rule has it (another session that took
 * the pane id carries another instance, and its turns are not this one's).
 */
export function heldChat(address: string, instance: string | undefined): ChatWindow | null {
  const found = held.get(address);
  if (found === undefined) return null;
  if (found.instance !== undefined && instance !== undefined && found.instance !== instance) return null;
  return found.window;
}

/** Forget every kept window, for a test. */
export function __resetHeldChat(): void {
  held.clear();
}

function heldCleaner(context: WipeContext): void {
  // A password prompt drops that pane's thread; a pairing that ended drops all of them.
  if (context.reason === "password") held.delete(paneScopeKey(context.pane.scope, context.pane.paneId));
  else held.clear();
}

onWipe("chat-held", heldCleaner);
