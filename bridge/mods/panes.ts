import type { AgentStatus, PaneAction, PaneBadge, PaneProgress, PaneWire, TabView, WorkspaceView } from "../types.ts";
import {
  ACTIONS_MAX,
  BADGE_TEXT_MAX,
  COUNT_MAX,
  STEPS_MAX,
  SUBTITLE_MAX,
  freshWindowMs,
  modSessionId,
  modSpaceId,
  parseDuration,
  partKey,
  type Badge,
  type ModAction,
  type PartProgress,
  type SessionPart,
  type Tone,
  type WireModInfo,
  type WireModPart,
} from "../../web/src/lib/mods/schema.ts";

// THE MOD SESSIONS AS PANES (M94 slice 03): an in-process pane source with no terminal behind it.
//
// Each `session` part of a mod that is on becomes one pane on the snapshot, of `kind: "mod"`, in ONE
// synthetic Space per host, the Mods Space, numbered after the real Spaces and labelled "Mods". Each
// mod is one tab of it, in manifest order; its session parts are that tab's panes, in document order.
// The ids are reserved (schema.ts `MOD_SESSION_PREFIX`), so a mod session never collides with a pane a
// multiplexer or a program reports:
//
//   Space   mod:<host>                    tab   mod:<host>:<mod>          pane   mod:<host>:<mod>:<part>
//
// The pane carries what the Dashboard row and the Header draw with no new code: the name, `subtitle`,
// `badge`, `progress` (WIRE.md's caps again, though the parser already held the part to them) and up to
// four `actions`. Its body is NOT a conversation: `view` names the part, and the phone reads the view
// tree from `GET /api/mods`, never from the snapshot.
//
// OUTSIDE TRIAGE AND PUSH. A mod session is never "needs you" (ADR 0063 point 3): its status is
// `working` for a fresh part whose tone is `working`, and `idle` for every other tone, a stale part, a
// failing mod and a stopped one. It never reads `blocked` or `done`. These panes never pass through a
// state engine, so they have no transition to push, and they are added after the session counts are
// taken, so `sessions[].agents/working/blocked` never count them.

/** The Space's label. A word of Collie's, not the mod's, so it stays the same whatever the mods say. */
export const MODS_SPACE_LABEL = "Mods";

/** One mod session part with its mod, as the store holds them. */
export interface ModSessionSource {
  host: string;
  /** Every mod in manifest order, as `GET /api/mods` lists them. */
  mods: readonly WireModInfo[];
  /** Every stored part. Only `session` parts of mods that are on become panes. */
  parts: readonly WireModPart[];
  /** A mod's folder, the pane's `cwd`. */
  dirOf: (mod: string) => string | undefined;
  /** Now, epoch ms, to judge a part past its fresh window. */
  now: number;
}

/** The Mods Space with its tabs and panes. The numbers are the caller's, after the real Spaces. */
export interface ModSessionPanes {
  workspace: Omit<WorkspaceView, "number">;
  tabs: Omit<TabView, "number">[];
  panes: Omit<PaneWire, "workspaceNumber">[];
}

/** Whether a part is past its fresh window at `now`, by the same rule the phone's frame reads. */
export function pastWindow(part: Pick<WireModPart, "asOf" | "fresh">, now: number): boolean {
  if (part.asOf === undefined) return false;
  const asOf = Date.parse(part.asOf);
  if (!Number.isFinite(asOf)) return false;
  const fresh = part.fresh === undefined ? undefined : parseDuration(part.fresh);
  return now - asOf > freshWindowMs(fresh, undefined);
}

/**
 * A mod session's status. Only a fresh part of a mod that runs, with the tone `working`, reads as
 * working. `error` and `warn` read idle and keep their tone in the view: a mod's red is never Collie's
 * "needs you".
 */
export function modSessionStatus(tone: Tone | undefined, live: boolean): AgentStatus {
  return live && tone === "working" ? "working" : "idle";
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

function progressOf(progress: PartProgress): PaneProgress | undefined {
  if (progress.kind === "percent") {
    if (!Number.isFinite(progress.value)) return undefined;
    const value = Math.min(100, Math.max(0, progress.value));
    return progress.label === undefined ? { kind: "percent", value } : { kind: "percent", value, label: progress.label };
  }
  const steps = progress.steps.slice(0, STEPS_MAX).map((step) => ({ label: step.label, state: step.state }));
  return steps.length === 0 ? undefined : { kind: "steps", steps };
}

function actionOf(action: ModAction): PaneAction {
  const out: PaneAction = { id: action.id, label: action.label };
  if (action.icon !== undefined) out.icon = action.icon;
  if (action.disabled === true) out.disabled = true;
  return out;
}

function isSessionPart(part: WireModPart): part is WireModPart & { value: SessionPart } {
  return part.value.at === "session";
}

/**
 * The Mods Space of one host, or undefined when no mod that is on has a session part. Pure: the
 * service passes what its store holds, and a test passes literals.
 */
export function modSessionPanes(src: ModSessionSource): ModSessionPanes | undefined {
  const space = modSpaceId(src.host);
  const tabs: Omit<TabView, "number">[] = [];
  const panes: Omit<PaneWire, "workspaceNumber">[] = [];
  for (const mod of src.mods) {
    if (mod.host !== src.host || !mod.on) continue;
    const mine = src.parts.filter((p) => p.host === src.host && p.mod === mod.id && isSessionPart(p));
    if (mine.length === 0) continue;
    const tabId = modSessionId(src.host, mod.id);
    const runs = mod.state === "ok";
    mine.forEach((stored, position) => {
      if (!isSessionPart(stored)) return;
      const part = stored.value;
      const name = part.name ?? mod.name;
      const live = runs && stored.stale !== true && !pastWindow(stored, src.now);
      const pane: Omit<PaneWire, "workspaceNumber"> = {
        paneId: modSessionId(src.host, mod.id, part.id),
        workspaceId: space,
        workspaceLabel: MODS_SPACE_LABEL,
        tabId,
        agent: mod.id,
        status: modSessionStatus(part.tone, live),
        cwd: src.dirOf(mod.id) ?? "",
        focused: false,
        kind: "mod",
        paneLabel: name,
        sessionName: name,
        tabLabel: mod.name,
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
    tabs.push({ tabId, workspaceId: space, label: mod.name, focused: false, paneCount: mine.length });
  }
  const first = tabs[0];
  if (first === undefined) return undefined;
  return {
    workspace: { workspaceId: space, label: MODS_SPACE_LABEL, focused: false, activeTabId: first.tabId, tabCount: tabs.length, paneCount: panes.length },
    tabs,
    panes,
  };
}

/** Where the Mods Space lands in one snapshot body: its number after the real Spaces, and the session tag. */
export interface ModSessionPlacement {
  /** The real Spaces' numbers, so the Mods Space takes the next one. */
  numbers: readonly number[];
  /** A widened body tags every pane with a session; the mod panes take this one (the primary's). */
  session?: string;
}

/** The Mods Space numbered for one body, ready to append to its `workspaces`, `tabs` and `agents`. */
export interface PlacedModSessions {
  workspace: WorkspaceView;
  tabs: TabView[];
  panes: PaneWire[];
}

/** The Mods Space, numbered and ready to append to a snapshot's `workspaces`, `tabs` and `agents`. */
export function placeModSessions(found: ModSessionPanes, at: ModSessionPlacement): PlacedModSessions {
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
