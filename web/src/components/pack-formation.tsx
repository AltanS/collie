import { Crown, Server, Shield } from "lucide-react";

import { useLocale } from "@/hooks/use-locale";
import { hostHealth, type HostHealth } from "@/lib/host-health";
import { countsFor, type HostCounts } from "@/lib/hosts";
import { t, tn } from "@/lib/i18n";
import type { PackMemberStatus, PackStatusResponse, ServerSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

// The pack census drawn as a FORMATION rather than listed as rows.
//
// ── WHY A PICTURE AND NOT A LIST ─────────────────────────────────────────────
// A list answers "how is each machine", which the sheet still does. The question a list could never
// answer at a glance is the one that decides what the operator does next: WHO STANDS WHERE. Lead at
// the apex, deputy directly beneath it on a thick connector, everyone else fanned in a V on thin
// ones — so "there is no deputy" is a missing row you cannot fail to notice, and a pack whose peers
// have all gone grey reads as a shape before it reads as words.
//
// ── IT IS ONE INLINE <svg>, AND THAT IS A CONSTRAINT, NOT A SHORTCUT ─────────
// No chart library, no new dependency: the drawing is eleven circles and some cubics, and a library
// would arrive with its own colour system that this app would then have to fight. Every colour here
// is a THEME TOKEN carried by `currentColor` through a Tailwind `text-*` class, so light/dark and
// the contrast work recorded in index.css apply unchanged.
//
// ── THE RING'S HUE IS THE APP'S OWN STATUS VOCABULARY, NOT A NEW ONE ─────────
// A healthy machine is GREEN (`status-done`), and it may not be amber: `status-working` is this
// app's "needs attention" signal (index.css says so where the token is defined), and spending it on
// the state that needs nothing would make every well-behaved pack look like it wanted something. So
// the ladder is the one the rest of Collie already speaks — green = fine, amber = look at this,
// red = go fix this, grey = we have nothing to tell you — and STALE is what earns the amber, because
// a receipt going old is precisely the case that wants a glance.
//
// ── AND COLOUR IS NEVER THE ONLY ENCODING ────────────────────────────────────
// Amber-vs-green and amber-vs-red are both hard pairs for a red-green colour-blind reader, and the
// grey of "we have never heard from it" is a hair from the grey of anything else. So the ring
// carries a DASH PATTERN as well as a hue (solid = fine, dashed = stale, dotted = never seen), every
// node is captioned with its own name, and the health WORD rides in the node's `aria-label` and
// again in the sheet. Nothing on this page is knowable by hue alone.
//
// ── THE GEOMETRY IS A PURE FUNCTION ──────────────────────────────────────────
// {@link formationLayout} takes members and a deputy id and returns coordinates. It renders nothing
// and reads no clock, so the shape of a 1-, 2-, 3- and 7-machine pack is unit-testable without a
// DOM — which is the only practical way to pin a layout that is otherwise judged by eye.

/** The drawing's coordinate space. Scaled to the container width by `viewBox` alone — never px. */
const VIEW_W = 360;
const CX = VIEW_W / 2;
/** The apex. 58, not less: the crown badge sits 54 above the centre and must not clip the top. */
const APEX_Y = 58;
/** Apex → deputy, and (when there is no deputy) apex → the first fan rank. */
const ROW_GAP = 110;
/** The last centred row → the first fan rank. Wider than ROW_GAP: the V has to read as a new tier. */
const FAN_GAP = 96;
/** Between fan ranks. Large enough that one rank's caption clears the next rank's ring — the two
 *  ranks overlap horizontally by construction, so the clearance has to be vertical. */
const FAN_DY = 84;
/** The first fan rank's horizontal offset from the centre line, and how much each rank adds. */
const FAN_X0 = 68;
const FAN_DX = 38;
/** Two nodes per rank, three ranks — past six peers the V wraps and a second one starts below. */
const FAN_PER_V = 6;
/** Between the bottom of one V and the top of the next. */
const V_GAP = 80;
/** The node body. 26 is the smallest radius that still holds the glyph AND a 3px ring legibly. */
const NODE_R = 26;
/** Below the lowest node: its caption plus breathing room. */
const BOTTOM_PAD = 44;
/** A node's caption baseline sits `NODE_R + 15` below its centre; this clears its descenders too. */
const CAPTION_CLEAR = 22;

/** Which slot a member occupies. Role names are not translated — see ADR 0030's exclusion list. */
export type FormationRole = "lead" | "deputy" | "peer";

/** One member's place in the drawing. `row` is 0 for the apex, 1 for the deputy, 2+ for fan ranks. */
export interface FormationNode {
  member: PackMemberStatus;
  role: FormationRole;
  x: number;
  y: number;
  row: number;
}

/**
 * Where every member stands. Pure: same members in, same coordinates out, no clock and no DOM.
 *
 * Row 0 is the lead, alone on the centre line. Row 1 is the deputy if one is named, also centred —
 * and SKIPPED entirely if none is, so the pack that named nobody is visibly one tier shallower
 * rather than showing an empty slot. Everyone else fans out below in ranks of two, alternating LEFT
 * first then right, each rank `FAN_DX` wider and `FAN_DY` lower than the one above it. Past
 * {@link FAN_PER_V} peers the V has run out of half-width, so it wraps: a second V starts below the
 * first rather than the fan growing past the viewBox edge.
 *
 * A member the payload lists twice, or a `deputyId` naming nobody, degrades to "peer" rather than
 * throwing — this is a status page, and a malformed census must still draw.
 */
export function formationLayout(
  members: readonly PackMemberStatus[],
  deputyId: string | null,
): FormationNode[] {
  const lead = members.find((m) => m.isLead);
  const deputy = deputyId === null ? undefined : members.find((m) => m.id === deputyId && !m.isLead);
  const peers = members.filter((m) => m !== lead && m !== deputy);

  const nodes: FormationNode[] = [];
  let y = APEX_Y;
  if (lead) nodes.push({ member: lead, role: "lead", x: CX, y, row: 0 });
  if (deputy) {
    y += ROW_GAP;
    nodes.push({ member: deputy, role: "deputy", x: CX, y, row: 1 });
  }

  // The fan's own origin, so a pack with no lead at all (a payload we do not produce, but must not
  // crash on) still starts its V at the top of the drawing rather than below an empty apex.
  const fanTop = nodes.length === 0 ? APEX_Y : y + FAN_GAP;
  const baseRow = nodes.length;
  for (const [i, member] of peers.entries()) {
    const v = Math.floor(i / FAN_PER_V);
    const within = i % FAN_PER_V;
    const rank = Math.floor(within / 2);
    // Left first: on a two-machine-plus-deputy pack the single peer sits left of centre, which is
    // deliberate — a lone node ON the centre line would read as a third tier of the spine.
    const side = within % 2 === 0 ? -1 : 1;
    nodes.push({
      member,
      role: "peer",
      x: CX + side * (FAN_X0 + rank * FAN_DX),
      y: fanTop + v * (2 * FAN_DY + V_GAP) + rank * FAN_DY,
      row: baseRow + v * 3 + rank,
    });
  }
  return nodes;
}

/** The viewBox height the laid-out nodes need. Empty draws nothing, so it collapses to zero. */
export function formationHeight(nodes: readonly FormationNode[]): number {
  if (nodes.length === 0) return 0;
  return Math.max(...nodes.map((n) => n.y)) + NODE_R + BOTTOM_PAD;
}

/**
 * The census row read as a roster entry — the two shapes overlap exactly where health lives.
 *
 * Exported because the fallback below is the only reader that has a `PackMemberStatus` and needs a
 * `ServerSummary`; nothing outside this module should be converting between them.
 */
export function asServerSummary(m: PackMemberStatus): ServerSummary {
  return {
    id: m.id,
    name: m.name,
    isLead: m.isLead,
    // Only `reachable` is a green light. `conflicted` in particular is NOT: two collies believing
    // they lead the same pack is the one state where a write could land somewhere unintended.
    reachable: m.health === "reachable",
    protocol: m.health === "incompatible" ? "incompatible" : m.lastSeenAt > 0 ? "ok" : "unknown",
    protocolDetail: m.reason,
    lastSeenAt: m.lastSeenAt,
  };
}

/**
 * The tier-2 health for a member.
 *
 * The snapshot-derived map is the answer wherever there is one, so this page and the switcher can
 * never disagree. The fallback is for a mount with no `PackProvider` — this route's own unit tests,
 * and a first paint where the snapshot has not landed — and it is derived from THIS payload rather
 * than invented: `hostHealth` with `at: 0` skips the §10.2 tolerance and presents the lead's plain
 * boolean, which is precisely what ServerSwitcher's identical fallback does.
 */
export function memberHealth(
  map: ReadonlyMap<string, HostHealth>,
  m: PackMemberStatus,
): HostHealth {
  return map.get(m.id) ?? hostHealth(asServerSummary(m), { at: 0, pollMs: 0 });
}

export function healthWord(health: PackMemberStatus["health"]): string {
  switch (health) {
    case "reachable":
      return t("pack.health.reachable");
    case "unreachable":
      return t("pack.health.unreachable");
    case "incompatible":
      return t("pack.health.incompatible");
    case "conflicted":
      return t("pack.health.conflicted");
  }
}

/**
 * The tone for the health WORD, on the same ladder as the ring above: green is fine, red is go and
 * fix it, and a machine that simply is not answering stays plain — a page where everything shouts
 * says nothing. Never `status-working` for `reachable`: that token means "needs attention".
 */
export function healthTone(health: PackMemberStatus["health"]): string {
  switch (health) {
    case "reachable":
      return "text-status-done";
    case "unreachable":
      return "text-muted-foreground";
    case "incompatible":
    case "conflicted":
      return "text-status-blocked";
  }
}

/** The ring's hue AND its dash — the two encodings, decided together so they cannot drift apart. */
interface RingStyle {
  tone: string;
  /** `undefined` = solid. A stroke pattern in user units, so it scales with the viewBox. */
  dash?: string;
}

/**
 * How a node's ring is drawn.
 *
 * The LOUD states win outright and are drawn solid red: `incompatible` is a version the operator has
 * to go fix, `conflicted` is two collies claiming the same pack. Below them the presented state
 * decides. `stale` takes the amber, because it is a statement about the age of a RECEIPT and never
 * about reachability (lib/host-health.ts) — it is the "look at this" case, not the "it is broken"
 * one. `unknown` is the grey, and it is dotted rather than dashed so it never has to be told apart
 * from amber by hue: we have never heard from that machine at all, which is a different sentence
 * from "we heard from it a while ago".
 */
function ringStyle(m: PackMemberStatus, health: HostHealth): RingStyle {
  if (health.incompatible || m.health === "conflicted") return { tone: "text-status-blocked" };
  if (health.state === "live") return { tone: "text-status-done" };
  if (health.state === "stale") return { tone: "text-status-working", dash: "7 5" };
  return { tone: "text-status-unknown", dash: "2 5" };
}

/**
 * A caption that will not overrun its neighbour. SVG text does not wrap and does not ellipsize, so
 * the budget is counted in characters and the full name lives in the node's `aria-label` — a
 * screen reader is never handed the truncation.
 */
export function clipName(name: string, max = 9): string {
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

/** Roughly how wide a badge has to be for its word at the badge's font size, plus the glyph. */
function badgeWidth(word: string): number {
  return word.length * 5.6 + 26;
}

interface PackFormationProps {
  status: PackStatusResponse;
  health: ReadonlyMap<string, HostHealth>;
  counts: Map<string, HostCounts>;
  onSelect: (member: PackMemberStatus) => void;
}

export function PackFormation({ status, health, counts, onSelect }: PackFormationProps) {
  useLocale();
  const nodes = formationLayout(status.members, status.deputy?.id ?? null);
  const height = formationHeight(nodes);
  const apex = nodes.find((n) => n.role === "lead");
  const reachable = status.members.filter((m) => m.health === "reachable").length;
  // One text node, not three spans: the caption is one sentence and assistive tech (and the tests)
  // should read it as one.
  const caption = `${status.pack.name || status.pack.id} · ${t("pack.summary.counts", {
    machines: tn("pack.summary.machines", status.members.length),
    reachable: t("pack.summary.reachable", { count: reachable }),
  })}`;

  return (
    <div className="flex flex-col items-center gap-3">
      <svg
        viewBox={`0 0 ${VIEW_W} ${height}`}
        className="w-full"
        role="group"
        aria-label={t("pack.formation.aria", {
          machines: tn("pack.summary.machines", status.members.length),
        })}
      >
        {/* Connectors first, so every node body paints over the line that reaches it. */}
        {apex &&
          nodes.map(
            (n) =>
              n !== apex && (
                <path
                  key={`edge-${n.member.id}`}
                  d={spine(apex, n)}
                  fill="none"
                  stroke="currentColor"
                  // The deputy's line is the thick one: the chain of command is the fact this
                  // drawing exists to show, and it must survive being glanced at.
                  strokeWidth={n.role === "deputy" ? 2.5 : 1.25}
                  className={n.role === "deputy" ? "text-border" : "text-border/70"}
                />
              ),
          )}
        {nodes.map((n) => (
          <FormationNodeMark
            key={n.member.id}
            node={n}
            health={memberHealth(health, n.member)}
            counts={countsFor(counts, n.member.id)}
            onSelect={onSelect}
          />
        ))}
      </svg>
      <p className="text-center text-sm text-muted-foreground">{caption}</p>
    </div>
  );
}

/**
 * The connector from the apex to one node.
 *
 * The deputy is on the centre line, so its line is simply the vertical segment between the two rims
 * — the spine, drawn as one.
 *
 * A peer's line LEAVES the lead along the bearing to that peer and ARRIVES vertically. Leaving on a
 * bearing rather than straight down is what keeps the fan from being drawn THROUGH the deputy, which
 * would read as "these machines report to the deputy" — a claim the pack protocol does not make.
 * Arriving vertically is what stops a far-out peer's line from pointing at its node sideways.
 */
function spine(from: FormationNode, to: FormationNode): string {
  const y1 = to.y - NODE_R;
  // The centre-line segment starts BELOW the lead's caption, not at its rim: a vertical line through
  // the middle of the word "bluefin" muddies both. A peer's line leaves on a bearing and misses the
  // caption on its own.
  if (to.x === from.x) return `M ${from.x} ${from.y + NODE_R + CAPTION_CLEAR} L ${to.x} ${y1}`;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  const sx = round(from.x + (dx / len) * NODE_R);
  const sy = round(from.y + (dy / len) * NODE_R);
  return `M ${sx} ${sy} Q ${to.x} ${round((sy + y1) / 2)}, ${to.x} ${y1}`;
}

/** Path data at one decimal — a full float here is twelve characters of noise per coordinate. */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function FormationNodeMark({
  node,
  health,
  counts,
  onSelect,
}: {
  node: FormationNode;
  health: HostHealth;
  counts: HostCounts;
  onSelect: (member: PackMemberStatus) => void;
}) {
  const m = node.member;
  const name = m.name || m.id;
  const ring = ringStyle(m, health);
  const roleWord = node.role === "lead" ? t("connection.host.lead") : t("pack.role.deputy");
  const label =
    node.role === "peer"
      ? t("pack.node.ariaPlain", { name, health: healthWord(m.health) })
      : t("pack.node.aria", { name, role: roleWord, health: healthWord(m.health) });
  const badge = node.role === "peer" ? null : badgeWidth(roleWord);

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={() => onSelect(m)}
      onKeyDown={(e) => {
        // Enter and Space, because this is a `<g>` wearing `role="button"` and the browser gives an
        // SVG element none of a real button's keyboard behaviour for free.
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onSelect(m);
      }}
      className="group cursor-pointer outline-none"
    >
      {/* A transparent disc wider than the body: the tap target is 72px across at phone scale, and
          the ring alone would be a 4px-wide thing to hit with a thumb. */}
      <circle cx={node.x} cy={node.y} r={NODE_R + 10} fill="transparent" />
      {/* The focus indicator is drawn, not inherited: `outline` on an SVG child is not reliably
          painted, so keyboard focus gets a real ring at 3:1 against the page (index.css tunes
          `--ring` for exactly this floor). */}
      <circle
        cx={node.x}
        cy={node.y}
        r={NODE_R + 6}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        className="text-ring opacity-0 group-focus-visible:opacity-100"
      />
      <circle cx={node.x} cy={node.y} r={NODE_R} className="fill-card stroke-border" />
      <circle
        cx={node.x}
        cy={node.y}
        r={NODE_R}
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        strokeDasharray={ring.dash}
        strokeLinecap="round"
        className={cn(
          ring.tone,
          // The page's only motion, and it is spent on the only thing that wants a human: a machine
          // holding a blocked agent. `motion-safe:` means an operator who asked the OS for less
          // motion gets a still picture, which is the whole point of the request.
          counts.blocked > 0 && "motion-safe:animate-pulse",
        )}
      />
      <Server
        x={node.x - 9}
        y={node.y - 9}
        width={18}
        height={18}
        className="text-muted-foreground"
        aria-hidden
      />

      {badge !== null && (
        <g aria-hidden>
          <rect
            x={node.x - badge / 2}
            y={node.y - NODE_R - 28}
            width={badge}
            height={17}
            rx={8.5}
            className="fill-muted"
          />
          {node.role === "lead" ? (
            <Crown
              x={node.x - badge / 2 + 6}
              y={node.y - NODE_R - 25}
              width={11}
              height={11}
              className="text-muted-foreground"
            />
          ) : (
            <Shield
              x={node.x - badge / 2 + 6}
              y={node.y - NODE_R - 25}
              width={11}
              height={11}
              className="text-muted-foreground"
            />
          )}
          <text
            x={node.x - badge / 2 + 20}
            y={node.y - NODE_R - 15.5}
            className="fill-muted-foreground text-[9px] font-medium tracking-wide uppercase"
          >
            {roleWord}
          </text>
        </g>
      )}

      {counts.blocked > 0 && (
        <g aria-hidden>
          <rect
            x={node.x + 10}
            y={node.y - NODE_R - 6}
            width={countPillWidth(counts.blocked)}
            height={16}
            rx={8}
            className="fill-status-blocked"
          />
          <text
            x={node.x + 10 + countPillWidth(counts.blocked) / 2}
            y={node.y - NODE_R + 5.5}
            textAnchor="middle"
            className="fill-background text-[10px] font-semibold"
          >
            {counts.blocked}
          </text>
        </g>
      )}

      <text
        x={node.x}
        y={node.y + NODE_R + 15}
        textAnchor="middle"
        aria-hidden
        className="fill-foreground text-[11px] font-medium"
      >
        {clipName(name)}
      </text>
    </g>
  );
}

/** Wide enough for the digits, never narrower than a circle. */
function countPillWidth(n: number): number {
  return Math.max(16, String(n).length * 7 + 10);
}
