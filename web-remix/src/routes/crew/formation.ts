// The crew census drawn as a FORMATION: the pure half (geometry, health words, ring styles).
// Ported from web/src/components/crew-formation.tsx, whose file also holds React and so cannot be
// imported; `formation.test.ts` pins the shapes of a 1-, 2-, 3- and 7-machine crew.
//
// WHY A PICTURE: a list answers "how is each machine"; the question it never answers at a glance is
// WHO STANDS WHERE. Lead at the apex, deputy directly beneath it on a thick connector, everyone else
// fanned in a V on thin ones, so "there is no deputy" is a missing row you cannot fail to notice.
//
// THE RING'S HUE IS THE APP'S OWN STATUS VOCABULARY: green is fine (`status-done`), amber is look at
// this (`status-working`, earned by a stale receipt), red is go fix this, grey is "nothing to tell
// you". COLOUR IS NEVER THE ONLY ENCODING: the ring also carries a dash pattern (solid = fine, dashed =
// stale, dotted = never seen), every node is captioned with its name, and the health WORD rides in the
// node's `aria-label` and again in the sheet.
import { hostHealth, linkPresentation, type HostHealth } from "@web/lib/host-health";
import { t } from "@web/lib/i18n";
import type { CrewMemberStatus, ServerSummary } from "@web/lib/types";

/** The drawing's coordinate space. Scaled to the container width by `viewBox` alone, never px. */
export const VIEW_W = 360;
const CX = VIEW_W / 2;
/** The apex. 58, not less: the crown badge sits 54 above the centre and must not clip the top. */
const APEX_Y = 58;
/** Apex to deputy. */
const ROW_GAP = 110;
/** The last centred row to the first fan rank. Wider than ROW_GAP: the V has to read as a new tier. */
const FAN_GAP = 96;
/** Between fan ranks. Large enough that one rank's caption clears the next rank's ring. */
const FAN_DY = 84;
/** The first fan rank's horizontal offset from the centre line, and how much each rank adds. */
const FAN_X0 = 68;
const FAN_DX = 38;
/** Two nodes per rank, three ranks: past six peers the V wraps and a second one starts below. */
const FAN_PER_V = 6;
/** Between the bottom of one V and the top of the next. */
const V_GAP = 80;
/** The node body. 26 is the smallest radius that still holds the glyph AND a 3px ring legibly. */
export const NODE_R = 26;
/** Below the lowest node: its caption plus breathing room. */
const BOTTOM_PAD = 44;
/** A node's caption sits `NODE_R + 15` below its centre; this clears its descenders too. */
export const CAPTION_CLEAR = 22;

/** Which slot a member occupies. Role names are not translated. */
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
 * Where every member stands. Pure: same members in, same coordinates out, no clock and no DOM.
 * A member listed twice, or a `deputyId` naming nobody, degrades to "peer" rather than throwing:
 * a status page must still draw a malformed census.
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

  const fanTop = nodes.length === 0 ? APEX_Y : y + FAN_GAP;
  const baseRow = nodes.length;
  for (const [i, member] of peers.entries()) {
    const v = Math.floor(i / FAN_PER_V);
    const within = i % FAN_PER_V;
    const rank = Math.floor(within / 2);
    // Left first: a lone peer sits left of centre, because a node ON the centre line would read as a
    // third tier of the spine.
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
    // Only `reachable` is a green light. `conflicted` is NOT: two collies believing they lead the same
    // crew is the one state where a write could land somewhere unintended.
    reachable: m.health === "reachable",
    protocol: m.health === "incompatible" ? "incompatible" : m.lastSeenAt > 0 ? "ok" : "unknown",
    protocolDetail: m.reason,
    lastSeenAt: m.lastSeenAt,
    // Carried, not re-derived: the lead decided the split on the answer itself (§10.2).
    linkState: m.linkState,
  };
}

/**
 * The tier-2 health for a member: the snapshot-derived map wherever there is one, so this page and
 * the switcher never disagree; else derived from THIS payload (`at: 0` skips the §10.2 tolerance and
 * presents the lead's plain boolean).
 */
