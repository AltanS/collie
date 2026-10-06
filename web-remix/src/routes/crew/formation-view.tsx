// The crew census as ONE inline <svg> (web/src/components/crew-formation.tsx; the geometry and the
// words are `formation.ts`). No chart library: eleven circles and some cubics. Every colour is a THEME
// TOKEN carried by `currentColor` through a `text-*` class, so light and dark apply unchanged. A node
// is a `<g role="button">`: Enter and Space open it, because an SVG child gets none of a button's
// keyboard behaviour for free. Tapping a node means "tell me about this one" and changes nothing.
import { on, type Handle } from "remix/component";
import { Crown, Server, Shield, type IconNode } from "lucide";

import type { HostHealth } from "@web/lib/host-health";
import { countsFor, hostSlot, HOST_TEXT_CLASSES, type HostCounts } from "@web/lib/hosts";
import { t, tn } from "@web/lib/i18n";
import type { CrewMemberStatus, CrewStatusResponse, ServerSummary } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { useLocale } from "../../lib/i18n-store";
import { Icon } from "../../ui/icon";
import {
  NODE_R,
  VIEW_W,
  badgeWidth,
  clipName,
  countPillWidth,
  formationHeight,
  formationLayout,
  healthWord,
  memberHealth,
  ringStyle,
  spine,
  type FormationNode,
} from "./formation";

export interface CrewFormationProps {
  status: CrewStatusResponse;
  health: ReadonlyMap<string, HostHealth>;
  counts: Map<string, HostCounts>;
  /** The SNAPSHOT's roster: the per-host identity tint is assigned from it, so a machine keeps its colour across screens. */
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
    // One text node, not three spans: the caption is one sentence.
    const caption = `${status.crew.name || status.crew.id} · ${t("crew.summary.counts", {
      machines: tn("crew.summary.machines", status.members.length),
      reachable: t("crew.summary.reachable", { count: reachable }),
    })}`;
    return (
      <div class="flex flex-col items-center gap-3" data-testid="crew-formation">
        <svg
          viewBox={`0 0 ${String(VIEW_W)} ${String(height)}`}
          class="w-full"
          role="group"
          aria-label={t("crew.formation.aria", { machines: tn("crew.summary.machines", status.members.length) })}
        >
          {/* Connectors first, so every node body paints over the line that reaches it. */}
          {apex === undefined
            ? null
            : nodes.map((n) =>
                n === apex ? null : (
                  <path
                    key={`edge-${n.member.id}`}
                    d={spine(apex, n)}
                    fill="none"
                    stroke="currentColor"
                    // The deputy's line is the thick one: the chain of command is the fact this drawing shows.
                    stroke-width={n.role === "deputy" ? 2.5 : 1.25}
                    class={n.role === "deputy" ? "text-border" : "text-border/70"}
                  />
                ),
              )}
          {nodes.map((n) => (
            <NodeMark
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
  /** The machine's identity tint, or `null` for none. */
  slot: number | null;
  onSelect: (member: CrewMemberStatus) => void;
}

/** An icon at a point of the drawing, at a size in drawing units. */
function Glyph(handle: Handle<{ icon: IconNode; x: number; y: number; size: number; class?: string }>) {
  return () => {
    const { icon, x, y, size } = handle.props;
    return (
      <g transform={`translate(${String(x)} ${String(y)})`}>
        <svg width={size} height={size} viewBox="0 0 24 24">
          <Icon icon={icon} class={cn("size-full", handle.props.class)} />
        </svg>
      </g>
    );
  };
}

function NodeMark(handle: Handle<NodeMarkProps>) {
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
    const select = (): void => handle.props.onSelect(handle.props.node.member);
    return (
      <g
        role="button"
        tabindex={0}
        aria-label={label}
        data-testid="crew-node"
        data-member-id={m.id}
        mix={[
          on("click", select),
          on("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            select();
          }),
        ]}
        class="group cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {/* A transparent disc wider than the body: the tap target is 72px across at phone scale. */}
        <circle cx={node.x} cy={node.y} r={NODE_R + 10} fill="transparent" />
        {/* The focus indicator is drawn, not inherited: `outline` on an SVG child is not reliably painted. */}
        <circle
          cx={node.x}
          cy={node.y}
          r={NODE_R + 6}
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          class="text-ring opacity-0 group-focus-visible:opacity-100"
        />
        <circle cx={node.x} cy={node.y} r={NODE_R} class="fill-card stroke-border" />
        <circle
          cx={node.x}
          cy={node.y}
          r={NODE_R}
          fill="none"
          stroke="currentColor"
          stroke-width="3"
          stroke-dasharray={ring.dash}
          stroke-linecap="round"
          // The page's only motion, spent on the only thing that wants a human: a machine holding a blocked agent.
          class={cn(ring.tone, counts.blocked > 0 && "motion-safe:animate-pulse")}
        />
        {/* The glyph carries the identity tint; the RING carries health, and the two never share a colour. */}
        <Glyph icon={Server} x={node.x - 9} y={node.y - 9} size={18} class={slot === null ? "text-muted-foreground" : (HOST_TEXT_CLASSES[slot] ?? "text-muted-foreground")} />

        {badge === null ? null : (
          <g aria-hidden="true">
            <rect x={node.x - badge / 2} y={node.y - NODE_R - 28} width={badge} height="17" rx="8.5" class="fill-muted" />
            <Glyph
              icon={node.role === "lead" ? Crown : Shield}
              x={node.x - badge / 2 + 6}
              y={node.y - NODE_R - 25}
              size={11}
              class="text-muted-foreground"
            />
            <text
              x={node.x - badge / 2 + 20}
              y={node.y - NODE_R - 15.5}
              class="fill-muted-foreground text-[9px] font-medium tracking-wide uppercase"
            >
              {roleWord}
            </text>
          </g>
        )}

        {counts.blocked > 0 ? (
          <g aria-hidden="true">
            <rect x={node.x + 10} y={node.y - NODE_R - 6} width={countPillWidth(counts.blocked)} height="16" rx="8" class="fill-status-blocked" />
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

        <text x={node.x} y={node.y + NODE_R + 15} text-anchor="middle" aria-hidden="true" class="fill-foreground text-[11px] font-medium">
          {clipName(name)}
        </text>
      </g>
    );
  };
}
