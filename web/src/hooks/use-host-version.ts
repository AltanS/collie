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

function readCensus(): Promise<void> {
  inflight ??= fetchCensus();
  return inflight;
}

/** Forget what was read, for a test. */
export function forgetHostVersions(): void {
  MEMBER_VERSIONS.clear();
  inflight = null;
}

/** The version a member's Collie reports, or `undefined` for the lead, a solo install or an unknown. */
export function useHostVersion(host: string | undefined): string | undefined {
  const { multi, lead } = useCrew();
  const member = multi && host !== undefined && host !== lead ? host : undefined;
  const [, bump] = useState(0);
  useEffect(() => {
    if (member === undefined || MEMBER_VERSIONS.has(member)) return;
    let live = true;
    void readCensus().then(() => live && bump((n) => n + 1));
    return () => {
      live = false;
    };
  }, [member]);
  return member === undefined ? undefined : MEMBER_VERSIONS.get(member);
}
