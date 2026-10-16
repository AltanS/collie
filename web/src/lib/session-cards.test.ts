import {
  __resetSessionCards,
  getSessionCard,
  noteSessionCards,
  programCounts,
  programScope,
  programSessions,
  programsAbove,
  subscribeSessionCards,
  waitingPrograms,
} from "@/lib/session-cards";
import type { ServerSummary, SessionSummary } from "@/lib/types";

// The Durable agents section's rules (M55 spec 13), as pure functions over the snapshot's session summaries.

function session(name: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return { name, isPrimary: false, reachable: true, agents: 0, working: 0, blocked: 0, ...over };
}
const program = (name: string, over: Partial<SessionSummary> = {}) => session(name, { kind: "program", state: "ready", ...over });

const CREW: ServerSummary[] = [
  { id: "bluefin", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 0 },
  { id: "minibuch", name: "minibuch", isLead: false, reachable: true, protocol: "ok", lastSeenAt: 0 },
];

describe("programCounts", () => {
  it("reads open off agents and waiting off blocked while the program is ready", () => {
    expect(programCounts(program("desk", { agents: 3, blocked: 2 }))).toEqual({ open: 3, waiting: 2 });
  });

  it("counts nothing for a starting or an unreachable program", () => {
    expect(programCounts(program("desk", { state: "starting", agents: 3, blocked: 2 }))).toEqual({ open: 0, waiting: 0 });
    expect(programCounts(program("desk", { state: "unreachable", agents: 3, blocked: 2 }))).toEqual({ open: 0, waiting: 0 });
  });
});

describe("programSessions", () => {
  it("keeps every program session on every machine, in order, and no terminal session", () => {
    const list = [
      session("default", { kind: "terminal", host: "bluefin" }),
      program("desk", { host: "bluefin" }),
      session("work", { host: "minibuch" }),
      program("support", { host: "minibuch" }),
    ];
    expect(programSessions(list).map((s) => s.name)).toEqual(["desk", "support"]);
  });

  it("is empty on a snapshot with no card at all", () => {
    expect(programSessions([session("default", { isPrimary: true })])).toEqual([]);
  });
});

describe("programsAbove", () => {
  it("is true when any program has a conversation that waits", () => {
    expect(programsAbove([program("desk", { agents: 2 }), program("support", { agents: 1, blocked: 1 })])).toBe(true);
  });

  it("is false when nothing waits, when a waiting count belongs to a program that is not ready, and with no program", () => {
    expect(programsAbove([program("desk", { agents: 2 })])).toBe(false);
    expect(programsAbove([program("desk", { state: "unreachable", blocked: 1 })])).toBe(false);
    expect(programsAbove([])).toBe(false);
  });
});

describe("programScope", () => {
  it("opens a solo program by name with no host", () => {
    expect(programScope(program("desk"), undefined)).toEqual({ host: undefined, session: "desk" });
  });

  it("opens the lead's own program with no host, and a member's on the member", () => {
    expect(programScope(program("desk", { host: "bluefin" }), CREW)).toEqual({ host: undefined, session: "desk" });
    expect(programScope(program("support", { host: "minibuch" }), CREW)).toEqual({ host: "minibuch", session: "support" });
  });
});

describe("waitingPrograms", () => {
  it("keeps only the ready programs with a conversation that waits, in order", () => {
    const list = [
      program("desk", { agents: 3, blocked: 2 }),
      program("quiet", { agents: 1 }),
      program("down", { state: "unreachable", blocked: 1 }),
      program("support", { agents: 1, blocked: 1 }),
    ];
    expect(waitingPrograms(list).map((s) => s.name)).toEqual(["desk", "support"]);
    expect(waitingPrograms([program("quiet")])).toEqual([]);
  });
});

describe("a card's signature", () => {
  afterEach(() => __resetSessionCards());

  it("changes with notice, so a program refused for its wire version re-renders, and the same card keeps its object", () => {
    const heard = vi.fn();
    const off = subscribeSessionCards(heard);
    noteSessionCards([program("desk", { state: "unreachable", reachable: false })], undefined);
    const plain = getSessionCard({ session: "desk" });
    heard.mockClear();
    // Only the counts moved: the same object, nobody told.
    noteSessionCards([program("desk", { state: "unreachable", reachable: false, agents: 1 })], undefined);
    expect(getSessionCard({ session: "desk" })).toBe(plain);
    expect(heard).not.toHaveBeenCalled();
    const sentence = "The durable agent speaks wire v2, this Collie speaks v1. Update Collie, or the agent's SDK.";
    noteSessionCards([program("desk", { state: "unreachable", reachable: false, notice: sentence })], undefined);
    expect(getSessionCard({ session: "desk" })).not.toBe(plain);
    expect(getSessionCard({ session: "desk" })?.notice).toBe(sentence);
    expect(heard).toHaveBeenCalledTimes(1);
    off();
  });
});
