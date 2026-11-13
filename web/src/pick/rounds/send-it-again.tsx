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
// The question is the existing destructive-send confirm's slot and button (`Really send?`), with other words and
// no note above the box: no new row, no sheet. After the pick: this file and its line in ../rounds.ts go.
//
// DEV-ONLY, unreachable from the app entry. The round contract (../types.ts) holds the rules: a number and at most five words per option.

import { useEffect, useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { Composer } from "@/components/composer";
import { saveDraft } from "@/lib/drafts";
import { markLive } from "@/lib/liveness";
import { forgetUnknownSend } from "@/lib/send-again";
import { clearIntent } from "@/lib/send-intent";
import { ChromeBlock, PhoneMock } from "@/playground/sections/shared";

import type { PickCase, PickOption, PickRoundDef } from "../types";

const CASES: readonly PickCase[] = [
  { id: "unknown", label: "After unknown" },
  { id: "asking", label: "Asking" },
  { id: "confirmed", label: "After the confirm" },
];

const TEXT = "Run the full test suite, then fix whatever fails.";

/** The taps each case plays, by the name of the button the composer shows at that moment. */
function tapsOf(caseId: string): readonly string[] {
  switch (caseId) {
    case "asking":
      return ["Send", "Send"];
    case "confirmed":
      return ["Send", "Send", "Send it again?"];
    default:
      return ["Send"];
  }
}

/** Time for the fake bridge's answer to land between two taps. */
const STEP_MS = 700;
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
} as const;

const MIRROR = [
  "● Update(web/src/lib/sync.ts)",
  "  ⎿  Updated web/src/lib/sync.ts with 6 additions",
  "",
  "● Bash(bunx vitest run src/lib)",
  "  ⎿  Test Files  38 passed (38)",
  "",
  "● The retry is in. Waiting for your next step.",
];

/** The bridge's two answers: no evidence the first time, then a send that went. */
function fakeSendAnswer(sent: number): object {
  return sent === 0
    ? { receipt: { outcome: "unknown", reason: "no_evidence", keys: [] }, offers: ["keys"] }
    : { receipt: { outcome: "sent", keys: [] }, offers: [] };
}

/** Stands in for the soft keyboard: the composer sits on top of it, as it does on a phone. */
function Keyboard() {
  return (
    <div aria-hidden="true" className="h-[260px] shrink-0 bg-muted/60 pt-2 text-center text-[11px] text-muted-foreground">
      keyboard
    </div>
  );
}

/** Press the button with this exact name, once it is there and enabled. Resolves false when it never shows. */
function pressWhenReady(root: HTMLElement, name: string, cancelled: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    let tries = 0;
    const look = () => {
      if (cancelled()) return resolve(false);
      const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === name && !b.disabled && b.getAttribute("aria-disabled") !== "true");
      if (button !== undefined) {
        button.click();
        return resolve(true);
      }
      tries += 1;
      if (tries >= 100) return resolve(false);
      setTimeout(look, 50);
    };
    look();
  });
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

  // The case's taps, played through the composer's own buttons, one every STEP_MS.
  useEffect(() => {
    if (root === null) return;
    let stop = false;
    void (async () => {
      for (const name of tapsOf(caseId)) {
        await new Promise((resolve) => setTimeout(resolve, STEP_MS));
        if (stop || !(await pressWhenReady(root, name, () => stop))) return;
      }
    })();
    return () => {
      stop = true;
    };
  }, [root, caseId]);

  return (
    <div ref={setRoot} data-state="send-it-again" className="flex flex-col">
      <PhoneMock>
        <div className="h-44 overflow-hidden bg-background px-3 pt-2 font-mono text-[11px] leading-snug text-muted-foreground">
          <div className="whitespace-pre">{MIRROR.join("\n")}</div>
        </div>
        <RouterProvider router={router} />
        <Keyboard />
      </PhoneMock>
    </div>
  );
}

const OPTIONS: readonly PickOption[] = [{ n: 1, label: "Send it again?", state: "send-it-again", render: (caseId) => <SendItAgainPhone key={caseId} caseId={caseId} /> }];

const ROUND: PickRoundDef = { title: "Send it again?", cases: CASES, options: OPTIONS, frameHeight: 740 };

export default ROUND;
