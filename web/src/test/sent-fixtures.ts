import type { SentAnswer, SentEntry, SentMachine } from "@/lib/types";

// Fixtures of the Sent wire contract (M61, tracker spec 00): one answer per state the sheet draws.
// Times are relative to the load, so "2m ago" reads as written. Hand-written against the contract and not captured from a bridge, because the route and its
// bridge were built beside this file. A test mocks the fetch with one of them.

const NOW = Date.now();
const MIN = 60_000;

export const SENT_NOW = NOW;

export function entry(over: Partial<SentEntry> & Pick<SentEntry, "line">): SentEntry {
  return {
    id: over.id ?? over.line.replace(/\W+/g, "").slice(0, 16).padEnd(16, "0"),
    cwd: "/home/altan/projects/collie",
    at: NOW - 5 * MIN,
    kind: "shell",
    count: 1,
    host: "bluefin",
    ...over,
  };
}

export const SOLO_MACHINES: SentMachine[] = [{ host: "bluefin", label: "bluefin", ok: true }];

export const CREW_MACHINES: SentMachine[] = [
  { host: "bluefin", label: "bluefin", ok: true },
  { host: "workshop", label: "workshop", ok: true },
];

/** A page of a solo bridge: three lines, one repeated. */
export const sentSolo: SentAnswer = {
  entries: [
    entry({ line: "git status", at: NOW - 2 * MIN, count: 7 }),
    entry({ line: "bun test web/src/lib/sent-rows.test.ts", at: NOW - 30 * MIN, cwd: null }),
    entry({ line: "make deploy instance=next", at: NOW - 3 * 60 * MIN, kind: "run" }),
  ],
  more: false,
  off: false,
  machines: SOLO_MACHINES,
};

/** The lead's merge across two machines. */
export const sentCrew: SentAnswer = {
  entries: [
    entry({ line: "git status", at: NOW - 2 * MIN, count: 3 }),
    entry({ line: "journalctl -u collie -n 50", at: NOW - 9 * MIN, host: "workshop", cwd: "/srv" }),
  ],
  more: false,
  off: false,
  machines: CREW_MACHINES,
};

export const sentEmpty: SentAnswer = { entries: [], more: false, off: false, machines: SOLO_MACHINES };

export const sentOff: SentAnswer = { entries: [], more: false, off: true, machines: [{ ...SOLO_MACHINES[0]!, off: true }] };

/** The lead answered; one member did not, one is on an older Collie, one was too slow. */
export const sentSomeSilent: SentAnswer = {
  ...sentCrew,
  machines: [
    ...CREW_MACHINES,
    { host: "attic", label: "attic", ok: false, reason: "unreachable" },
    { host: "barn", label: "barn", ok: false, reason: "old_version" },
    { host: "cellar", label: "cellar", ok: false, reason: "timeout" },
  ],
};

export const sentMore: SentAnswer = { ...sentSolo, more: true };
