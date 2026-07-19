// The triage grouping used by both the home list and the thread sidebar. Kept in one place so the
// two views can't drift apart. "Needs you" first (accented), then active work, then everything else.
import type { AgentStatus } from "./types";

export interface AgentGroup {
  key: string;
  label: string;
  match: (s: AgentStatus) => boolean;
  accent?: boolean;
  /** Section bullet class — the same status palette the badges use, so a group's color can't drift
   *  from the status it collects. */
  dot: string;
}

export const AGENT_GROUPS: readonly AgentGroup[] = [
  { key: "needs", label: "Needs you", match: (s) => s === "blocked", accent: true, dot: "bg-status-blocked" },
  { key: "working", label: "Working", match: (s) => s === "working", dot: "bg-status-working" },
  { key: "other", label: "Idle · done", match: (s) => s !== "blocked" && s !== "working", dot: "bg-status-idle" },
];
