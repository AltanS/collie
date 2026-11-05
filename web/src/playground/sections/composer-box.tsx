// Composer box section of the states playground: the reply box in its second layout, `layout="box"`,
// in the five states that matter. See app.tsx's header for the page's own rules.
//
// Every card mounts the REAL `Composer` (with its real belt) on a Claude pane. Nothing here redraws
// the box. Two things are staged: the draft of the "one line" and "several lines" cards is saved
// before the composer mounts, so it loads it as a draft the operator left there; and this page answers
// no API, so a microphone would never be drawn, so the section answers `/api/config` itself, with a
// speech provider, for as long as it is on screen. Nothing is recorded: a tap on the microphone opens
// the real takeover and nothing more.
//
// DEV-ONLY, unreachable from the app entry.

import { useEffect, useRef, useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { Composer } from "@/components/composer";
import { markLive } from "@/lib/liveness";
import { saveDraft } from "@/lib/drafts";
import { __resetOperatorCommands, loadOperatorCommands } from "@/lib/operator-config";
import type { Surface } from "@/lib/surface/surface";

import { Card, CardControls, Group, Section, type SectionDef } from "../layout";

import { ChromeBlock, PhoneMock } from "./shared";

export const DEF: SectionDef = {
  id: "composer-box",
  title: "Composer box",
  intent:
    "The reply box in its second layout. At rest it is one slim row: the field, then Attach, then the microphone as the main button, and a tap that only brings the caret stays one row. It opens upward when there is text, a chip or Type mode: the field takes the full width, one line tall to start, and the buttons drop to a row of their own at the right: Attach, the small microphone, and Send as the main button. The change glides in about 200 ms, and empties back to one row when the draft is cleared. The belt above does not change. Each card is the real composer on a Claude pane, with layout set to box.",
};

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

const IDLE: Surface = { revision: 1, turn: "idle", modal: "none", composer: "empty" };
const RUNNING: Surface = { revision: 1, turn: "running", modal: "none", composer: "empty" };

/** How often a card's live stamp is renewed, so a card left open does not lapse into "offline". */
const RENEW_MS = 5_000;

/**
 * Answer `/api/config` with a speech provider while the section is on screen, so the box shows its
 * microphone. Restores the page's own fetch and forgets the staged read when the section goes.
 */
function useStagedSpeech(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const real = window.fetch;
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!new URL(url, window.location.href).pathname.endsWith("/api/config")) return real(input, init);
      return Promise.resolve(
        new Response(JSON.stringify({ push: false, vapidPublicKey: "", stt: { provider: "openai-compatible", available: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    __resetOperatorCommands();
    void loadOperatorCommands().then(() => setReady(true));
    return () => {
      window.fetch = real;
      __resetOperatorCommands();
    };
  }, []);
  return ready;
}

interface CaseDef {
  n: number;
  title: string;
  reach: string;
  note: string;
  surface: Surface;
  draft?: string;
  /** Focus the field after mount, as a tap on the box does. */
  focused?: boolean;
}

const CASES: readonly CaseDef[] = [
  {
    n: 1,
    title: "At rest",
    reach: "Settings -> Appearance -> Composer, once a theme chooses it. An empty pane box that is not tapped.",
    note: "One row. The field's one line, Attach (Plus) beside the microphone, and the microphone as the filled main button. No Send: an empty box has none today either.",
    surface: IDLE,
  },
  {
    n: 2,
    title: "Focused, still empty",
    reach: "tap the box. Type a letter to open it, then delete it to close it again.",
    note: "Focused and empty it stays one row, with the caret in the field: nothing to write yet, so no room is taken. This is the card to try the glide on: type a letter and the box grows upward, Attach and the main button gliding down to the bottom row; delete it and they glide back. The card focuses the field once it has mounted; if you tapped elsewhere, tap the box.",
    surface: IDLE,
    focused: true,
  },
  {
    n: 3,
    title: "One line of text",
    reach: "type a few words.",
    note: "Open, and it stays open without focus. The field is one line tall. The bottom row reads Attach, a small microphone and Send, with Send the filled main button.",
    surface: IDLE,
    draft: "Make the tab a folder tab",
  },
  {
    n: 4,
    title: "Several lines",
    reach: "type a few lines.",
    note: "The field grows with its text up to its cap, then scrolls. The buttons stay on the bottom row at the right and never share a line with the text.",
    surface: IDLE,
    draft:
      "Make the tab a folder tab.\n\nThen check the settings page for the same corner, and look at how the belt reads once the box is open.\n\nAfter that, run the gates and tell me what changed.",
  },
  {
    n: 5,
    title: "Agent working, box at rest",
    reach: "a pane whose turn is running, with nothing typed.",
    note: "The belt above carries Stop (the harness decides); the box is the same one row as at rest. A send during a turn queues, as before.",
    surface: RUNNING,
  },
];

function NumberBadge({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-lg font-bold leading-none text-background"
    >
      {n}
    </span>
  );
}

function BoxPhone({ def, speech }: { def: CaseDef; speech: boolean }) {
  const paneId = `composer-box:${String(def.n)}`;
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stamp = () => markLive(paneId);
    stamp();
    const timer = setInterval(stamp, RENEW_MS);
    return () => clearInterval(timer);
  }, [paneId]);
  // The tap on the box, taken once for you when the microphone has been drawn (the layout then stands).
  useEffect(() => {
    if (def.focused !== true || !speech) return;
    const frame = requestAnimationFrame(() => host.current?.querySelector("textarea")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [def.focused, speech]);
  const [router] = useState(() => {
    if (def.draft !== undefined) saveDraft(undefined, paneId, def.draft);
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
                surface={def.surface}
                stopOffered={def.surface.turn === "running"}
                text="pane output"
                terminalDraft={null}
                rawTerminalDraft={null}
                prefs={PREFS}
                display={{ open: false, onToggle: () => {} }}
                onSent={() => {}}
                layout="box"
                screen={{ on: false, onToggle: () => {} }}
              />
            </ChromeBlock>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );
  });
  return (
    <div ref={host}>
      <PhoneMock>
        <div className="h-16 bg-background px-3 pt-2 font-mono text-[11px] text-muted-foreground">
          The review is done. Collie New is live on 8788.
        </div>
        <RouterProvider router={router} />
      </PhoneMock>
    </div>
  );
}

function BoxCard({ state, def, speech }: { state: string; def: CaseDef; speech: boolean }) {
  return (
    <Card state={state} label={`${def.n}: ${def.title}`} reach={def.reach} note={def.note}>
      <CardControls className="flex items-center gap-3">
        <NumberBadge n={def.n} />
        <p className="text-sm font-semibold text-foreground">
          {def.n}: {def.title}
        </p>
      </CardControls>
      <BoxPhone def={def} speech={speech} />
    </Card>
  );
}

export function ComposerBoxSection() {
  const speech = useStagedSpeech();
  return (
    <Section def={DEF}>
      <Group title="The five states, from the real prop">
        {/* Literal handles, written out: the e2e roll call reads the state props from source. */}
        <BoxCard state="composer-box-rest" def={CASES[0]!} speech={speech} />
        <BoxCard state="composer-box-open-empty" def={CASES[1]!} speech={speech} />
        <BoxCard state="composer-box-one-line" def={CASES[2]!} speech={speech} />
        <BoxCard state="composer-box-several-lines" def={CASES[3]!} speech={speech} />
        <BoxCard state="composer-box-working" def={CASES[4]!} speech={speech} />
      </Group>
    </Section>
  );
}
