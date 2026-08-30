// The UI typeface comparison. DEV-ONLY, like everything else under src/playground/.
//
// WHY THIS CARD BREAKS THE PAGE'S "MOUNT THE REAL COMPONENT" RULE, ON PURPOSE. Every other card
// mounts real components with real props. This one cannot: the whole point is to see FOUR faces at
// once, and there is only ever one app. So the specimen below is a rebuild of the app's own chrome —
// the header and wordmark, a section label, status chips, a settings row, buttons, and the
// counts-heavy list that is most of the dashboard — using the same sizes, weights, tracking and
// tokens the real components use. It is a stand-in, and it says so on the card.
//
// WHAT IT IS FOR — AND THIS CHANGED. It used to be the only place the call got made: F-D1 said the
// UI typeface was the maker's choice and shipped with no setting, so a face either won here or was
// never seen again. The setting exists now (ADR 0033), and the reader picks from the shipped list in
// Settings. So this card is no longer where the choice is MADE; it is where a candidate is
// AUDITIONED before it joins that list.
//
// That is a narrower job and a more useful one. Joining the shipped list is not free — a face costs
// a subset in build-ui-font.sh, a computed fallback twin, an @font-face in index.css, an entry in
// UI_FONT_URLS and a translated note in six dictionaries. This page is where you find out whether a
// face is worth all of that, at real sizes, against the faces already there. Judge it at the 11px
// uppercase tracked label and at the 18px wordmark, on a phone, in BOTH themes — that is where these
// faces actually differ. The counts column is there because the dashboard is full of "14m", "(6)",
// "p1", and a face whose figures are proportional makes that column jitter row to row.
//
// The shipped faces (Space Grotesk, Aldrich) resolve through index.css, so what you compare here is
// the same bytes the app renders. The AUDITIONS are declared in playground.css instead: index.css
// names exactly what the service worker caches (lib/sw-routes.ts UI_FONT_URLS), and it must not grow
// entries for files a shipped build never asks for.
//
// THE SWITCHER IS NOW THE PAGE'S OWN. The choice lives in ./prefs.ts and dresses the ENTIRE
// playground — every real component on the page inherits the face, which is the honest way to feel
// a candidate's impact. This card keeps the side-by-side specimen and the commentary; the sidebar's
// Typeface control is the same store with the words left out.
import { CollieMark } from "@/components/collie-mark";
import { cn } from "@/lib/utils";

import { Card, Segmented } from "./harness";
import { FACE_OPTIONS, FACES, setFace, useFace, type FaceId } from "./prefs";

/** The dashboard's own shape: a name, a state, and two counts that have to line up down the column. */
const ROWS = [
  {
    name: "bluefin",
    tone: "blocked",
    state: "Needs you",
    age: "14m",
    panes: "(6)",
    pane: "p1",
  },
  {
    name: "sprqvntrs",
    tone: "working",
    state: "Working",
    age: "3m",
    panes: "(11)",
    pane: "p4",
  },
  {
    name: "collie-website",
    tone: "done",
    state: "Done",
    age: "1h 08m",
    panes: "(2)",
    pane: "p2",
  },
  {
    name: "sportsight",
    tone: "idle",
    state: "Idle",
    age: "18h",
    panes: "(1)",
    pane: "p10",
  },
  {
    name: "collie-brand",
    tone: "unknown",
    state: "Unknown",
    age: "6d",
    panes: "(0)",
    pane: "p7",
  },
] as const;

const TONE_FILL = {
  blocked: "bg-status-blocked/15 text-status-blocked",
  working: "bg-status-working/15 text-status-working",
  done: "bg-status-done/15 text-status-done",
  idle: "bg-status-idle/15 text-status-idle",
  unknown: "bg-status-unknown/15 text-status-unknown",
} satisfies Record<(typeof ROWS)[number]["tone"], string>;

/** The one uppercase tier: 11px, 600, tracked. Every section title in the app is this. */
function SectionLabel({ children }: { children: string }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

function Specimen({ face }: { face: FaceId }) {
  return (
    <div
      style={{ fontFamily: FACES[face].stack }}
      className="w-full overflow-hidden rounded-lg border border-border bg-background text-foreground"
    >
      {/* Header + wordmark — the 18px tier, beside the mark it has to sit next to. */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <CollieMark size={28} weight="header" />
        <span className="text-lg font-semibold tracking-tight">Collie</span>
        {/* The real header prints the multiplexer's own name from /api/config; the specimen
            stands in for it, because the frontend never spells one (check-mux-names.sh). */}
        <span className="text-[11px] text-muted-foreground">on the mux</span>
        <span className="ml-auto rounded-sm bg-muted px-2 py-1 text-[11px] font-medium">
          bluefin
        </span>
      </div>

      <div className="space-y-3 px-3 py-3">
        <SectionLabel>Needs you</SectionLabel>

        {/* The counts-heavy list. `tabular-nums` on the two numeric columns, exactly as the app does
            it — a face without usable tabular figures shows up here as a ragged right edge. */}
        <ul className="divide-y divide-border rounded-sm border border-border">
          {ROWS.map((row) => (
            <li key={row.name} className="flex items-center gap-2 px-2 py-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {row.name}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-sm px-2 py-0.5 text-[11px] font-medium",
                  TONE_FILL[row.tone],
                )}
              >
                {row.state}
              </span>
              <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {row.age}
              </span>
              <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {row.panes}
              </span>
              <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {row.pane}
              </span>
            </li>
          ))}
        </ul>

        <SectionLabel>Display</SectionLabel>

        {/* A settings row: 14px label over 13px description, the app's two text tiers. */}
        <div className="flex items-start gap-3 rounded-sm border border-border px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Terminal font size</p>
            <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">
              Applies to the mirror and the transcript · 9–16px · currently 12
            </p>
          </div>
          <span className="shrink-0 text-sm font-semibold tabular-nums">
            12
          </span>
        </div>

        {/* A banner — the em dash and the middot are the two characters this app prints most. */}
        <div className="rounded-sm border border-status-info/30 bg-status-info/10 px-3 py-2 text-[13px] leading-snug text-status-info">
          A newer build is on the server — reload to pick it up. 0.31.2 › 0.32.0
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            className="flex-1 rounded-sm bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
          >
            Reload
          </button>
          <button
            type="button"
            className="flex-1 rounded-sm border border-border px-3 py-2 text-sm font-medium"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

export function TypefaceCard() {
  const face = useFace();
  return (
    <Card
      label="the ui typeface — live switcher, page-wide"
      reach="Settings → Typeface, on the device — the app face is a per-device preference now (ADR 0033), not the maker's choice it used to be. So this card is not where the choice is made any more; it is where a CANDIDATE is auditioned before it joins the shipped list, which costs a subset, a computed twin, an index.css @font-face, a UI_FONT_URLS entry and a note in six dictionaries."
      note="APPROXIMATION: a rebuild of the app's chrome at the app's real sizes, not the real components — the faces cannot all be mounted at once. The four self-hosted faces come from public/fonts/ with metric-matched fallbacks, so the swap you see for them is the swap the app does; two of them (Space Grotesk, Aldrich) are the shipped list and render the same bytes the app renders. The three techno candidates at the end load from the Google CDN with no fallback twin — a playground-only allowance, disqualifying in the shipped app."
    >
      <div className="space-y-2">
        <Segmented value={face} options={FACE_OPTIONS} onChange={setFace} />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {FACES[face].note}
        </p>
        <Specimen face={face} />
      </div>
    </Card>
  );
}
