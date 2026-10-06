import { panePlace, soleTabName, type NameableP } from "./pane-name.ts";
import { pushTitle, type PushTitleCode, type PushTitleDetail } from "./push-titles.ts";
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
  /** The catalogue code `title` was rendered from, so the phone can say it in its own language. */
  titleCode: PushTitleCode;
  /** The values `title` was filled with — the agent's name, or the digest's count. */
  titleDetail?: PushTitleDetail;
  /** Sub-line: the pane's PLACE ("collie › UI work") for one outstanding alert, or the panes' names
   *  for a digest — each one `name · place` where two of them read the same. */
  body: string;
  /** Deep-link target when exactly one alert is outstanding; undefined for a multi-agent digest. */
  paneId?: string;
  /** Re-alert (buzz) the device — true when a new alert arrived, false on a silent retraction update. */
  renotify: boolean;
}

export interface NotifySink {
  /** Render (or replace) the herd's single notification. */
  render(summary: HerdSummary): void;
  /** Close the herd notification — nothing is outstanding any more. */
  clear(): void;
}

/** Just the transport the sink needs — "deliver this message to the devices". */
export interface PushSender {
  send(msg: PushMessage): void;
}
/** Just the quiet-hours check the sink needs — "are we muted right now?". */
export interface MuteGate {
  isMuted(): boolean;
}

/**
 * Who the alerts flowing through a sink belong to — the `(host, session)` half of the address triple
 * (CREW_PROTOCOL.md §4). **Both halves are omitted-not-null**, and for the same reason: a stamped
 * field that is absent for the default case keeps that payload byte-identical to the shape an
 * already-installed service worker was built against.
 */
export interface NotifyIdentity {
  /** Herdr session (registry name). Absent for the primary — §11's push-payload row. */
  readonly session?: string;
  /** Crew member owning the session. Absent for this collie, so a solo payload gains nothing (§11). */
  readonly host?: string;
}

/**
 * Build the {@link NotifySink} the coordinator drives. One session's whole herd shares one
 * notification slot (`herdTag`), so a render replaces rather than stacks; an active snooze mutes both
 * render and clear (nothing is shown, so there's nothing to close). {@link NotifyIdentity} is stamped
 * into the push payload so the service worker can deep-link to the right `(host, session)` — omit
 * either half for "here"/"primary", keeping that payload byte-identical to the case that predates the
 * dimension. Kept here, decoupled from `Push`/`Snooze`, so the gating + summary→message mapping is
 * unit-testable.
 *
 * A peer's summary also NAMES its host in the body. Per-host slots mean two machines' alerts never
 * overwrite each other, but they also mean the text is the only thing that says *which machine* —
 * and "claude needs you" is identical on every host in the crew.
 */
export function makeNotifySink(
  push: PushSender,
  mute: MuteGate,
  herdTag: string,
  ident: NotifyIdentity = {},
): NotifySink {
  const { session: sessionName, host } = ident;
  return {
    render: (s) => {
      if (mute.isMuted()) return;
      const body = host === undefined ? s.body : `${host} · ${s.body}`;
      const msg: PushMessage = {
        title: s.title,
        titleCode: s.titleCode,
        body,
        tag: herdTag,
        paneId: s.paneId,
        renotify: s.renotify,
      };
      if (s.titleDetail !== undefined) msg.titleDetail = s.titleDetail;
      if (sessionName !== undefined) msg.session = sessionName;
      if (host !== undefined) msg.host = host;
      void push.send(msg);
    },
    clear: () => {
      if (mute.isMuted()) return;
      void push.send({ type: "clear", tag: herdTag });
    },
  };
}

// ── A PUSH NAMES A PANE BY THE OPERATOR'S LABEL, NEVER BY THE PROGRAM'S TITLE ─────────────────────
// Every other surface leads with `paneName` (pane-name.ts), which falls back to the terminal title.
// A push may not. A program sets that title with an escape sequence, so anything running in the pane
// chooses it, and it can carry a path, a command line or a secret. A push crosses a third-party push
// service and shows on a lock screen, which is the last place for any of those. So the push asks
// {@link pushName}, which is the one name rule with the title taken out, and with no fallback to it,
// not even a stale one. A pane with no label of the operator's gets the neutral harness word, and
// the digest's collision rule adds its place when two read the same. The body is masked on top
// (`push.ts` § redactPushMessage), but the title stays out by rule, not by luck. Written down in
// docs/security.md too.

/**
 * What a push calls a pane: the operator's label (`paneLabel`), Claude's `/rename` name, or the
 * operator's name for a one-pane tab; else `shell` or the harness word. Never `terminalTitle`.
 */
export function pushName(pane: NameableP): string {
  if (pane.paneLabel) return pane.paneLabel;
  if (pane.sessionName) return pane.sessionName;
  const tab = soleTabName(pane);
  if (tab !== null) return tab;
  return pane.kind === "shell" ? "shell" : pane.agent;
}

interface Alert {
  agent: string;
  /** What a push calls this pane — {@link pushName}, the operator's label and never the title. */
  label: string;
  /** Where it sits — `space › tab`, or the space alone. The one place rule, same module. */
  place: string;
  status: NotifiableStatus;
}

/**
 * The digest body's per-alert labels, with a shared name disambiguated by its place. Applied only to
 * a name that collides with another outstanding alert's — a lone name is never touched — and only
 * once: two panes sharing both a name AND a place stay indistinguishable rather than chase a longer
 * key. That residual collision is rare (both panes would need the same name in the same tab) and the
 * digest still names every pane it can.
 */
