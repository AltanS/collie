import type { PushMessage } from "./push.ts";
import type { AgentStatus, AgentView } from "./types.ts";

// A notification shouldn't be fire-and-forget. This coordinator gives every blocked/done alert a
// lifecycle and collapses the herd into a single, always-accurate notification:
//
//   • Debounce + cancel — an agent that blocks and unblocks within the window (you handled it at your
//     desk) never reaches your phone. Herdr exposes no "user present" signal (only a `focused` pane,
//     no activity timestamp), so we infer presence: a quickly-resolved transition is an at-desk one.
//   • Coalesce — instead of N stacked notifications, we keep ONE summary of everything currently
//     outstanding: the named agent when exactly one needs you, or "N agents need you" for several.
//     Each change re-renders that single summary; when the last one resolves, we clear it.
//   • Retract — clearing an agent at the PC (or its pane closing) updates or removes the summary, so
//     handled work never lingers on your lock screen.
//
// Pure and clock-injected so `bun test` drives it without real timers: the bridge passes
// setTimeout/clearTimeout (see server.ts); tests pass a fake clock they fire on demand.

const NOTIFIABLE: ReadonlySet<AgentStatus> = new Set<AgentStatus>(["blocked", "done"]);
type NotifiableStatus = "blocked" | "done";

/** The timer primitive the coordinator schedules against — real setTimeout in the bridge, fake in tests. */
export interface NotifyClock<H> {
  schedule(fn: () => void, delayMs: number): H;
  cancel(handle: H): void;
}

/** The current state of the herd's single notification, derived from everything outstanding. */
export interface HerdSummary {
  /** Headline: "claude needs you" for one, or "3 agents need you" for several. */
  title: string;
  /** Sub-line: "demo · /path" for one outstanding alert, or the agent names for a digest. */
  body: string;
  /** Deep-link target when exactly one alert is outstanding; undefined for a multi-agent digest. */
  paneId?: string;
  /** Re-alert (buzz) the device — true when a new alert arrived, false on a silent retraction update. */
  renotify: boolean;
  /** One-tap reply candidates when exactly one agent is outstanding; undefined for a digest. */
  quickReplies?: string[];
}

// Kind-specific one-tap replies for a blocked/done agent, keyed by Herdr's detected agent name.
// The two universally useful nudges for a coding CLI waiting on you are "yes" (approve the pending
// prompt) and "continue" (keep going), so that's the default. Codex's blocked state is almost always
// an approval gate, where declining ("no") is the more useful second action than "continue". Kept as
// a small table + default on purpose — it's the extension point, not a per-agent taxonomy.
const DEFAULT_QUICK_REPLIES: readonly string[] = ["yes", "continue"];
const QUICK_REPLIES_BY_KIND: Record<string, readonly string[]> = {
  claude: DEFAULT_QUICK_REPLIES,
  codex: ["yes", "no"],
  opencode: DEFAULT_QUICK_REPLIES,
  pi: DEFAULT_QUICK_REPLIES,
};

/**
 * Pick the one-tap reply pair for a Herdr-detected agent name (`pane.agent`, e.g. "claude" /
 * "codex" / "claude-code"). Pure + exported for table tests. Always returns a non-empty pair — the
 * kind-specific one when we recognise the agent, else the ["yes","continue"] default. Normalisation
 * mirrors `commandsFor()` in web/src/lib/agent-commands.ts so variants map to the same kind.
 */
export function deriveQuickReplies(agent: string | null | undefined): string[] {
  const key = (agent ?? "").toLowerCase().trim();
  const exact = QUICK_REPLIES_BY_KIND[key];
  if (exact) return [...exact];
  if (key.startsWith("claude")) return [...QUICK_REPLIES_BY_KIND.claude!];
  if (key.startsWith("codex")) return [...QUICK_REPLIES_BY_KIND.codex!];
  if (key.startsWith("opencode")) return [...QUICK_REPLIES_BY_KIND.opencode!];
  if (key === "pi" || key.startsWith("pi-") || key.startsWith("pi.")) return [...QUICK_REPLIES_BY_KIND.pi!];
  return [...DEFAULT_QUICK_REPLIES];
}

export interface NotifySink {
  /** Render (or replace) the herd's single notification. */
  render(summary: HerdSummary): void;
  /** Close the herd notification — nothing is outstanding any more. */
  clear(): void;
}

