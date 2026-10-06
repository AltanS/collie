import { createElement, on, type Handle, type RemixNode } from "remix/component";
import { Crown, Server, Shield } from "lucide";
import type { IconNode } from "lucide";

import { hostHealth, linkPresentation, type HostHealth } from "@web/lib/host-health";
import { HOST_TEXT_CLASSES, countsFor, hostSlot, type HostCounts } from "@web/lib/hosts";
import { t, tn } from "@web/lib/i18n";
import type { CrewMemberStatus, CrewStatusResponse, ServerSummary } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { useLocale } from "../../lib/i18n-store";

// Port of web/src/components/crew-formation.tsx: the crew census drawn as a FORMATION, not a list.
//
// WHO STANDS WHERE is the question a list cannot answer at a glance: lead at the apex, the deputy
// directly beneath it on a thick connector, everyone else fanned in a V on thin ones. "There is no
// deputy" is a missing row nobody can fail to notice.
//
// ONE inline <svg>, every colour a theme token carried by `currentColor` through a Tailwind `text-*`
// class, so light and dark and the contrast work in index.css apply unchanged.
//
// The ring's hue is the app's own status ladder: green is fine, amber ("status-working", the app's
// "look at this") is a stale receipt, red is go and fix it, grey is "we have nothing to tell you".
// Colour is never the only encoding: the ring also carries a dash (solid = fine, dashed = stale,
// dotted = never seen), every node is captioned with its name, and the health WORD rides in the
// node's `aria-label`.
//
// The geometry is a pure function ({@link formationLayout}): members in, coordinates out, no clock and
// no DOM, so the shape of a 1-, 2-, 3- and 7-machine crew is unit-tested (crew-formation.test.ts).
//
// What changed from React: the component is a Remix component (setup once, props read in render), the
// lucide glyphs inside the drawing are nested `<svg>` elements from the icon data (`ui/icon.tsx`
// draws a standalone one), and the node's click and key handlers are `on()` mixins.

/** The drawing's coordinate space. Scaled to the container width by `viewBox` alone, never px. */
const VIEW_W = 360;
const CX = VIEW_W / 2;
/** The apex. 58, not less: the crown badge sits 54 above the centre and must not clip the top. */
const APEX_Y = 58;
/** Apex to deputy, and (with no deputy) apex to the first fan rank. */
const ROW_GAP = 110;
/** The last centred row to the first fan rank. Wider than ROW_GAP: the V has to read as a new tier. */
const FAN_GAP = 96;
/** Between fan ranks. One rank's caption must clear the next rank's ring, vertically. */
const FAN_DY = 84;
/** The first fan rank's horizontal offset from the centre line, and how much each rank adds. */
const FAN_X0 = 68;
const FAN_DX = 38;
/** Two nodes per rank, three ranks: past six peers the V wraps and a second one starts below. */
const FAN_PER_V = 6;
/** Between the bottom of one V and the top of the next. */
const V_GAP = 80;
/** The node body. 26 is the smallest radius that still holds the glyph AND a 3px ring legibly. */
const NODE_R = 26;
/** Below the lowest node: its caption plus breathing room. */
const BOTTOM_PAD = 44;
/** A node's caption baseline sits `NODE_R + 15` below its centre; this clears its descenders too. */
const CAPTION_CLEAR = 22;

/** Which slot a member occupies. Role names are not translated (ADR 0030's exclusion list). */
export type FormationRole = "lead" | "deputy" | "peer";

/** One member's place in the drawing. `row` is 0 for the apex, 1 for the deputy, 2+ for fan ranks. */
export interface FormationNode {
  member: CrewMemberStatus;
  role: FormationRole;
  x: number;
  y: number;
  row: number;
}

/**
 * Where every member stands. Pure: same members in, same coordinates out.
 *
 * Row 0 is the lead, alone on the centre line. Row 1 is the deputy if one is named, also centred, and
 * SKIPPED if none is, so a crew that named nobody is visibly one tier shallower. Everyone else fans
 * out below in ranks of two, LEFT first, each rank `FAN_DX` wider and `FAN_DY` lower. Past
 * {@link FAN_PER_V} peers a second V starts below the first. A member listed twice, or a `deputyId`
 * naming nobody, degrades to "peer": a malformed census must still draw.
 */
