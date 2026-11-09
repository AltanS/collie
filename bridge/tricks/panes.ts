import type { AgentStatus, PaneAction, PaneBadge, PaneProgress, PaneWire, TabView, WorkspaceView } from "../types.ts";
import {
  ACTIONS_MAX,
  BADGE_TEXT_MAX,
  COUNT_MAX,
  SUBTITLE_MAX,
  freshWindowMs,
  trickSessionId,
  trickSpaceId,
  parseDuration,
  partKey,
  type Badge,
  type TrickAction,
  type PartProgress,
  type SessionPart,
  type Tone,
  type WireTrickInfo,
  type WireTrickPart,
} from "../../web/src/lib/tricks/schema.ts";

/** Whether a pane is a trick's own session (`kind: "trick"`), never a real agent or shell. */
export function isTrickPane(pane: { readonly kind?: string }): boolean {
  return pane.kind === "trick";
}

/**
 * The real agent and shell panes of a list: every pane but a trick session. THE ONE FILTER (M94 review
 * row 30): a trick session rides inside a snapshot's `agents` as a pane of `kind: "trick"`, so every
 * consumer that must never meet one (push, a crew member's notifier, the hill's session names) reads
 * its panes through this, never through a `kind` test of its own. A list with no trick pane comes back
 * as the same array. The phone's twin is web/src/lib/tricks/places.ts `realAgentPanes`.
 */
export function realAgentPanes<T extends { readonly kind?: string }>(panes: readonly T[]): readonly T[] {
  return panes.some(isTrickPane) ? panes.filter((pane) => !isTrickPane(pane)) : panes;
}

// THE TRICK SESSIONS AS PANES (M94 slice 03): an in-process pane source with no terminal behind it.
//
// Each `session` part of a trick that is on becomes one pane on the snapshot, of `kind: "trick"`, in ONE
// synthetic Space per host, the Tricks Space, numbered after the real Spaces and labelled "Tricks". Each
// trick is one tab of it, in manifest order; its session parts are that tab's panes, in document order.
// The ids are reserved (schema.ts `TRICK_SESSION_PREFIX`), so a trick session never collides with a pane a
// multiplexer or a program reports:
//
//   Space   trick:<host>                    tab   trick:<host>:<trick>          pane   trick:<host>:<trick>:<part>
//
// The pane carries what the Dashboard row and the Header draw with no new code: the name, `subtitle`,
// `badge`, `progress` (WIRE.md's caps again, though the parser already held the part to them) and up to
// four `actions`. Its body is NOT a conversation: `view` names the part, and the phone reads the view
// tree from `GET /api/tricks`, never from the snapshot.
//
// OUTSIDE TRIAGE AND PUSH. A trick session is never "needs you" (ADR 0063 point 3): its status is
// `working` for a fresh part whose tone is `working`, and `idle` for every other tone, a stale part, a
// failing trick and a stopped one. It never reads `blocked` or `done`. These panes never pass through a
// state engine, so they have no transition to push, and they are added after the session counts are
// taken, so `sessions[].agents/working/blocked` never count them.

/** The Space's label. A word of Collie's, not the trick's, so it stays the same whatever the tricks say. */
export const TRICKS_SPACE_LABEL = "Tricks";

/** One trick session part with its trick, as the store holds them. */
export interface TrickSessionSource {
  host: string;
  /** Every trick in manifest order, as `GET /api/tricks` lists them. */
  tricks: readonly WireTrickInfo[];
  /** Every stored part. Only `session` parts of tricks that are on become panes. */
  parts: readonly WireTrickPart[];
  /** A trick's folder, the pane's `cwd`. */
  dirOf: (trick: string) => string | undefined;
  /** Now, epoch ms, to judge a part past its fresh window. */
  now: number;
}

/** The Tricks Space with its tabs and panes. The numbers are the caller's, after the real Spaces. */
export interface TrickSessionPanes {
  workspace: Omit<WorkspaceView, "number">;
  tabs: Omit<TabView, "number">[];
  panes: Omit<PaneWire, "workspaceNumber">[];
}

/** Whether a part is past its fresh window at `now`, by the same rule the phone's frame reads. */
export function pastWindow(part: Pick<WireTrickPart, "asOf" | "fresh">, now: number): boolean {
  if (part.asOf === undefined) return false;
  const asOf = Date.parse(part.asOf);
  if (!Number.isFinite(asOf)) return false;
  const fresh = part.fresh === undefined ? undefined : parseDuration(part.fresh);
  return now - asOf > freshWindowMs(fresh, undefined);
}

/**
 * A trick session's status. Only a fresh part of a trick that runs, with the tone `accent` (the tree's
 * word for the first schema's `working`), reads as working. `danger` and `warn` read idle and keep their
 * tone in the view: a trick's red is never Collie's "needs you".
 */
export function trickSessionStatus(tone: Tone | undefined, live: boolean): AgentStatus {
  return live && tone === "accent" ? "working" : "idle";
}

/** A string cut to `max` code points. */
function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

