import { AGENT_GROUPS } from "./agent-groups";
import type { AgentStatus } from "./types";

const ALL_STATUSES: AgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];

const groupFor = (s: AgentStatus) => AGENT_GROUPS.filter((g) => g.match(s));

describe("AGENT_GROUPS", () => {
  it("has the three triage groups in needs → working → other order", () => {
    expect(AGENT_GROUPS.map((g) => g.key)).toEqual(["needs", "working", "other"]);
  });

  it("only the 'needs you' group is accented", () => {
    expect(AGENT_GROUPS.find((g) => g.key === "needs")!.accent).toBe(true);
    expect(AGENT_GROUPS.find((g) => g.key === "working")!.accent).toBeFalsy();
    expect(AGENT_GROUPS.find((g) => g.key === "other")!.accent).toBeFalsy();
  });

  it("assigns every status to exactly one group", () => {
    for (const s of ALL_STATUSES) {
      expect(groupFor(s)).toHaveLength(1);
    }
  });

  it("routes 'blocked' to 'needs you'", () => {
    expect(groupFor("blocked")[0]!.key).toBe("needs");
  });

  it("routes 'working' to 'working'", () => {
    expect(groupFor("working")[0]!.key).toBe("working");
  });

  it("routes idle / done / unknown to 'other'", () => {
    expect(groupFor("idle")[0]!.key).toBe("other");
    expect(groupFor("done")[0]!.key).toBe("other");
    expect(groupFor("unknown")[0]!.key).toBe("other");
  });
});