/** Just the transport the sink needs — "deliver this message to the devices". */
export interface PushSender {
  send(msg: PushMessage): unknown;
}
/** Just the quiet-hours check the sink needs — "are we muted right now?". */
export interface MuteGate {
  isMuted(): boolean;
}

/**
 * Build the {@link NotifySink} the coordinator drives. The whole herd shares one notification slot
 * (`herdTag`), so a render replaces rather than stacks; an active snooze mutes both render and clear
 * (nothing is shown, so there's nothing to close). Kept here, decoupled from `Push`/`Snooze`, so the
 * gating + summary→message mapping is unit-testable without `Bun.serve`.
 */
export function makeNotifySink(push: PushSender, mute: MuteGate, herdTag: string): NotifySink {
  return {
    render: (s) => {
      if (mute.isMuted()) return;
      const msg: PushMessage = { title: s.title, body: s.body, tag: herdTag, paneId: s.paneId, renotify: s.renotify };
      if (s.quickReplies) msg.quickReplies = s.quickReplies;
      void push.send(msg);
    },
    clear: () => {
      if (mute.isMuted()) return;
      void push.send({ type: "clear", tag: herdTag });
    },
  };
}

interface Alert {
  agent: string;
  workspaceLabel: string;
  cwd: string;
  status: NotifiableStatus;
}

export class NotificationCoordinator<H = unknown> {
  /** paneId → timer for an alert that's debouncing but hasn't entered the summary yet. */
  private readonly pending = new Map<string, H>();
  /** paneId → alert that has fired and is reflected in the current summary (insertion-ordered). */
  private readonly outstanding = new Map<string, Alert>();

  constructor(
    private readonly clock: NotifyClock<H>,
    private readonly sink: NotifySink,
    private readonly delayMs: number,
  ) {}

  /** Wire to `StateEngine.onTransition`. */
  onTransition(agent: AgentView, _from: AgentStatus, to: AgentStatus): void {
    const id = agent.paneId;
    if (!NOTIFIABLE.has(to)) {
      // Resolved to a non-notifiable state: drop a still-pending alert, retract a delivered one.
      this.resolve(id);
      return;
    }
    // (Re)arm the debounce. A blocked→done flip lands here too, so only the latest verb survives.
    this.cancelPending(id);
    const alert: Alert = {
      agent: agent.agent,
      workspaceLabel: agent.workspaceLabel,
      cwd: agent.cwd,
      status: to as NotifiableStatus,
    };
    const handle = this.clock.schedule(() => {
      this.pending.delete(id);
      this.outstanding.set(id, alert);
      this.emit(true);
    }, this.delayMs);
    this.pending.set(id, handle);
  }

  /** Wire to `StateEngine.onRemove` — a vanished pane is implicitly resolved. */
  onRemove(paneId: string): void {
    this.resolve(paneId);
  }

  private resolve(id: string): void {
    this.cancelPending(id);
    if (this.outstanding.delete(id)) this.emit(false);
  }

  /** Re-render the single herd summary from whatever's outstanding (or clear it when empty). */
  private emit(renotify: boolean): void {
    if (this.outstanding.size === 0) {
      this.sink.clear();
      return;
    }
    this.sink.render(this.summarize(renotify));
  }

  private summarize(renotify: boolean): HerdSummary {
    const entries = [...this.outstanding.entries()];
    if (entries.length === 1) {
      const [paneId, a] = entries[0]!;
      const verb = a.status === "blocked" ? "needs you" : "is done";
      // One outstanding agent → one pane to reply to, so offer kind-specific one-tap replies.
      return {
        title: `${a.agent} ${verb}`,
        body: `${a.workspaceLabel} · ${a.cwd}`,
        paneId,
        renotify,
        quickReplies: deriveQuickReplies(a.agent),
      };
    }
    const alerts = entries.map(([, a]) => a);
    const n = alerts.length;
    const allBlocked = alerts.every((a) => a.status === "blocked");
    const allDone = alerts.every((a) => a.status === "done");
    const title = allBlocked
      ? `${n} agents need you`
      : allDone
        ? `${n} agents done`
        : `${n} agents need attention`;
    return { title, body: alerts.map((a) => a.agent).join(", "), renotify };
  }

  private cancelPending(id: string): void {
    if (!this.pending.has(id)) return;
    this.clock.cancel(this.pending.get(id)!);
    this.pending.delete(id);
  }
}
