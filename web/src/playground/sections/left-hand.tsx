// Left-hand layout section of the states playground: the right-hand and the left-hand pane screen,
// side by side, both from the real `hand` prop (Settings -> Hand). See app.tsx's header for the
// page's own rules.
//
// Every card mounts the REAL `Composer`, which mounts the real `ActionsRow` over the real reply box,
// on a Claude pane (so the harness section is present and the belt overflows at 390px). Nothing here
// redraws either component, and no class re-orders them from outside.
//
// The Switch pill is wired to the real `useSheetPull`, so the upward drag from anywhere on the belt
// can be tried on both cards; the line under each frame reports the last tap or drag it saw.
//
// DEV-ONLY, unreachable from the app entry.

import { useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { Composer } from "@/components/composer";
import { useSheetPull } from "@/hooks/use-sheet-pull";

import { Card, Group, Section, type SectionDef } from "../harness";
import { ChromeBlock, PhoneMock } from "./shared";

export const DEF: SectionDef = {
  id: "left-hand",
  title: "Left-hand layout",
  intent:
    "The bottom of a pane screen for each thumb. Right hand is today: the Switch pill pinned at the belt's right end directly above Send, Keys first at the left. Left hand is its true mirror: the Switch pinned at the belt's left end above Send, Keys the rightmost pill, the belt resting at its right end and scrolling toward the left, Send and Attach left of the reply field. Each card is the real belt over the real reply box on a Claude pane, so the belt overflows.",
};

/** The same prefs `composer.test.tsx` mounts the real composer with. */
const PREFS = {
  wrap: true,
  fontSize: 11,
  draftFontSize: 14,
  chatFontSize: 14,
  fontFamily: "system",
  rawTerminal: false,
  tapToFocus: true,
  expandClippedReply: true,
} as const;

interface VariantDef {
  /** The card's number, drawn on the card. */
  n: 1 | 2;
  title: string;
  line: string;
  /** The production prop the component gets. */
  hand: "right" | "left";
}

const VARIANTS: readonly VariantDef[] = [
  {
    n: 1,
    title: "Right hand",
    line: "Switch pinned at the belt's right end, Keys first at the left, Attach and Send at the right of the field. Unchanged.",
    hand: "right",
  },
  {
    n: 2,
    title: "Left hand",
    line: "Switch pinned at the belt's left end, Keys the rightmost pill, the belt resting at its right end. Send and Attach left of the field.",
    hand: "left",
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

/** One card's phone: a strip of fake terminal, then the chrome block with the belt and the box. */
function LeftHandPhone({ def }: { def: VariantDef }) {
  const [heard, setHeard] = useState("Tap Switch, or drag up from anywhere on the belt.");
  const sheetPull = useSheetPull({
    onPull: (px) => setHeard(`dragging up: ${Math.round(px)}px`),
    onAnchor: () => {},
    onOpen: () => setHeard("drag opened the switcher"),
    onCancel: () => setHeard("drag let go short of the switcher"),
  });
  const [router] = useState(() =>
    createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <ChromeBlock>
              <Composer
                paneId={`lh:${def.n}`}
                agent="claude"
                isShell={false}
                gone={false}
                readOnly={false}
                dialogPresent={false}
                text="pane output"
                terminalDraft={null}
                rawTerminalDraft={null}
                prefs={PREFS}
                display={{ open: false, onToggle: () => {} }}
                onSent={() => {}}
                hand={def.hand}
                pullHandle={{
                  ref: sheetPull.ref,
                  onClick: () => setHeard("tapped Switch"),
                  label: "Switch pane",
                }}
              />
            </ChromeBlock>
          ),
        },
      ],
      { initialEntries: ["/"] },
    ),
  );
  return (
    <div>
      <PhoneMock>
        <div className="h-16 bg-background px-3 pt-2 font-mono text-[11px] text-muted-foreground">
          terminal output above the belt
        </div>
        <RouterProvider router={router} />
      </PhoneMock>
      <p className="mt-1 font-mono text-[11px] text-muted-foreground">{heard}</p>
    </div>
  );
}

function OptionCard({ def, state }: { def: VariantDef; state: string }) {
  return (
    <Card
      state={state}
      label={`${def.n}: ${def.title}`}
      reach="Settings -> Appearance -> Hand."
      note={def.line}
    >
      <div className="mb-2 flex items-center gap-3">
        <NumberBadge n={def.n} />
        <p className="text-sm font-semibold text-foreground">
          {def.n}: {def.title}
        </p>
      </div>
      <LeftHandPhone def={def} />
    </Card>
  );
}

export function LeftHandSection() {
  return (
    <Section def={DEF}>
      <Group title="Both hands, from the real prop">
        {/* Literal handles, written out: the e2e roll call reads the state props from source. */}
        <OptionCard state="left-hand-1" def={VARIANTS[0]!} />
        <OptionCard state="left-hand-2" def={VARIANTS[1]!} />
      </Group>
    </Section>
  );
}
