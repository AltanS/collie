import { ProgramSpaceRow } from "@/components/program-space-row";
import { SectionHeader } from "@/components/section-header";
import { ListGroup } from "@/components/ui/list-group";
import { useLocale } from "@/hooks/use-locale";
import { hostName, leadHost } from "@/lib/hosts";
import { t } from "@/lib/i18n";
import { normalizeHost } from "@/lib/scope";
import type { ServerSummary, SessionSummary } from "@/lib/types";

// THE PROGRAMS SECTION (M55 spec 13): the dashboard's list of program sessions, one row each, apart from
// the Spaces list. A program is not one more terminal workspace, and the one thing it exists for, a
// question that waits on you, should not sit at the end of forty spaces.
//
// Where it sits is the route's call (`routes/home.tsx`, through lib/session-cards.ts `programsAbove`):
// above the spaces while a question waits, below them otherwise. This file draws the section and nothing
// around it, and draws NOTHING with no program session: no header, no group, no node, so a dashboard with
// no program is the markup it always was.
//
// In a crew it is one section for every machine. A member's program names the member after its place,
// the way the rest of the dashboard names a peer; the lead's own programs name no machine.
//
// The section's shape is the Spaces list's: the same 16px gutter, the same heading, the same flat rows in
// one `ui/list-group.tsx`. It does not fold: it is short, and folding a question away defeats it.

const NO_SERVERS: readonly ServerSummary[] = [];

/** The member to name on a program's row: none for the lead's own (or on a solo install). */
function memberOf(session: SessionSummary, servers: readonly ServerSummary[]): string | undefined {
  const host = normalizeHost(session.host);
  if (host === undefined || host === leadHost(servers)) return undefined;
  return hostName(servers, host) ?? host;
}

export function ProgramSection({
  programs,
  servers = NO_SERVERS,
  onOpen,
}: {
  /** The program sessions to list, in order (lib/session-cards.ts `programSessions`). */
  programs: readonly SessionSummary[];
  /** The crew roster, for the member names. Absent on a solo install. */
  servers?: readonly ServerSummary[];
  /** Open a program session's home, its conversation list. */
  onOpen: (session: SessionSummary) => void;
}) {
  useLocale();
  if (programs.length === 0) return null;
  return (
    <section data-slot="program-section" className="flex flex-col gap-2 px-4 py-4">
      <SectionHeader label={t("home.programs.title")} count={programs.length} />
      <ListGroup id="programs-body">
        {programs.map((session) => (
          <ProgramSpaceRow
            key={`${normalizeHost(session.host) ?? ""}\n${session.name}`}
            session={session}
            member={memberOf(session, servers)}
            onOpen={onOpen}
          />
        ))}
      </ListGroup>
    </section>
  );
}
