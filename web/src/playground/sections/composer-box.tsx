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

import { createContext, useContext, useEffect, useRef, useState } from "react";
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
    "The reply box in its second layout. At rest it is one slim row: Attach at the left, the field, and the microphone as the main button, and a tap that only brings the caret stays one row. It opens upward when there is text, a chip or Type mode: the field takes the full width, one line tall to start, and the buttons take a row of their own: Attach still at the left, the small microphone and Send, the main button, at the right. The box grows in about 200 ms, nothing in it moves up or down, and a button that appears slides in sideways from its own edge, and empties back to one row when the draft is cleared. The belt above does not change. Each card is the real composer on a Claude pane, with layout set to box.",
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
  /** Settings -> Hand. Absent is the right hand. */
  hand?: "left";
  /** Open the fullscreen editor after mount, as a tap on Expand does. */
  expanded?: boolean;
}

const CASES: readonly CaseDef[] = [
  {
    n: 1,
    title: "At rest",
    reach: "Settings -> Appearance -> Composer, once a theme chooses it. An empty pane box that is not tapped.",
    note: "One row. Attach (Plus) at the left, the field's one line, the microphone as the filled main button. No Send: an empty box has none today either.",
    surface: IDLE,
  },
  {
    n: 2,
    title: "Focused, still empty",
    reach: "tap the box. Type a letter to open it, then delete it to close it again.",
    note: "Focused and empty it stays one row, with the caret in the field: nothing to write yet, so no room is taken. This is the card to try the glide on: type a letter and the box grows upward: Attach and the main button stay where they stand, and the small microphone slides in from the right. Delete it and the box shrinks back. The card focuses the field once it has mounted; if you tapped elsewhere, tap the box.",
    surface: IDLE,
    focused: true,
  },
  {
    n: 3,
    title: "One line of text",
    reach: "type a few words.",
    note: "Open, and it stays open without focus. The field is one line tall. The bottom row reads Attach at the left, then a small microphone and Send at the right, with Send the filled main button.",
    surface: IDLE,
    draft: "Make the tab a folder tab",
  },
  {
    n: 4,
    title: "Several lines",
    reach: "type a few lines.",
    note: "The field grows with its text up to its cap, then scrolls. The buttons stay on the bottom row and never share a line with the text.",
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
  {
    n: 6,
    title: "Left hand, at rest",
    reach: "Settings -> Hand: left, an empty pane box.",
    note: "The mirror of card 1: the microphone as the main button at the left, the field, and Attach (Plus) at the right edge.",
    surface: IDLE,
    hand: "left",
  },
  {
    n: 7,
    title: "Left hand, one line",
    reach: "Settings -> Hand: left, then type a few words.",
    note: "The mirror of card 3: Send and the small microphone at the left, Attach still at the right edge. Type a letter into card 6 to see the small microphone slide in from the left.",
    surface: IDLE,
    draft: "Make the tab a folder tab",
    hand: "left",
  },
  {
    n: 8,
    title: "Fullscreen editor",
    reach: "type a long reply, then tap Expand (the diagonal arrows) in the open row.",
    note: "The same draft over the pane view, from the top of the reading area to the bottom of the box: the field fills it with no row cap, Collapse at the top right, Send at the bottom right. Collapse or Escape returns to the box with the draft and the caret where they were.",
    surface: IDLE,
    draft:
      "Make the tab a folder tab.\n\nThen check the settings page for the same corner, and look at how the belt reads once the box is open. The belt should not move when the box grows, and the buttons should not drop from the top.\n\nAfter that, run the gates: both typechecks, the lint and the composer suites. Then take the shots at 390 by 844 in the light theme, both hands, at rest and open.\n\nTell me what changed, with the commit and the test counts, and leave the branch unpushed until I have looked at it on the phone.",
    expanded: true,
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

/** The card's reading-area stand-in, handed past the memory router, which is built once. */
const ExpandArea = createContext<HTMLElement | null>(null);

/** The real composer on the card's pane, with the fullscreen editor's area read from the card. */
function BoxComposer({ def, paneId }: { def: CaseDef; paneId: string }) {
  const area = useContext(ExpandArea);
  return (
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
      hand={def.hand ?? "right"}
      expandArea={area}
      screen={{ on: false, onToggle: () => {} }}
    />
  );
}

function BoxPhone({ def, speech }: { def: CaseDef; speech: boolean }) {
  const paneId = `composer-box:${String(def.n)}`;
  const host = useRef<HTMLDivElement>(null);
  // The card's stand-in for the reading area: the fullscreen editor covers it down to the box.
  const [area, setArea] = useState<HTMLDivElement | null>(null);
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
  // The tap on Expand, taken once for you when the box has been drawn open with Expand in it.
  useEffect(() => {
    if (def.expanded !== true || !speech || area === null) return;
    const frame = requestAnimationFrame(() => host.current?.querySelector<HTMLButtonElement>('[data-slot="composer-expand"]')?.click());
    return () => cancelAnimationFrame(frame);
  }, [def.expanded, speech, area]);
  const [router] = useState(() => {
    if (def.draft !== undefined) saveDraft(undefined, paneId, def.draft);
    return createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <ChromeBlock>
              <BoxComposer def={def} paneId={paneId} />
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
        <div ref={setArea} className="h-16 bg-background px-3 pt-2 font-mono text-[11px] text-muted-foreground">
          The review is done. The build is live on 8788.
        </div>
        <ExpandArea.Provider value={area}>
          <RouterProvider router={router} />
        </ExpandArea.Provider>
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
        <BoxCard state="composer-box-left-rest" def={CASES[5]!} speech={speech} />
        <BoxCard state="composer-box-left-one-line" def={CASES[6]!} speech={speech} />
        <BoxCard state="composer-box-expanded" def={CASES[7]!} speech={speech} />
      </Group>
    </Section>
  );
}
