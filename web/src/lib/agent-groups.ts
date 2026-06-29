// The triage grouping used by both the home list and the thread sidebar. Kept in one place so the
// two views can't drift apart. "Needs you" first (accented), then active work, then everything else.
import type { AgentStatus } from "./types";

export interface AgentGroup {
  key: string;
  label: string;
  match: (s: AgentStatus) => boolean;
  accent?: boolean;
}

export const AGENT_GROUPS: AgentGroup[] = [
  { key: "needs", label: "Needs you", match: (s) => s === "blocked", accent: true },
  { key: "working", label: "Working", match: (s) => s === "working" },
  { key: "other", label: "Idle · done", match: (s) => s !== "blocked" && s !== "working" },
];