function badgeOf(badge: Badge): PaneBadge | undefined {
  if ("count" in badge) return Number.isInteger(badge.count) && badge.count >= 0 && badge.count <= COUNT_MAX ? { count: badge.count } : undefined;
  const text = cut(badge.text, BADGE_TEXT_MAX);
  return text === "" ? undefined : { text };
}

/**
 * A part's progress (the meter shape, `max` 1 by default) as the pane's percent. No value is an
 * indeterminate meter, which a pane cannot show yet, so it carries none. STEP 3: the pane may draw a
 * small whole `max` as steps.
 */
function progressOf(progress: PartProgress): PaneProgress | undefined {
  const max = progress.max ?? 1;
  if (progress.value === undefined || !Number.isFinite(progress.value) || !(max > 0)) return undefined;
  const value = Math.min(100, Math.max(0, (progress.value * 100) / max));
  return { kind: "percent", value };
}

function actionOf(action: TrickAction): PaneAction {
  const out: PaneAction = { id: action.id, label: action.label };
  if (action.icon !== undefined) out.icon = action.icon;
  if (action.disabled === true) out.disabled = true;
  return out;
}

function isSessionPart(part: WireTrickPart): part is WireTrickPart & { value: SessionPart } {
  return part.value.at === "session";
}

/**
 * The Tricks Space of one host, or undefined when no trick that is on has a session part. Pure: the
 * service passes what its store holds, and a test passes literals.
 */
export function trickSessionPanes(src: TrickSessionSource): TrickSessionPanes | undefined {
  const space = trickSpaceId(src.host);
  const tabs: Omit<TabView, "number">[] = [];
  const panes: Omit<PaneWire, "workspaceNumber">[] = [];
  for (const trick of src.tricks) {
    if (trick.host !== src.host || !trick.on) continue;
    const mine = src.parts.filter((p) => p.host === src.host && p.trick === trick.id && isSessionPart(p));
    if (mine.length === 0) continue;
    const tabId = trickSessionId(src.host, trick.id);
    const runs = trick.state === "ok";
    mine.forEach((stored, position) => {
      if (!isSessionPart(stored)) return;
      const part = stored.value;
      const name = part.name ?? trick.name;
      const live = runs && stored.stale !== true && !pastWindow(stored, src.now);
      const pane: Omit<PaneWire, "workspaceNumber"> = {
        paneId: trickSessionId(src.host, trick.id, part.id),
        workspaceId: space,
        workspaceLabel: TRICKS_SPACE_LABEL,
        tabId,
        agent: trick.id,
        status: trickSessionStatus(part.tone, live),
        cwd: src.dirOf(trick.id) ?? "",
        focused: false,
        kind: "trick",
        paneLabel: name,
        sessionName: name,
        tabLabel: trick.name,
        tabPosition: position,
        view: partKey(stored),
      };
      if (part.subtitle !== undefined && part.subtitle !== "") pane.subtitle = cut(part.subtitle, SUBTITLE_MAX);
      const badge = part.badge === undefined ? undefined : badgeOf(part.badge);
      if (badge !== undefined) pane.badge = badge;
      const progress = part.progress === undefined ? undefined : progressOf(part.progress);
      if (progress !== undefined) pane.progress = progress;
      const actions = (part.actions ?? []).slice(0, ACTIONS_MAX).map(actionOf);
      if (actions.length > 0) pane.actions = actions;
      panes.push(pane);
    });
    tabs.push({ tabId, workspaceId: space, label: trick.name, focused: false, paneCount: mine.length });
  }
  const first = tabs[0];
  if (first === undefined) return undefined;
  return {
    workspace: { workspaceId: space, label: TRICKS_SPACE_LABEL, focused: false, activeTabId: first.tabId, tabCount: tabs.length, paneCount: panes.length },
    tabs,
    panes,
  };
}

/** Where the Tricks Space lands in one snapshot body: its number after the real Spaces, and the session tag. */
export interface TrickSessionPlacement {
  /** The real Spaces' numbers, so the Tricks Space takes the next one. */
  numbers: readonly number[];
  /** A widened body tags every pane with a session; the trick panes take this one (the primary's). */
  session?: string;
}

/** The Tricks Space numbered for one body, ready to append to its `workspaces`, `tabs` and `agents`. */
export interface PlacedTrickSessions {
  workspace: WorkspaceView;
  tabs: TabView[];
  panes: PaneWire[];
}

/** The Tricks Space, numbered and ready to append to a snapshot's `workspaces`, `tabs` and `agents`. */
export function placeTrickSessions(found: TrickSessionPanes, at: TrickSessionPlacement): PlacedTrickSessions {
  const number = at.numbers.reduce((max, n) => (Number.isFinite(n) && n > max ? n : max), 0) + 1;
  const panes: PaneWire[] = found.panes.map((pane) => {
    const placed: PaneWire = { ...pane, workspaceNumber: number };
    if (at.session !== undefined) placed.session = at.session;
    return placed;
  });
  return {
    workspace: { ...found.workspace, number },
    tabs: found.tabs.map((tab, i) => ({ ...tab, number: i + 1 })),
    panes,
  };
}
