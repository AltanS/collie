// "Send it again?", the look (M100 spec 06, item 2): the operator approved the question and asked to see the
// window and the exact row on the dev lane. One option, drawn with the REAL `Composer` on a Claude pane, the
// soft keyboard stood up under it. The fixture is a fake bridge: a patched `fetch` answers `/api/send` with
// `unknown (no_evidence)` the first time and `sent` after that, and the case's taps are played for you through
// the composer's own buttons. Nothing here redraws the composer.
//
// Cases: "After unknown" (one tap on Send: the answer is unknown, the draft stays, the notice stands at the Send
// slot), "Asking" (a second tap on the same text: the Send slot reads "Send it again?" and nothing was sent),
// "After the confirm" (the confirming tap: the text goes under a new id, the fake bridge answers sent).
//
// The stage fills the design app's frame, whatever its height (the app gives max(frameHeight, room): 560 on a desktop,
// 639 to 683 px on a phone): a flex column with no fixed height. The area above the composer grows and holds the
// caption, the real composer sits directly on a 220 px keyboard stand-in at the bottom, and nothing is blank under it.
// The question stays 3 seconds, the real `usePendingConfirm` time, so the "Asking" case holds its state by watching the
// Send button: when the question has run out it taps Send once more, and it never taps while the question shows,
// because that tap would send. A tap of your own in any case arms it afresh.
//
// The question is the existing destructive-send confirm's slot and button (`Really send?`), with other words and
// no note above the box: no new row, no sheet. After the pick: this file and its line in ../rounds.ts go.
//
// DEV-ONLY, unreachable from the app entry. The round contract (../types.ts) holds the rules: a number and at most five words per option.

import { useEffect, useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { Composer } from "@/components/composer";
import { saveDraft } from "@/lib/drafts";
import { markLive } from "@/lib/liveness";
import { t } from "@/lib/i18n";
import { forgetUnknownSend } from "@/lib/send-again";
import { clearIntent } from "@/lib/send-intent";
import { ChromeBlock } from "@/playground/sections/shared";

import type { PickCase, PickOption, PickRoundDef } from "../types";

const CASES: readonly PickCase[] = [
  { id: "unknown", label: "Unknown" },
  { id: "asking", label: "Asking" },
  { id: "confirmed", label: "Sent" },
];

const TEXT = "Run the full test suite, then fix whatever fails.";

/** How often the case looks at the buttons. */
const LOOK_MS = 100;
/** How long a case waits for the composer to be ready for a tap before it gives up. */
const READY_MS = 8_000;
/** How often a live pane's stamp is renewed, so the box is not drawn "offline" (the cap is 90 s). */
const RENEW_MS = 5_000;

const PREFS = {
  wrap: true,
  fontSize: 11,
  draftFontSize: 14,
  chatFontSize: 14,
  fontFamily: "system",
  rawTerminal: false,
  tapToFocus: true,
  expandClippedReply: true,
  stretchText: false,
  // Each Replay sends one unknown on this pane; three would float the "Sending failed 3 times" card over the stage.
  reportOffer: false,
} as const;

/** The frame's own height; the design app gives more on a phone, and the stage grows into it. */
export const FRAME_HEIGHT = 560;
/** The keyboard stand-in's height: about a phone's soft keyboard. */
export const KEYBOARD_HEIGHT = 220;
/** The caption in the round, in plain words: how long the question stays and how to see it again. */
export const CAPTION = "The question stays 3 seconds. Tap Send to see it again.";

/** The bridge's two answers: no evidence the first time, then a send that went. */
function fakeSendAnswer(sent: number): object {
  return sent === 0
    ? { receipt: { outcome: "unknown", reason: "no_evidence", keys: [] }, offers: ["keys"] }
    : { receipt: { outcome: "sent", keys: [] }, offers: [] };
}

/** Stands in for the soft keyboard: the composer sits on top of it, as it does on a phone. */
function Keyboard() {
  return (
    <div aria-hidden="true" className="flex shrink-0 items-center justify-center bg-muted/60 text-[11px] text-muted-foreground" style={{ height: KEYBOARD_HEIGHT }}>
      keyboard
    </div>
  );
}

const buttonsOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>("button")];
const live = (button: HTMLButtonElement) => !button.disabled && button.getAttribute("aria-disabled") !== "true";
/** The plain Send button, or undefined while the box shows the question, a mic or a send in flight. */
const plainSend = (root: HTMLElement) => buttonsOf(root).find((b) => b.getAttribute("aria-label") === "Send" && live(b));
const question = (root: HTMLElement) => buttonsOf(root).find((b) => b.getAttribute("aria-label") === "Send it again?" && live(b));
/** The box holds the text (the stored draft is back) and nothing is in flight. */
const holdsText = (root: HTMLElement) => root.querySelector("textarea")?.value === TEXT;
/** The unknown notice stands at the Send slot. */
const unknownNoticeShows = (root: HTMLElement) => (root.textContent ?? "").includes(t("composer.protocol.unknown"));

