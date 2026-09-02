// The dashboard row, drawn from a REAL snapshot off this machine, at the two widths it has to
// survive. DEV-ONLY, like the rest of `src/playground/`.
//
// WHY THE ROWS ARE A FROZEN CAPTURE AND NOT THE PAGE'S OTHER FIXTURES. `./fixtures.ts` is a designed
// herd — believable names, tidy lengths. The row's whole problem is WIDTH, and a designed fixture
// answers a width question in the fixture's favour. `./fixtures/dashboard-live.ts` is a real
// `/api/snapshot`: two machines, real project paths, real `/rename` session names, one of them long
// enough to be the whole argument for where the truncation is allowed to land.
//
// WHY TWO FRAMES. 390px is the reference phone and 360px is the narrowest one still in use, which
// is where a row breaks first. Same eleven rows, same order, side by side: a truncation that only
// shows up in the narrow frame is the one worth arguing about.

import { AgentCard } from "@/components/agent-card";
import { SectionHeader } from "@/components/section-header";
import { ListGroup } from "@/components/ui/list-group";
import { paneRowKey } from "@/lib/hosts";
import type { HomeData } from "@/lib/loaders";
import { triage } from "@/lib/triage";
import type { AgentView } from "@/lib/types";
import { dashboardLive } from "./fixtures/dashboard-live";
import { Card, PackedRootRouter, PhoneFrame } from "./harness";

/** The captured snapshot as the root loader's own shape, so `PackedRootRouter` and the real
 *  `PackProvider` inside it derive host health from it exactly as the app would. */
const home: HomeData = {
  bridge: dashboardLive.bridge,
  device: undefined,
  agents: dashboardLive.agents,
  shellPanes: dashboardLive.shellPanes,
  workspaces: dashboardLive.workspaces,
  tabs: dashboardLive.tabs,
  sessions: dashboardLive.sessions ?? [],
  servers: dashboardLive.servers ?? [],
  ts: dashboardLive.ts,
  scope: {},
  viewAll: false,
  snoozedUntil: null,
  update: undefined,
  error: false,
  authError: false,
};

/**
 * The eleven agents in the order the home route puts them: `triage()`'s four sections, flattened.
 * Flattened rather than sectioned because the question here is the ROW, and four headings in each
 * frame would spend the height on chrome that says nothing about it.
 */
const ROWS: AgentView[] = triage(home.agents).flatMap((s) => s.agents);

export function DashboardRowsCard() {
  return (
    <Card
      label="Dashboard rows (live snapshot from this machine)"
      reach="the dashboard, on a machine with these eleven panes open. Every row here is the shipped component with the props the home route passes it."
      note="Eleven REAL panes off this machine's bridge (src/playground/fixtures/dashboard-live.ts), in the home route's own triage order, in the real ListGroup the flat sections use. Held dark regardless of the page theme, because that is the dress the row is judged in. Two widths: the reference phone at 390px, and 360px, where a row breaks first."
      span={2}
    >
      {/* ONE router for both frames, not one each. `PackedRootRouter` mounts the real `PackProvider`,
          which is what `HostChip` reads for the pack census and the per-host tint — and that is a
          fact about the SNAPSHOT, identical in both. */}
      <PackedRootRouter data={home}>
        {/* `color-scheme` is what index.css's light-dark() tokens actually read, and it INHERITS —
            so this one declaration puts every real component below into the app's dark half without
            touching the page's own theme control. `text-foreground` re-resolves the inherited colour under it: without it the rows keep the LIGHT page's near-black text, resolved once at `body`, and paint it on the dark ground. The `dark` class rides with it for the handful of
            `dark:` utilities (PhoneFrame's bezel) that are class-driven rather than token-driven. */}
        <div className="dark mt-3 flex gap-4 overflow-x-auto pb-3 text-foreground" style={{ colorScheme: "dark" }}>
          <Frame width={390} />
          <Frame width={360} />
        </div>
      </PackedRootRouter>
    </Card>
  );
}

/** One width: the number it is showing, then the rows at it. */
function Frame({ width }: { width: number }) {
  return (
    <div className="flex shrink-0 flex-col gap-1.5">
      <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
        {width}px · {ROWS.length} rows
      </p>
      <div style={{ width }} className="shrink-0">
        <PhoneFrame height={660}>
          <RowList />
        </PhoneFrame>
      </div>
    </div>
  );
}

/**
 * The home route's flat section, as `components/agent-list.tsx` builds it — the same page gutter,
 * the same `SectionHeader`, the same `ListGroup`, and rows at `density="row"` / `statusStyle="dot"`
 * with the working section's `age="active"`. Nothing here is a copy of a component; the only thing
 * this function decides is which rows go in, and that is `ROWS` above.
 */
function RowList() {
  return (
    <div className="flex flex-col gap-5 px-4 py-4">
      <section className="flex flex-col gap-2">
        {/* The real heading component. Labelled "Panes" rather than "Working" because this frame
            deliberately holds all four triage buckets in one run — the row is the subject here, not
            the sectioning. */}
        <SectionHeader label="Panes" count={ROWS.length} dot="bg-status-working" />
        <ListGroup>
          {ROWS.map((a) => (
            <AgentCard
              key={paneRowKey(a)}
              agent={a}
              onClick={() => {}}
              statusStyle="dot"
              density="row"
              age="active"
            />
          ))}
        </ListGroup>
      </section>
    </div>
  );
}
