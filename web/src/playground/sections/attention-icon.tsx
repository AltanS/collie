// Attention icon, a design round (2026-09-23). The dashboard footer's Attention tab wears BellRing,
// and a bell that rings reads as "something is urgent" even when only finished panes wait unseen.
// The badge rule changes with this round (ADR 0066): a red count means panes blocked on you, and a
// quiet mark means finished panes you have not opened. This section asks which ICON fits that tab.
//
// PICKED: option 10, CircleDot. Shipped with the tab itself renamed Attention → Focus (ADR 0068):
// a ringing bell read as a notification even in the quiet state, and CircleDot reads as a place you
// look, not an alert. Options 1-9, 11 and 12 (BellRing, today's icon when this round was drawn) stay
// as they were drawn, for the record.
//
// Every row mounts the REAL `TabBar` (components/ui/tab-bar.tsx) at 375 CSS px, the full three-tab
// footer, so the candidate is judged next to Rows3 and GitCompare at the size it ships. Each row is
// numbered: the operator picks "option N".

import {
  BellDot,
  BellRing,
  CircleAlert,
  CircleDot,
  Eye,
  Flag,
  GitCompare,
  Hand,
  Inbox,
  ListTodo,
  MessageCircleWarning,
  Radar,
  Rows3,
  Target,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { TabBar } from "@/components/ui/tab-bar";
import { Card, Group, Section, type SectionDef } from "../harness";

export const DEF: SectionDef = {
  id: "attention-icon",
  title: "Attention icon",
  intent:
    "Design round: twelve numbered icons for the dashboard footer's Attention tab. Each row is the " +
    "shipped TabBar at 375 px: Attention selected with the red count (2 blocked), unselected with " +
    "the red count, and unselected with the quiet mark (finished panes unseen, nothing blocked). " +
    "Pick by number. PICKED 2026-09-23: option 10, CircleDot — the tab itself is renamed Focus in " +
    "the same round (ADR 0068). The rows below stay as drawn, for the record.",
};

type View = "panes" | "needs" | "changes";

interface Candidate {
  readonly n: number;
  readonly name: string;
  readonly Icon: LucideIcon;
  readonly note?: string;
}

const CANDIDATES: readonly Candidate[] = [
  { n: 1, name: "Inbox", Icon: Inbox },
  { n: 2, name: "Eye", Icon: Eye },
  { n: 3, name: "CircleAlert", Icon: CircleAlert },
  { n: 4, name: "Flag", Icon: Flag },
  { n: 5, name: "Hand", Icon: Hand, note: "raised hand" },
  { n: 6, name: "MessageCircleWarning", Icon: MessageCircleWarning },
  { n: 7, name: "ListTodo", Icon: ListTodo },
  { n: 8, name: "Radar", Icon: Radar },
  { n: 9, name: "Target", Icon: Target },
  { n: 10, name: "CircleDot", Icon: CircleDot, note: "picked — ADR 0068" },
  { n: 11, name: "BellDot", Icon: BellDot, note: "a quieter bell, for comparison" },
  { n: 12, name: "BellRing", Icon: BellRing, note: "previous — replaced by option 10" },
];

const ICON = "size-5";

type Mark = "count" | "dot";

/** One real footer: the candidate on Attention, the given mark on its corner. */
function Footer({ Icon, active, mark }: { Icon: LucideIcon; active: View; mark: Mark }) {
  return (
    <TabBar<View>
      label="Dashboard views"
      active={active}
      onSelect={() => {}}
      items={[
        { value: "panes", label: "Panes", icon: <Rows3 className={ICON} /> },
        {
          value: "needs",
          label: "Attention",
          icon: <Icon className={ICON} />,
          badge: mark === "count" ? 2 : 0,
          dot: mark === "dot",
          badgeLabel: mark === "count" ? "2 blocked" : "Finished panes unseen",
        },
        { value: "changes", label: "Changes", icon: <GitCompare className={ICON} /> },
      ]}
    />
  );
}

/** A 375px phone-width strip holding one footer, with a caption above it. */
function Strip({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="text-[11px] text-muted-foreground">{caption}</figcaption>
      <div className="w-[375px] shrink-0 overflow-hidden rounded-md border border-rule bg-background pt-3">
        {children}
      </div>
    </figure>
  );
}

/** `state` is passed as a string literal at each call site, never built from `c.n`: e2e/handles.spec.ts
 *  reads every card's handle out of the source as a quoted `state` prop, so a template literal hides the
 *  card from that roll call. */
function CandidateRow({ state, c }: { state: string; c: Candidate }) {
  return (
    <Card state={state} label={`option ${c.n} · ${c.name}`} reach="not in the app. Pick a number." span={2}>
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline gap-3">
          <span className="text-4xl font-bold tabular-nums leading-none">{c.n}</span>
          <span className="font-mono text-base">{c.name}</span>
          {c.note !== undefined && <span className="text-xs text-muted-foreground">({c.note})</span>}
        </div>
        <div className="flex flex-wrap gap-4">
          <Strip caption="Attention selected · 2 blocked">
            <Footer Icon={c.Icon} active="needs" mark="count" />
          </Strip>
          <Strip caption="Panes selected · 2 blocked">
            <Footer Icon={c.Icon} active="panes" mark="count" />
          </Strip>
          <Strip caption="Panes selected · only unseen, the quiet mark">
            <Footer Icon={c.Icon} active="panes" mark="dot" />
          </Strip>
        </div>
      </div>
    </Card>
  );
}

export function AttentionIconSection() {
  return (
    <Section def={DEF}>
      <Group title="Options">
        <CandidateRow state="attention-icon-option-1" c={CANDIDATES[0]!} />
        <CandidateRow state="attention-icon-option-2" c={CANDIDATES[1]!} />
        <CandidateRow state="attention-icon-option-3" c={CANDIDATES[2]!} />
        <CandidateRow state="attention-icon-option-4" c={CANDIDATES[3]!} />
        <CandidateRow state="attention-icon-option-5" c={CANDIDATES[4]!} />
        <CandidateRow state="attention-icon-option-6" c={CANDIDATES[5]!} />
        <CandidateRow state="attention-icon-option-7" c={CANDIDATES[6]!} />
        <CandidateRow state="attention-icon-option-8" c={CANDIDATES[7]!} />
        <CandidateRow state="attention-icon-option-9" c={CANDIDATES[8]!} />
        <CandidateRow state="attention-icon-option-10" c={CANDIDATES[9]!} />
        <CandidateRow state="attention-icon-option-11" c={CANDIDATES[10]!} />
        <CandidateRow state="attention-icon-option-12" c={CANDIDATES[11]!} />
      </Group>
    </Section>
  );
}