/** Resolve once `ready()` holds, or false when it never does inside READY_MS or the case ends. */
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
 * Play a case's taps through the composer's own buttons, each only when the composer is ready for it:
 * the first send once the stored draft is back, the next once the unknown notice stands. "Asking" then
 * keeps the question on screen by watching: when the plain Send is back (the real 3 seconds ran out)
 * and the text is still unsent, it taps once more. It never taps while the question shows.
 */
async function play(root: HTMLElement, caseId: string, stopped: () => boolean): Promise<void> {
  if (!(await until(() => holdsText(root) && plainSend(root) !== undefined, stopped))) return;
  plainSend(root)?.click();
  if (caseId === "unknown") return;
  if (!(await until(() => unknownNoticeShows(root) && plainSend(root) !== undefined, stopped))) return;
  plainSend(root)?.click();
  if (caseId === "confirmed") {
    if (await until(() => question(root) !== undefined, stopped)) question(root)?.click();
    return;
  }
  while (!stopped()) {
    await new Promise((resolve) => setTimeout(resolve, LOOK_MS));
    if (stopped() || !holdsText(root) || !unknownNoticeShows(root)) continue;
    plainSend(root)?.click();
  }
}

/** One phone: a little terminal, then the real composer on a pane whose box holds the text, the keyboard under it. */
function SendItAgainPhone({ caseId }: { caseId: string }) {
  const paneId = `send-it-again:${caseId}`;
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  // The draft is stored before the composer mounts, so it opens holding the text. Nothing is left of an earlier visit.
  const [router] = useState(() => {
    forgetUnknownSend(undefined, paneId);
    clearIntent(undefined, paneId);
    saveDraft(undefined, paneId, TEXT);
    return createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <ChromeBlock>
              <Composer
                paneId={paneId}
                agent="claude"
                isShell={false}
                gone={false}
                readOnly={false}
                surface={{ revision: 1, turn: "idle", modal: "none", composer: "empty" }}
                text="pane output"
                terminalDraft={null}
                rawTerminalDraft={null}
                prefs={PREFS}
                display={{ open: false, onToggle: () => {} }}
                onSent={() => {}}
              />
            </ChromeBlock>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );
  });

  // The live stamp the composer reads for "live".
  useEffect(() => {
    const stamp = () => markLive(paneId);
    stamp();
    const timer = setInterval(stamp, RENEW_MS);
    return () => clearInterval(timer);
  }, [paneId]);

  // The fake bridge, for this frame's life only: the real `fetch` is back when the case changes.
  useEffect(() => {
    const real = globalThis.fetch;
    let answered = 0;
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes("/api/send") || init?.method !== "POST") return real(input, init);
      const body = JSON.stringify(fakeSendAnswer(answered));
      answered += 1;
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    };
    return () => {
      globalThis.fetch = real;
    };
  }, []);

  // The case's taps (see `play`).
  useEffect(() => {
    if (root === null) return;
    let stop = false;
    void play(root, caseId, () => stop);
    return () => {
      stop = true;
    };
  }, [root, caseId]);

  return (
    <div ref={setRoot} data-state="send-it-again" data-slot="send-it-again-stage" className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="min-h-0 flex-1">
        <p data-slot="send-it-again-caption" className="px-3 py-1.5 text-[11px] leading-snug text-muted-foreground">
          {CAPTION}
        </p>
      </div>
      <RouterProvider router={router} />
      <Keyboard />
    </div>
  );
}

const OPTIONS: readonly PickOption[] = [{ n: 1, label: "Send it again?", state: "send-it-again", render: (caseId) => <SendItAgainPhone key={caseId} caseId={caseId} /> }];

const ROUND: PickRoundDef = { title: "Send it again?", cases: CASES, options: OPTIONS, frameHeight: FRAME_HEIGHT };

export default ROUND;
