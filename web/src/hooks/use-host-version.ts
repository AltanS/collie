import { useEffect, useState } from "react";

import { useCrew } from "@/components/crew-provider";
import { fetchCrew } from "@/lib/api";

// The Collie version of the machine that owns a pane, for the one question the phone asks of it: does it
// keep pins (M90, lib/message-pins.ts `hostKeepsPins`).
//
// The snapshot's roster carries no version, so a MEMBER's is read once from the lead's census (`GET
// /api/crew`, a read, lead only) and held for the page's life per member. The lead itself, a solo install
// and a pane with no host named all answer `undefined`: they run this build's own bridge, which is never
// older than the page it serves. `undefined` also covers "not read yet" and "the census did not answer", and
// the caller reads it as "offer pins, let the machine answer" (a plain 404 then says "that machine is older").

const MEMBER_VERSIONS = new Map<string, string>();
let inflight: Promise<void> | null = null;
// The roster the versions were last read for. A member that updates restarts, and the roster shows it (reachable,
// protocol), so a changed roster reads the census again and a member updated to 1.28 stops being hidden.
let readFor: string | null = null;

async function fetchCensus(): Promise<void> {
  try {
    const census = await fetchCrew();
    for (const member of census.members) {
      if (member.version !== undefined) MEMBER_VERSIONS.set(member.id, member.version);
    }
  } catch {
    // A solo install, a peer and a dropped link all answer no census: the version stays unknown.
  } finally {
    inflight = null;
  }
}

function readCensus(roster: string): Promise<void> {
  readFor = roster;
  inflight ??= fetchCensus();
  return inflight;
}

/** Forget what was read, for a test. */
export function forgetHostVersions(): void {
  MEMBER_VERSIONS.clear();
  inflight = null;
  readFor = null;
}

/** The version a member's Collie reports, or `undefined` for the lead, a solo install or an unknown. */
export function useHostVersion(host: string | undefined): string | undefined {
  const { multi, lead, servers } = useCrew();
  // Who is on the crew and whether each answers: the facts a member's update moves. Not `lastSeenAt`, which moves each poll.
  const roster = servers.map((server) => `${server.id}:${server.reachable ? 1 : 0}:${server.protocol}`).join(",");
  const member = multi && host !== undefined && host !== lead ? host : undefined;
  const [, bump] = useState(0);
  useEffect(() => {
    if (member === undefined || (MEMBER_VERSIONS.has(member) && readFor === roster)) return;
    let live = true;
    void readCensus(roster).then(() => live && bump((n) => n + 1));
    return () => {
      live = false;
    };
  }, [member, roster]);
  return member === undefined ? undefined : MEMBER_VERSIONS.get(member);
}