export function formationLayout(members: readonly CrewMemberStatus[], deputyId: string | null): FormationNode[] {
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

  // The fan's own origin, so a crew with no lead at all still starts its V at the top.
  const fanTop = nodes.length === 0 ? APEX_Y : y + FAN_GAP;
  const baseRow = nodes.length;
  for (const [i, member] of peers.entries()) {
    const v = Math.floor(i / FAN_PER_V);
    const within = i % FAN_PER_V;
    const rank = Math.floor(within / 2);
    // Left first: a lone peer sits left of centre on purpose, since a node ON the centre line would
    // read as a third tier of the spine.
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

/** The census row read as a roster entry: the two shapes overlap exactly where health lives. */
export function asServerSummary(m: CrewMemberStatus): ServerSummary {
  return {
    id: m.id,
    name: m.name,
    isLead: m.isLead,
    // Only `reachable` is a green light. `conflicted` is NOT: two collies believing they lead the
    // same crew is the one state where a write could land somewhere unintended.
    reachable: m.health === "reachable",
    protocol: m.health === "incompatible" ? "incompatible" : m.lastSeenAt > 0 ? "ok" : "unknown",
    protocolDetail: m.reason,
    lastSeenAt: m.lastSeenAt,
    // Carried, not re-derived: an absent value stays absent all the way to `linkPresentation`.
    linkState: m.linkState,
  };
}

/**
 * The tier-2 health for a member. The snapshot-derived map is the answer wherever there is one, so
 * this page and the switcher can never disagree. The fallback is derived from THIS payload:
 * `hostHealth` with `at: 0` skips the §10.2 tolerance and presents the lead's plain boolean.
 */
export function memberHealth(map: ReadonlyMap<string, HostHealth>, m: CrewMemberStatus): HostHealth {
  return map.get(m.id) ?? hostHealth(asServerSummary(m), { at: 0, pollMs: 0 });
}

/** The two facts the health word and its tone are read from. A member row, or anything shaped like one. */
export type MemberLink = Pick<CrewMemberStatus, "health" | "linkState">;

/**
 * §10.2's presentation split for an `unreachable` member, and only for that one. `incompatible` and
 * `conflicted` keep their own words: each already names what the operator has to go and fix.
 */
function unreachableReading(m: MemberLink): ReturnType<typeof linkPresentation> {
  return linkPresentation(m.health !== "reachable", m.linkState);
}

/** The word for one reading. `ok` cannot reach here, and `unreachable` is the old undifferentiated word. */
function unreachableWord(reading: ReturnType<typeof linkPresentation>): string {
  if (reading === "reconnecting") return t("connection.host.reconnecting");
  if (reading === "attention") return t("connection.host.attention");
  return t("crew.health.unreachable");
}

export function healthWord(m: MemberLink): string {
  switch (m.health) {
    case "reachable":
      return t("crew.health.reachable");
    case "unreachable":
      return unreachableWord(unreachableReading(m));
    case "incompatible":
      return t("crew.health.incompatible");
    case "conflicted":
      return t("crew.health.conflicted");
  }
}

/**
 * The tone for the health WORD, on the same ladder as the ring: green is fine, red is go and fix it,
 * and a machine that simply is not answering stays plain. Never `status-working` for `reachable`:
 * that token means "needs attention".
 */
export function healthTone(m: MemberLink): string {
  switch (m.health) {
    case "reachable":
      return "text-status-done";
    case "unreachable":
      // The same reading the WORD came from, so the two cannot drift.
      return unreachableReading(m) === "attention" ? "text-status-blocked" : "text-muted-foreground";
    case "incompatible":
    case "conflicted":
      return "text-status-blocked";
  }
}

/** The ring's hue AND its dash, decided together so they cannot drift apart. */
interface RingStyle {
  tone: string;
  /** `undefined` = solid. A stroke pattern in user units, so it scales with the viewBox. */
  dash?: string;
}

/**
 * How a node's ring is drawn. The LOUD states win and are drawn solid red: `incompatible`,
 * `conflicted`, and an `attention` link. Below them the presented state decides: `stale` takes the
 * amber and a dash, `unknown` the grey and a dot pattern, so the two never have to be told apart by
 * hue alone.
 */
export function ringStyle(m: CrewMemberStatus, health: HostHealth): RingStyle {
  if (health.incompatible || m.health === "conflicted" || unreachableReading(m) === "attention") {
    return { tone: "text-status-blocked" };
  }
  if (health.state === "live") return { tone: "text-status-done" };
  if (health.state === "stale") return { tone: "text-status-working", dash: "7 5" };
  return { tone: "text-status-unknown", dash: "2 5" };
}

/**
 * A caption that will not overrun its neighbour. SVG text does not wrap and does not ellipsize, so
 * the budget is counted in characters and the full name lives in the node's `aria-label`.
 */
export function clipName(name: string, max = 9): string {
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

/** Roughly how wide a badge has to be for its word at the badge's font size, plus the glyph. */
function badgeWidth(word: string): number {
  return word.length * 5.6 + 26;
}

/** Wide enough for the digits, never narrower than a circle. */
function countPillWidth(n: number): number {
  return Math.max(16, String(n).length * 7 + 10);
}

/** Path data at one decimal: a full float here is twelve characters of noise per coordinate. */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * The connector from the apex to one node. The deputy is on the centre line, so its line is the
 * vertical segment below the lead's caption. A peer's line LEAVES the lead along the bearing to that
 * peer and ARRIVES vertically: leaving on a bearing keeps the fan from being drawn THROUGH the deputy
 * (which would claim "these machines report to the deputy"), arriving vertically stops a far-out
 * peer's line from pointing at its node sideways.
 */
export function spine(from: FormationNode, to: FormationNode): string {
  const y1 = to.y - NODE_R;
  if (to.x === from.x) return `M ${from.x} ${from.y + NODE_R + CAPTION_CLEAR} L ${to.x} ${y1}`;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  const sx = round(from.x + (dx / len) * NODE_R);
  const sy = round(from.y + (dy / len) * NODE_R);
  return `M ${sx} ${sy} Q ${to.x} ${round((sy + y1) / 2)}, ${to.x} ${y1}`;
}

/** A lucide glyph placed inside the drawing: a nested `<svg>` with the icon's own 24-unit box. */
function glyph(icon: IconNode, x: number, y: number, size: number, className: string): RemixNode {
  return (
    <svg
      x={x}
      y={y}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={2}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={cn("lucide", className)}
    >
      {icon.map(([tag, attrs]) => {
        const { key: _key, ...rest } = attrs;
        return createElement(tag, rest);
      })}
    </svg>
  );
}

export interface CrewFormationProps {
  status: CrewStatusResponse;
  health: ReadonlyMap<string, HostHealth>;
  counts: Map<string, HostCounts>;
  /**
   * The SNAPSHOT's roster, where the per-host identity tint is assigned (lib/hosts.ts). The census
   * names the same machines, but the colours must come from the roster the dashboard used or a
   * machine would change colour between two screens. A member the snapshot does not list goes untinted.
   */
  servers?: readonly ServerSummary[];
  onSelect: (member: CrewMemberStatus) => void;
}

export function CrewFormation(handle: Handle<CrewFormationProps>) {
  useLocale(handle);
  return () => {
    const { status, health, counts, servers, onSelect } = handle.props;
    const nodes = formationLayout(status.members, status.deputy?.id ?? null);
    const height = formationHeight(nodes);
    const apex = nodes.find((n) => n.role === "lead");
    const reachable = status.members.filter((m) => m.health === "reachable").length;
    // One text node, not three spans: the caption is one sentence and assistive tech reads it as one.
    const caption = `${status.crew.name || status.crew.id} · ${t("crew.summary.counts", {
      machines: tn("crew.summary.machines", status.members.length),
      reachable: t("crew.summary.reachable", { count: reachable }),
    })}`;
    return (
      <div class="flex flex-col items-center gap-3">
        <svg
          viewBox={`0 0 ${VIEW_W} ${height}`}
          class="w-full"
          role="group"
          aria-label={t("crew.formation.aria", { machines: tn("crew.summary.machines", status.members.length) })}
        >
          {/* Connectors first, so every node body paints over the line that reaches it. */}
          {apex
            ? nodes
                .filter((n) => n !== apex)
                .map((n) => (
                  <path
                    key={`edge-${n.member.id}`}
                    d={spine(apex, n)}
                    fill="none"
                    stroke="currentColor"
                    // The deputy's line is the thick one: the chain of command is the fact this
                    // drawing exists to show, and it must survive being glanced at.
                    stroke-width={n.role === "deputy" ? 2.5 : 1.25}
                    class={n.role === "deputy" ? "text-border" : "text-border/70"}
                  />
                ))
            : null}
          {nodes.map((n) => (
            <FormationNodeMark
              key={n.member.id}
              node={n}
              health={memberHealth(health, n.member)}
              counts={countsFor(counts, n.member.id)}
              slot={hostSlot(servers, n.member.id)}
              onSelect={onSelect}
            />
          ))}
        </svg>
        <p class="text-center text-sm text-muted-foreground">{caption}</p>
      </div>
    );
  };
}

interface NodeMarkProps {
  node: FormationNode;
  health: HostHealth;
  counts: HostCounts;
  /** The machine's identity tint, or `null` for none (see {@link CrewFormationProps.servers}). */
  slot: number | null;
  onSelect: (member: CrewMemberStatus) => void;
}

function FormationNodeMark(handle: Handle<NodeMarkProps>) {
  const select = (): void => handle.props.onSelect(handle.props.node.member);
  return () => {
    const { node, health, counts, slot } = handle.props;
    const m = node.member;
    const name = m.name || m.id;
    const ring = ringStyle(m, health);
    const roleWord = node.role === "lead" ? t("connection.host.lead") : t("crew.role.deputy");
    const label =
      node.role === "peer"
        ? t("crew.node.ariaPlain", { name, health: healthWord(m) })
        : t("crew.node.aria", { name, role: roleWord, health: healthWord(m) });
    const badge = node.role === "peer" ? null : badgeWidth(roleWord);
    return (
      <g
        role="button"
        tabIndex={0}
        aria-label={label}
        mix={[
          on("click", select),
          on("keydown", (e) => {
            // Enter and Space: a `<g>` wearing `role="button"` gets none of a real button's keys.
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            select();
          }),
        ]}
        class="group cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {/* A transparent disc wider than the body: the tap target is 72px across at phone scale. */}
        <circle cx={node.x} cy={node.y} r={NODE_R + 10} fill="transparent" />
        {/* The focus indicator is drawn, not inherited: `outline` on an SVG child is not reliably
            painted, so keyboard focus gets a real ring at 3:1 against the page. */}
        <circle
          cx={node.x}
          cy={node.y}
          r={NODE_R + 6}
          fill="none"
          stroke="currentColor"
          stroke-width={2}
          class="text-ring opacity-0 group-focus-visible:opacity-100"
        />
        <circle cx={node.x} cy={node.y} r={NODE_R} class="fill-card stroke-border" />
        <circle
          cx={node.x}
          cy={node.y}
          r={NODE_R}
          fill="none"
          stroke="currentColor"
          stroke-width={3}
          stroke-dasharray={ring.dash}
          stroke-linecap="round"
          class={cn(
            ring.tone,
            // The page's only motion, spent on the only thing that wants a human: a machine holding
            // a blocked agent. `motion-safe:` gives an operator who asked for less a still picture.
            counts.blocked > 0 && "motion-safe:animate-pulse",
          )}
        />
        {/* The glyph carries the identity tint; the RING carries health. The two never share a
            colour: the host hues avoid every status hue (index.css). */}
        {glyph(Server, node.x - 9, node.y - 9, 18, slot === null ? "text-muted-foreground" : (HOST_TEXT_CLASSES[slot] ?? "text-muted-foreground"))}

        {badge !== null ? (
          <g aria-hidden="true">
            <rect x={node.x - badge / 2} y={node.y - NODE_R - 28} width={badge} height={17} rx={8.5} class="fill-muted" />
            {glyph(node.role === "lead" ? Crown : Shield, node.x - badge / 2 + 6, node.y - NODE_R - 25, 11, "text-muted-foreground")}
            <text
              x={node.x - badge / 2 + 20}
              y={node.y - NODE_R - 15.5}
              class="fill-muted-foreground text-[9px] font-medium tracking-wide uppercase"
            >
              {roleWord}
            </text>
          </g>
        ) : null}

        {counts.blocked > 0 ? (
          <g aria-hidden="true">
            <rect
              x={node.x + 10}
              y={node.y - NODE_R - 6}
              width={countPillWidth(counts.blocked)}
              height={16}
              rx={8}
              class="fill-status-blocked"
            />
            <text
              x={node.x + 10 + countPillWidth(counts.blocked) / 2}
              y={node.y - NODE_R + 5.5}
              text-anchor="middle"
              class="fill-background text-[10px] font-semibold"
            >
              {counts.blocked}
            </text>
          </g>
        ) : null}

        <text
          x={node.x}
          y={node.y + NODE_R + 15}
          text-anchor="middle"
          aria-hidden="true"
          class="fill-foreground text-[11px] font-medium"
        >
          {clipName(name)}
        </text>
      </g>
    );
  };
}
