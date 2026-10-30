import { Server } from "lucide-react";

import { CrewRoleBadge } from "@/components/crew-role-badge";
import { healthTone, healthWord } from "@/components/crew-formation";
import { Card } from "@/components/ui/card";
import { useLocale } from "@/hooks/use-locale";
import { HOST_TEXT_CLASSES, countsFor, hostSlot, type HostCounts } from "@/lib/hosts";
import { t, tn } from "@/lib/i18n";
import type { Machine, MachineHealth } from "@/lib/machines";
import { instanceLabel } from "@/lib/machines";
import type { CrewMemberStatus, CrewStatusResponse, ServerSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

// The crew census for a crew where one host runs more than one Collie instance (M77): one card per
// MACHINE, one line per instance inside it.
//
// ── WHY NOT THE FORMATION ────────────────────────────────────────────────────
// The formation draws one node per member, so a host running the Herdr TUI and Herdr core side by
// side reads as two machines. Here the host is the card and the instances are its lines, and the
// card's header carries the machine's health as a SUM (lib/machines.ts): `ok` when every instance
// answers, `degraded` when some do not, `down` when none does, with the down ones named. A crew where
// every host runs one instance still gets the formation, unchanged (routes/crew.tsx decides).
//
// ── A LINE IS THE NODE'S TAP ─────────────────────────────────────────────────
// Tapping an instance line opens its paperwork, exactly as tapping a node does. The line never
// navigates on its own: "Go to this machine" stays a second, deliberate tap inside the sheet.

interface CrewMachinesProps {
  status: CrewStatusResponse;
  machines: readonly Machine[];
  counts: Map<string, HostCounts>;
  /** The snapshot's roster, for the identity tint (see CrewFormation's `servers`). */
  servers?: readonly ServerSummary[];
  onSelect: (member: CrewMemberStatus) => void;
}

/** The machine's summed health, in the crew page's existing words where one fits. */
function machineWord(h: MachineHealth): string {
  if (h === "ok") return t("crew.health.reachable");
  if (h === "degraded") return t("crew.machine.degraded");
  return t("crew.health.unreachable");
}

/** Green is fine, amber is look at this, red is go and fix it: the formation ring's ladder. */
function machineTone(h: MachineHealth): string {
  if (h === "ok") return "text-status-done";
  if (h === "degraded") return "text-status-working";
  return "text-status-blocked";
}

export function CrewMachines({ status, machines, counts, servers, onSelect }: CrewMachinesProps) {
  useLocale();
  const instances = machines.reduce((n, m) => n + m.instances.length, 0);
  const reachable = status.members.filter((m) => m.health === "reachable").length;
  // One text node, as the formation's caption is: the crew, how many machines, how much answers.
  const caption = `${status.crew.name || status.crew.id} · ${t("crew.summary.counts", {
    machines: tn("crew.summary.machines", machines.length),
    reachable: t("crew.summary.instancesReachable", { reachable, total: instances }),
  })}`;

  return (
    <div className="flex flex-col gap-3">
      <ul
        className="flex flex-col gap-3"
        aria-label={t("crew.formation.aria", { machines: tn("crew.summary.machines", machines.length) })}
      >
        {machines.map((machine) => (
          <li key={machine.key}>
            <MachineCard
              machine={machine}
              status={status}
              counts={counts}
              slot={hostSlot(servers, machine.instances[0]!.id)}
              onSelect={onSelect}
            />
          </li>
        ))}
      </ul>
      <p className="text-center text-sm text-muted-foreground">{caption}</p>
    </div>
  );
}

function MachineCard({
  machine,
  status,
  counts,
  slot,
  onSelect,
}: {
  machine: Machine;
  status: CrewStatusResponse;
  counts: Map<string, HostCounts>;
  slot: number | null;
  onSelect: (member: CrewMemberStatus) => void;
}) {
  const word = machineWord(machine.health);
  return (
    <Card
      role="group"
      aria-label={t("crew.node.ariaPlain", { name: machine.name, health: word })}
      className="gap-0 py-0"
      data-slot="crew-machine"
    >
      <div className="flex items-start gap-2.5 px-3.5 py-3">
        {/* The identity tint on the glyph, never a wash (DESIGN.md "Host colour is an identity"). */}
        <Server
          className={cn("mt-0.5 size-4 shrink-0", slot === null ? "text-muted-foreground" : HOST_TEXT_CLASSES[slot])}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-sm font-medium">{machine.name}</span>
            <span className={cn("shrink-0 text-xs font-medium", machineTone(machine.health))}>{word}</span>
          </div>
          {machine.downInstances.length > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("crew.machine.unreachable", { instances: machine.downInstances.join(", ") })}
            </p>
          )}
        </div>
      </div>
      <ul className="divide-y divide-border border-t border-border">
        {machine.instances.map((s) => {
          const member = status.members.find((m) => m.id === s.id);
          if (member === undefined) return null;
          return (
            <li key={s.id}>
              <InstanceLine
                member={member}
                label={instanceLabel(s, machine.instances)}
                isDeputy={status.deputy !== null && status.deputy.id === s.id}
                counts={countsFor(counts, s.id)}
                onSelect={onSelect}
              />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function InstanceLine({
  member,
  label,
  isDeputy,
  counts,
  onSelect,
}: {
  member: CrewMemberStatus;
  label: string;
  isDeputy: boolean;
  counts: HostCounts;
  onSelect: (member: CrewMemberStatus) => void;
}) {
  const name = member.name || member.id;
  const role = member.isLead ? "lead" : isDeputy ? "deputy" : null;
  const aria =
    role === null
      ? t("crew.node.ariaPlain", { name, health: healthWord(member) })
      : t("crew.node.aria", {
          name,
          role: role === "lead" ? t("connection.host.lead") : t("crew.role.deputy"),
          health: healthWord(member),
        });
  return (
    <button
      type="button"
      onClick={() => onSelect(member)}
      aria-label={aria}
      className="flex min-h-11 w-full flex-col gap-0.5 px-3.5 py-2 text-left transition-colors hover:bg-accent active:bg-accent"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-sm">{label}</span>
        {label !== name && <span className="truncate font-mono text-[11px] text-muted-foreground">{name}</span>}
        {role !== null && <CrewRoleBadge kind={role} />}
      </span>
      <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        {member.version !== undefined && <span className="tabular-nums">{member.version}</span>}
        {member.version !== undefined && <span aria-hidden>·</span>}
        <span className="tabular-nums">{tn("home.workspace.paneCount", counts.agents)}</span>
        <span aria-hidden>·</span>
        <span className={healthTone(member)}>{healthWord(member)}</span>
        {counts.blocked > 0 && (
          <span className="ml-1 rounded-md border border-status-blocked/30 bg-status-blocked/15 px-1.5 py-0.5 text-[10px] font-medium text-status-blocked">
            {tn("status.count.needsYou", counts.blocked)}
          </span>
        )}
      </span>
    </button>
  );
}