function digestLabels(alerts: readonly Alert[]): string[] {
  const counts = new Map<string, number>();
  for (const a of alerts) counts.set(a.label, (counts.get(a.label) ?? 0) + 1);
  return alerts.map((a) => ((counts.get(a.label) ?? 0) > 1 ? `${a.label} · ${a.place}` : a.label));
}

export class NotificationCoordinator<H = unknown> {
  /** paneId → debouncing alert (timer + its kind) that hasn't entered the summary yet. */
  private readonly pending = new Map<string, { handle: H; status: NotifiableStatus }>();
  /** paneId → alert that has fired and is reflected in the current summary (insertion-ordered). */
  private readonly outstanding = new Map<string, Alert>();

  constructor(
    private readonly clock: NotifyClock<H>,
    private readonly sink: NotifySink,
    private readonly delayMs: number,
    // Whether a transition into a status should notify, read live from the prefs store so a runtime
    // change is honoured. A disabled kind behaves exactly like a non-notifiable status (idle/working).
    private readonly isNotifiable: (status: AgentStatus) => boolean,
  ) {}

  /** Wire to `StateEngine.onTransition`. */
  onTransition(agent: AgentView, from: AgentStatus, rawTo: AgentStatus): void {
    const id = agent.paneId;
    // Herdr 0.9 can report a finished turn as `idle` instead of `done`, and tmux and zellij never
    // report `done` (issue #345), so a `working → idle` flip IS the completion and is read as `done` from here on: the Finished pref,
    // the debounce, the verb and the payload all behave as for a real `done`. Only that exact pair
    // counts. `blocked → idle` (the operator answered the prompt) and every other way into `idle`
    // stay a resolve. Known limit: an agent the operator interrupts also goes `working → idle` and
    // will push. Not `isNewWork`: that one includes `blocked → idle`.
    const to: AgentStatus = from === "working" && rawTo === "idle" ? "done" : rawTo;
    if (!this.isNotifiable(to)) {
      // Resolved to a non-notifiable (or preference-disabled) state: drop a still-pending alert,
      // retract a delivered one.
      this.resolve(id);
      return;
    }
    // (Re)arm the debounce. A blocked→done flip lands here too, so only the latest verb survives.
    this.cancelPending(id);
    const alert: Alert = {
      agent: agent.agent,
      label: pushName(agent),
      place: panePlace(agent),
      // SAFETY: `onTransition` is only reached for a status the prefs call notifiable, and the
      // notifiable set IS `NotifiableStatus` (blocked/done) — `isNotifiable` returns false for
      // every other member of `AgentStatus`, so this branch cannot be entered with one.
      status: to as NotifiableStatus,
    };
    const handle = this.clock.schedule(() => {
      this.pending.delete(id);
      this.outstanding.set(id, alert);
      this.emit(true);
    }, this.delayMs);
    this.pending.set(id, { handle, status: alert.status });
  }

  /** Wire to `StateEngine.onRemove` — a vanished pane is implicitly resolved. */
  onRemove(paneId: string): void {
    this.resolve(paneId);
  }

  /**
   * Re-evaluate every pending + outstanding alert against the current prefs after they change,
   * dropping any whose kind is now disabled: cancel a still-debouncing timer, retract a delivered
   * alert. Retractions re-emit the shrunk summary (or a clear) once, silently. Call after the prefs
   * store is updated (see the /api/notifications/prefs route).
   */
  applyPrefs(): void {
    // Drop pending timers for a now-disabled kind — nothing was shown yet, so no re-emit is needed.
    for (const [id, p] of this.pending) {
      if (!this.isNotifiable(p.status)) this.cancelPending(id);
    }
    // Retract delivered alerts of a now-disabled kind; re-emit the shrunk summary once if any went.
    let removed = false;
    for (const [id, a] of this.outstanding) {
      if (!this.isNotifiable(a.status)) {
        this.outstanding.delete(id);
        removed = true;
      }
    }
    if (removed) this.emit(false);
  }

  /**
   * Tear down this session's notifications: cancel every pending timer and retract everything
   * outstanding, closing the herd slot. Called when a session is disposed (its socket vanished) so
   * its alerts never linger on the lock screen with no live session behind them.
   */
  clearAll(): void {
    for (const id of this.pending.keys()) this.cancelPending(id);
    const had = this.outstanding.size > 0;
    this.outstanding.clear();
    if (had) this.sink.clear();
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
      // One outstanding agent → deep-link straight to its pane on tap.
      return {
        ...pushTitle(a.status === "blocked" ? "agent.blocked" : "agent.done", { agent: a.agent }),
        // The PLACE, and nothing else. A push says the same two things the screens say — what it is
        // called (the title, above) and where it sits — so the notification and the dashboard row it
        // deep-links to read alike. The cwd is deliberately gone: a full absolute path on a lock
        // screen is the least readable fact Collie has, and the space and tab are what locate the
        // work.
        body: a.place,
        paneId,
        renotify,
      };
    }
    const alerts = entries.map(([, a]) => a);
    const n = alerts.length;
    const allBlocked = alerts.every((a) => a.status === "blocked");
    const allDone = alerts.every((a) => a.status === "done");
    const code = allBlocked ? "herd.blocked" : allDone ? "herd.done" : "herd.mixed";
    return { ...pushTitle(code, { count: n }), body: digestLabels(alerts).join(", "), renotify };
  }

  private cancelPending(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.clock.cancel(p.handle);
    this.pending.delete(id);
  }
}
