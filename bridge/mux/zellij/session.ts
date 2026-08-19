// WHICH ZELLIJ SESSION THIS COLLIE DRIVES — resolved once, re-resolved when it stops answering, and
// prepended to every call the adapter and the watch make.
//
// It is a module of its own because two things need it and neither may own it: `adapter.ts` (every
// verb) and `watch.ts` (the census and the pane stream). Putting it in either would make the other
// import across the wrong seam.
//
// ── AN ADAPTER INSTANCE IS BOUND TO EXACTLY ONE SESSION ──────────────────────────────────────────
//
// That is the single decision every other one here follows from. `zellij action` targets one session
// (`--session`), `list-panes` lists that session's panes and nothing else, and there is no verb that
// enumerates panes across sessions. So the configured session IS the collie's world — which is why
// the adapter reports one space, and why `createSpace` is declared absent: a session Collie created
// would be invisible to the very adapter that made it.
//
// ── WHAT AN EXITED SESSION LOOKS LIKE, AND WHAT COLLIE SAYS ABOUT IT ─────────────────────────────
//
// zellij keeps a stopped session listed as `(EXITED - attach to resurrect)`, a state neither Herdr
// nor tmux has. Probed: `action` against one answers `Session 'x' not found. The following sessions
// are active: …` and exits 1 — the CLI treats it exactly as absent. Collie says the same thing:
// **an exited session is UNREACHABLE, not an empty herd.** `reachable()` is false, the snapshot
// throws, and the operator sees the disconnected banner with a detail naming the session and telling
// them an `attach` brings it back. Resurrecting it is an operator act with side effects (it re-runs
// the session's commands), so Collie never does it — the same reason nothing here ever creates one.

import type { ZellijExec, ZellijRunResult, ZellijStreamClient, ZellijStreamHandlers } from "./exec.ts";
import {
  chooseSession,
  parseSessionList,
  saysNoSession,
  sessionArgs,
  ZELLIJ_LIST_SESSIONS_ARGS,
} from "./protocol.ts";

/** What one call through the binding did: zellij's own answer, or why there was nobody to ask. */
export type ZellijCall =
  | { readonly ok: true; readonly result: ZellijRunResult }
  | { readonly ok: false; readonly detail: string };

/** The session this collie drives, or why there is none to drive. */
export type ZellijBoundSession =
  | { readonly ok: true; readonly session: string }
  | { readonly ok: false; readonly detail: string };

/** A composed argv for a long-lived call, or why there is no session to make it against. */
export type ZellijBoundArgs =
  | { readonly ok: true; readonly args: readonly string[] }
  | { readonly ok: false; readonly detail: string };

/**
 * The session binding: the configured name (or the discovery rule), cached, and the argv prefix.
 *
 * The cache is deliberately not time-based. A session name that resolved once stays resolved until a
 * call comes back saying the session is not there, at which point it is dropped and the next call
 * re-discovers — which is what makes a collie on the discovery rule follow the operator restarting
 * their one session, without paying a `list-sessions` on every read.
 */
export class ZellijSessionBinding {
  private resolved: string | null = null;

  constructor(
    private readonly exec: ZellijExec,
    private readonly configured: string,
  ) {}

  /** The session this collie drives, or why there is none. Cached once it has answered. */
  async name(): Promise<ZellijBoundSession> {
    if (this.resolved !== null) return { ok: true, session: this.resolved };
    let listing: ZellijRunResult;
    try {
      listing = await this.exec.run([...ZELLIJ_LIST_SESSIONS_ARGS]);
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    // A box with no sessions at all exits non-zero and says so on stderr; the chooser turns both the
    // empty listing and the ambiguous one into a sentence the operator can act on.
    const sessions = parseSessionList(listing.code === 0 ? listing.stdout : "");
    const choice = chooseSession(sessions, this.configured);
    if (!choice.ok) return { ok: false, detail: choice.detail };
    this.resolved = choice.session;
    return { ok: true, session: choice.session };
  }

  /**
   * The session's name for display, before it has been resolved or after it stopped answering.
   *
   * The configured name when there is one, so a collie pointed at "work" says "work" in the space
   * header even while the session is down. Falls back to the multiplexer's own name rather than an
   * empty label, because a space with no name at all renders as a gap.
   */
  label(): string {
    return this.resolved ?? (this.configured.trim() || "zellij");
  }

  /** Forget the resolved name, so the next call discovers again. */
  invalidate(): void {
    this.resolved = null;
  }

  /** Run one `zellij --session <name> …` call. */
  async run(args: readonly string[]): Promise<ZellijCall> {
    const session = await this.name();
    if (!session.ok) return { ok: false, detail: session.detail };
    let result: ZellijRunResult;
    try {
      result = await this.exec.run([...sessionArgs(session.session), ...args]);
    } catch (err) {
      this.invalidate();
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    // The one failure a zellij exit code genuinely proves (protocol.ts header). Everything else it
    // reports 0 for, so a non-zero exit that is NOT this is the binary refusing the arguments.
    if (result.code !== 0 && saysNoSession(result.stderr || result.stdout)) {
      this.invalidate();
      return { ok: false, detail: (result.stderr || result.stdout).trim() };
    }
    return { ok: true, result };
  }

  /** The full argv for a long-lived call, or why there is no session to make it against. */
  async argsFor(args: readonly string[]): Promise<ZellijBoundArgs> {
    const session = await this.name();
    if (!session.ok) return { ok: false, detail: session.detail };
    return { ok: true, args: [...sessionArgs(session.session), ...args] };
  }

  /**
   * Start the long-lived pane stream on an argv {@link argsFor} already composed.
   *
   * Two steps rather than one because the watch has to re-check its own state between resolving the
   * session (async) and spawning the child (sync) — a subscription closed in that window must not
   * leave a process behind (watch.ts `openStream`).
   */
  spawnStream(args: readonly string[], handlers: ZellijStreamHandlers): ZellijStreamClient {
    return this.exec.stream(args, handlers);
  }
}
