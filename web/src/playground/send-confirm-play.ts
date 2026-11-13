// The stand-ins behind the design reference's two send-question cards ("Really send?" and "Send it again?",
// composer-states.tsx): a fake bridge that answers `/api/send`, and the taps that arm the question through
// the composer's own buttons. DEV-ONLY, never imported by the app. Nothing here redraws the composer.
//
// The question is armed for 3 seconds in the product (the real `usePendingConfirm` time, untouched). A
// reference card must show it all the time, so `playSendConfirm` WATCHES: whenever the plain Send is back
// and the text is still unsent, it taps once more. It never taps while the question shows, because that
// tap would send.

import { t } from "@/lib/i18n";
import { asJsonString, parseJsonObject } from "@/lib/json";

/** How often a card looks at its buttons. */
const LOOK_MS = 100;
/** How long a card waits for the composer to be ready for a tap before it gives up. */
const READY_MS = 8_000;

export type SendConfirmKind = "really" | "again";

/** The bridge's answers: `sent`, or `unknown (no_evidence)` for a pane's first send when it is asked to. */
function answerFor(unknown: boolean): object {
  return unknown
    ? { receipt: { outcome: "unknown", reason: "no_evidence", keys: [] }, offers: ["keys"] }
    : { receipt: { outcome: "sent", keys: [] }, offers: [] };
}

interface FakePane {
  readonly firstUnknown: boolean;
  answered: number;
}

const panes = new Map<string, FakePane>();
let realFetch: typeof fetch | null = null;

function bodyPane(body: BodyInit | null | undefined): string | null {
  return asJsonString(parseJsonObject(String(body))?.pane) ?? null;
}

/**
 * Answer `/api/send` for this pane from now on: `unknown` the first time when `firstUnknown`, `sent` after.
 * One patched `fetch` serves every card on the page; it goes back when the last pane is released.
 * Returns the release function.
 */
export function fakeSendBridge(paneId: string, firstUnknown: boolean): () => void {
  panes.set(paneId, { firstUnknown, answered: 0 });
  if (realFetch === null) {
    const real = globalThis.fetch;
    realFetch = real;
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const pane = url.includes("/api/send") && init?.method === "POST" ? bodyPane(init.body) : null;
      const fake = pane === null ? undefined : panes.get(pane);
      if (fake === undefined) return real(input, init);
      const unknown = fake.firstUnknown && fake.answered === 0;
      fake.answered += 1;
      return new Response(JSON.stringify(answerFor(unknown)), { status: 200, headers: { "content-type": "application/json" } });
    };
  }
  return () => {
    panes.delete(paneId);
    if (panes.size > 0 || realFetch === null) return;
    globalThis.fetch = realFetch;
    realFetch = null;
  };
}

const buttonsOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>("button")];
const live = (button: HTMLButtonElement) => !button.disabled && button.getAttribute("aria-disabled") !== "true";
/** The plain Send button, or undefined while the box shows a question, a mic or a send in flight. */
const plainSend = (root: HTMLElement) => buttonsOf(root).find((b) => b.getAttribute("aria-label") === "Send" && live(b));
/** The box holds the text (the stored draft is back). */
const holdsText = (root: HTMLElement, text: string) => root.querySelector("textarea")?.value === text;
/** The unknown notice stands at the Send slot. */
const unknownNoticeShows = (root: HTMLElement) => (root.textContent ?? "").includes(t("composer.protocol.unknown"));

/** Resolve once `ready()` holds, or false when it never does inside READY_MS or the card is gone. */
function until(ready: () => boolean, stopped: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const look = () => {
      if (stopped()) return resolve(false);
      if (ready()) return resolve(true);
      if (Date.now() - started > READY_MS) return resolve(false);
      setTimeout(look, LOOK_MS);
    };
    look();
  });
}

/**
 * Play a card's taps through the composer's own buttons, each only when the composer is ready for it. "Send it
 * again?" first sends the text once (the fake bridge answers unknown) and waits for the notice; both then tap Send
 * to arm the question, and keep it on screen by tapping again whenever it has run out and the text is unsent.
 */
export async function playSendConfirm(root: HTMLElement, kind: SendConfirmKind, text: string, stopped: () => boolean): Promise<void> {
  const ready = () => holdsText(root, text) && plainSend(root) !== undefined;
  if (!(await until(ready, stopped))) return;
  if (kind === "again") {
    plainSend(root)?.click();
    if (!(await until(() => unknownNoticeShows(root) && plainSend(root) !== undefined, stopped))) return;
  }
  plainSend(root)?.click();
  while (!stopped()) {
    await new Promise((resolve) => setTimeout(resolve, LOOK_MS));
    if (stopped() || !ready()) continue;
    if (kind === "again" && !unknownNoticeShows(root)) continue;
    plainSend(root)?.click();
  }
}