export function memberHealth(map: ReadonlyMap<string, HostHealth>, m: CrewMemberStatus): HostHealth {
  return map.get(m.id) ?? hostHealth(asServerSummary(m), { at: 0, pollMs: 0 });
}

/** The two facts the health word and its tone are read from. A member row, or anything shaped like one. */
export type MemberLink = Pick<CrewMemberStatus, "health" | "linkState">;

/** §10.2's presentation split for an `unreachable` member, and only for that one. */
function unreachableReading(m: MemberLink): ReturnType<typeof linkPresentation> {
  return linkPresentation(m.health !== "reachable", m.linkState);
}

function unreachableWord(reading: ReturnType<typeof linkPresentation>): string {
  if (reading === "reconnecting") return t("connection.host.reconnecting");
  if (reading === "attention") return t("connection.host.attention");
  // `ok` cannot reach here, and `unreachable` is the undifferentiated old word a lead without the field sends.
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
 * The tone for the health WORD: green is fine, red is go and fix it, and a machine that simply is not
 * answering stays plain. Never `status-working` for `reachable`: that token means "needs attention".
 */
export function healthTone(m: MemberLink): string {
  switch (m.health) {
    case "reachable":
      return "text-status-done";
    case "unreachable":
      return unreachableReading(m) === "attention" ? "text-status-blocked" : "text-muted-foreground";
    case "incompatible":
    case "conflicted":
      return "text-status-blocked";
  }
}

/** The ring's hue AND its dash, decided together so they cannot drift apart. */
export interface RingStyle {
  tone: string;
  /** `undefined` = solid. A stroke pattern in user units, so it scales with the viewBox. */
  dash?: string;
}

export function ringStyle(m: CrewMemberStatus, health: HostHealth): RingStyle {
  // `attention` joins the loud two: the lead says dialling again will not fix this. `reconnecting`
  // falls through to the presented state and takes the amber a stale receipt takes.
  if (health.incompatible || m.health === "conflicted" || unreachableReading(m) === "attention") {
    return { tone: "text-status-blocked" };
  }
  if (health.state === "live") return { tone: "text-status-done" };
  if (health.state === "stale") return { tone: "text-status-working", dash: "7 5" };
  return { tone: "text-status-unknown", dash: "2 5" };
}

/**
 * A caption that will not overrun its neighbour. SVG text does not wrap and does not ellipsize, so the
 * budget is counted in characters and the full name lives in the node's `aria-label`.
 */
export function clipName(name: string, max = 9): string {
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

/** Roughly how wide a badge has to be for its word at the badge's font size, plus the glyph. */
export function badgeWidth(word: string): number {
  return word.length * 5.6 + 26;
}

/** Wide enough for the digits, never narrower than a circle. */
export function countPillWidth(n: number): number {
  return Math.max(16, String(n).length * 7 + 10);
}

/** Path data at one decimal: a full float is twelve characters of noise per coordinate. */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * The connector from the apex to one node. The deputy is on the centre line, so its line is the
 * vertical segment below the lead's caption. A peer's line LEAVES the lead along the bearing to that
 * peer and ARRIVES vertically, which keeps the fan from being drawn THROUGH the deputy (that would
 * read as "these machines report to the deputy", a claim the crew protocol does not make).
 */
export function spine(from: FormationNode, to: FormationNode): string {
  const y1 = to.y - NODE_R;
  if (to.x === from.x) return `M ${String(from.x)} ${String(from.y + NODE_R + CAPTION_CLEAR)} L ${String(to.x)} ${String(y1)}`;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  const sx = round(from.x + (dx / len) * NODE_R);
  const sy = round(from.y + (dy / len) * NODE_R);
  return `M ${String(sx)} ${String(sy)} Q ${String(to.x)} ${String(round((sy + y1) / 2))}, ${String(to.x)} ${String(y1)}`;
}
