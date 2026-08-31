// Frontend mirror of the bridge's domain model (bridge/types.ts). Kept as a small, deliberate
// duplicate so the web app builds independently of the Bun server's source tree.

import type { ApiErrorCode, ApiErrorDetail } from "@/lib/api-error-codes";
import { t } from "@/lib/i18n";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentView {
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  workspaceNumber: number;
  tabId: string;
  agent: string;
  status: AgentStatus;
  cwd: string;
  focused: boolean;
  /** "agent" for an agent-bearing pane, "shell" for a bare shell. Absent = "agent". */
  kind?: "agent" | "shell";
  /** User-set pane label (herdr `pane.rename`), when one is set; absent when the pane is unlabelled. */
  paneLabel?: string;
  /**
   * Claude's OWN session name (set in-agent via `/rename`), derived bridge-side from the pane text.
   * Claude-only; absent for unnamed sessions and non-claude panes. Shown below an explicit `paneLabel`
   * — see {@link paneDisplayName}. Render as text only (never markup) — same XSS boundary as paneLabel.
   */
  sessionName?: string;
  /**
   * True when the agent named a session, so a journal may exist for this pane — what the History
   * affordance keys off, without a speculative fetch.
   *
   * A FLAG, not the session itself: the bridge keeps the reference server-side and re-derives it from
   * the pane id on every history request, because for some harnesses (pi) that reference is an
   * absolute filesystem path. It never accepts one from the client. "May exist" is the honest
   * reading — an agent can name a session whose log isn't readable, which the history endpoint
   * answers with `available:false, reason:"no-log"`.
   */
  hasSession?: boolean;
  /**
   * Upper bound on the lines a pane read can return (Herdr's scrollback depth + viewport). The only
   * reliable "is there more scrollback" signal — `PaneReadResponse.truncated` is always false even
   * when history was cut off, which is why "Load older" never used to render. A Claude pane reports
   * just its viewport, because the alternate screen it runs on keeps no scrollback. Absent on older
   * bridges/Herdr, which reads as "unknown" (the button then falls back to hidden).
   */
  readableLines?: number;
  /**
   * The pane's tab label, denormalised bridge-side alongside `workspaceLabel`. Absent when it says
   * nothing: Herdr names an unlabelled tab positionally ("1"), which in a single-tab space would
   * render as `project · 1` (see `meaningfulTabLabel` in bridge/activity.ts). Render as text only,
   * never markup — same XSS boundary as `paneLabel`.
   */
  tabLabel?: string;
  /**
   * What the pane's process says it is doing — its OSC title, glyph-stripped and dropped when
   * uninformative bridge-side (see `meaningfulTerminalTitle` in bridge/activity.ts). Unlike
   * `paneLabel` and `sessionName`, which are set once by hand, this follows the work as it moves.
   * Render as text only, never markup — same XSS boundary as `paneLabel`.
   */
  terminalTitle?: string;
  /**
   * True when `terminalTitle` was left behind by a program that has already EXITED — a multiplexer
   * keeps a pane's title after the program that printed it is gone, so a bare shell can sit under a
   * finished agent's sentence for hours. Derived bridge-side; absent on an older bridge, which reads
   * as "not known to be stale" and renders exactly as it always did.
   *
   * It demotes, it never hides: a stale title is not the pane's NAME (see {@link paneDisplayName}),
   * but it still shows on the muted line, because it is the only trace of what ran here.
   */
  terminalTitleStale?: boolean;
  /**
   * A finished sentence the bridge composed about this pane, for the operator to read. Absent on
   * almost every pane, and on every bridge older than the version that introduced it.
   *
   * RENDER IT, NEVER READ IT. The frontend does not parse it, branch on it, or infer anything from
   * its presence: it carries no harness name and no multiplexer name, and the pane's status, its
   * controls and its place in the sort are decided exactly as they were without it. Text only,
   * never markup — the same XSS boundary as `paneLabel`.
   */
  hint?: string;
  /**
   * Epoch ms of this agent's last status transition, as the bridge observed it. Absent on an older
   * bridge — which is exactly why triage degrades cleanly; see `triage()`.
   */
  lastActiveAt?: number;
  /**
   * Epoch ms you last opened or drove this pane through Collie. Absent as above.
   *
   * There is no "seen" flag anywhere: a `done` agent is unseen precisely when
   * `lastActiveAt > lastSeenAt`, so opening the pane clears it by construction.
   */
  lastSeenAt?: number;
  /**
   * Which member of the pack this pane lives on — the `?h=` value (PACK_PROTOCOL.md §4). Mirrors
   * `PaneWire.host` in bridge/types.ts.
   *
   * **Present exactly when {@link SnapshotResponse.servers} is**, and absent otherwise: a solo
   * snapshot host-tags nothing (§11), so every install that exists today reads `undefined` here and
   * renders byte-identically. A pane id (`w1:p1`) is unique only within one session on one machine,
   * so this is the field that makes a row addressable — open it with the PANE's host, never the
   * ambient one, or a reply lands on the right pane name on the wrong terminal.
   */
  host?: string;
  /**
   * Which Herdr session on {@link host} this pane lives in — the `?s=` half of the same address.
   * Mirrors `PaneWire.session` in bridge/types.ts.
   *
   * **Present exactly when the snapshot was WIDENED** (`?sessions=all`, the "All sessions" view),
   * and then on every pane in the body including the primary session's. Absent otherwise, which is
   * every request the app made until this feature existed — so an un-widened view reads `undefined`
   * here and behaves exactly as it did.
   *
   * Pane ids collide across sessions on one machine for the same reason they collide across
   * machines: each session is its own Herdr server. So this completes the `(host, session, paneId)`
   * address, and a widened row must be OPENED with its own session (see `paneScope` in lib/hosts.ts)
   * rather than with the ambient one.
   */
  session?: string;
}

/**
 * The name to show for a pane, in priority order: an explicit user label (herdr `pane.rename`) wins,
 * then Claude's own `/rename` session name, then the pane's terminal title, then the agent name (or
 * "shell"). The two hand-set names outrank the title because a name you chose should not be
 * overwritten by one the process is rewriting every turn; the title outranks the agent name because
 * "claude" tells you nothing when four rows say it. All three are rendered only as React text nodes
 * by callers — never markup — so they stay within the pane-output XSS boundary.
 *
 * A STALE title names nothing: the program that wrote it has exited, so it is a fact about the past,
 * and a past task standing in as a live pane's name is the bug this rule exists to stop. Such a pane
 * falls back to what it would be called with no title at all.
 */
export function paneDisplayName(pane: AgentView): string {
  if (pane.paneLabel) return pane.paneLabel;
  if (pane.sessionName) return pane.sessionName;
  if (pane.terminalTitle && !pane.terminalTitleStale) return pane.terminalTitle;
  return pane.kind === "shell" ? "shell" : pane.agent;
}

/** A Herdr workspace ("space") — a project-scoped container of tabs. */
export interface WorkspaceView {
  workspaceId: string;
  number: number;
  label: string;
  focused: boolean;
  activeTabId: string;
  tabCount: number;
  paneCount: number;
  /**
   * The Git repo this space sits in, when the multiplexer reports one.
   *
   * Absent means "no repo, or this multiplexer keeps no such mapping" — and absence is what hides
   * the worktree rows, so no extra call is needed to decide whether to show them.
   */
  repoRoot?: string;
  /** Whether this space is a linked worktree of `repoRoot`, not the repo's own checkout. */
  isWorktree?: boolean;
  /**
   * Which member of the pack this space lives on — the same tag a pane and a session carry.
   *
   * Present exactly when `servers` is, absent otherwise, so a solo body is unchanged. Herdr numbers
   * spaces PER MACHINE, so `(host, workspaceId)` is a space's identity in a pack — see `spaceKey`
   * in lib/hosts.ts, and `ambientSpaces`, which narrows these rows to the address the URL is on.
   */
  host?: string;
}

/** A tab within a workspace (holds one or more panes). */
export interface TabView {
  tabId: string;
  workspaceId: string;
  number: number;
  label: string;
  focused: boolean;
  paneCount: number;
  /** Which member of the pack this tab lives on — same rule as {@link WorkspaceView.host}. */
  host?: string;
}

export type BridgeStatus = "connected" | "disconnected";

/**
 * Per-device authorisation for this client (mirrors DeviceAuth in bridge/types.ts). Present in the
 * snapshot only when the feature is enabled on the bridge; absent = not enforced.
 */
export interface DeviceAuth {
  /** Whether per-device authorisation is enforced at all. */
  enforced: boolean;
  /** The opaque device identifier from the trusted header, or null if absent / feature off. */
  device: string | null;
  /** Whether this device may perform sensitive (terminal-driving / structural) actions. */
  authorized: boolean;
}

/**
 * True when device auth is enforced and this device is NOT authorised — i.e. the UI should drop to
 * read-only. False when the feature is off, the device is allowlisted, or the state isn't known yet.
 */
export function isReadOnly(device: DeviceAuth | undefined): boolean {
  return !!device && device.enforced && !device.authorized;
}

// ── Device pairing (mirrors bridge/pairing.ts) ───────────────────────────────────────────────────
// The OTHER write gate: a bearer credential this device holds, independent of the header-based
// DeviceAuth above and composing with it by AND. See lib/pairing.ts for the client-side store.

/** One paired device, as `GET /api/devices` reports it. The token itself never leaves the bridge. */
export interface PairedDeviceWire {
  label: string;
  createdAt: number;
  lastSeenAt: number;
  /** True for the device making the request — i.e. the one you're reading this on. */
  current: boolean;
}

/** The body of `GET /api/devices` and `POST /api/devices/revoke`. */
export interface DevicesResponse {
  /**
   * Whether a bearer token is required for writes. Not a setting — it is simply "at least one device
   * is paired", so pairing nobody leaves Collie exactly as it was.
   */
  enforced: boolean;
  /** The label this request's token authenticated as, or null when it authenticated as nobody. */
  current: string | null;
  devices: PairedDeviceWire[];
}

/** Why a `POST /api/pair` claim was rejected (the `error` field of its 400 body). */
export type PairFailure =
  | "no-pending"
  | "expired"
  | "exhausted"
  | "bad-code"
  | "duplicate-label"
  | "bad-request";

/**
 * One entry in the snapshot's session registry — a named Herdr session the bridge is fanning out.
 * Order is primary-first, then alphabetical. An unreachable session (crashed / stale socket) reports
 * `reachable: false` with zeroed counts and renders greyed-out, non-clickable in the switcher.
 */
export interface SessionSummary {
  /** Registry name, e.g. "default", "collie-demo". */
  name: string;
  /** The `cfg.socketPath` session — all no-`?s=` requests map to it. */
  isPrimary: boolean;
  /** Whether the last poll of this session's socket succeeded. */
  reachable: boolean;
  /** Agent-pane count (0 when unreachable). */
  agents: number;
  working: number;
  blocked: number;
  /**
   * Which member of the pack fronts this session — the `?h=` value. Present exactly when
   * {@link SnapshotResponse.servers} is (PACK_PROTOCOL.md §9.2/§11); absent on every solo snapshot.
   * Sessions are a PER-HOST registry, which is why the switcher lists one host's sessions at a time:
   * a flat merged list would offer "default" twice with no way to tell them apart.
   */
  host?: string;
}

/**
 * One member of the pack (PACK_PROTOCOL.md §9.2) — mirrors `ServerSummary` in bridge/types.ts field
 * for field. The lead's own entry is included, so the phone renders one uniform host list instead of
 * special-casing "here".
 *
 * Note what is NOT here: per-host agent/working/blocked counts. `SessionSummary` carries those
 * because the bridge computes them per session; a `ServerSummary` does not, so the switcher derives
 * them client-side from the merged `agents` array (see `hostCounts` in lib/hosts.ts). That keeps the
 * counts consistent with the rows actually on screen — including an unreachable host's last-good
 * panes, which stay listed rather than zeroing (§10.2).
 */
export interface ServerSummary {
  /** Member id — the `?h=` value. */
  id: string;
  /** Operator-chosen label; today the member id itself. */
  name: string;
  isLead: boolean;
  /** Whether the lead's last poll of this member succeeded. Always true for the lead's own entry. */
  reachable: boolean;
  /** Version negotiation state (§7). */
  protocol: "ok" | "incompatible" | "unknown";
  /** The peer's refusal reason, verbatim, when incompatible — rendered as text, never paraphrased. */
  protocolDetail?: string;
  /** Epoch ms, stamped by the LEAD on receipt — never the peer's clock (§10.2). `0` = never answered. */
  lastSeenAt: number;
}

/**
 * `GET /api/pack` — the lead's own answer to "how is my whole pack doing?" (PACK_PROTOCOL.md §9.2,
 * §10.2). Read-level, and read-ONLY: nothing on this response is an affordance to change the pack.
 * Join / leave / promote / rotate stay CLI verbs (M5 non-goal), so the page it feeds has no button
 * that mutates anything.
 *
 * **Only a LEAD serves it.** A solo collie and a peer both answer 404 with the app's ordinary JSON
 * error shape, which `packLoader` (lib/loaders.ts) turns into `null` rather than a thrown error —
 * "there is no pack here" is an answer, not a failure.
 *
 * Deliberately NOT folded into `SnapshotResponse.servers`: that roster is what every host-aware
 * surface polls on the hot path, and it carries exactly the fields those surfaces need. The census
 * below (secret generation, warrant generations, enrolment times, per-member versions) is one
 * page's worth of detail, and putting it on the snapshot would make every phone pay for it on every
 * poll. Where the two overlap — `health`, `lastSeenAt` — the meanings are the same ones
 * `ServerSummary` documents, measured on the same clock.
 */
export interface PackStatusResponse {
  pack: {
    id: string;
    /** Operator-chosen pack name. */
    name: string;
    /** Which rotation of the shared secret is current; a member below it has not caught up yet. */
    secretGeneration: number;
    /** Epoch ms on the LEAD's clock, like every other timestamp here — date it against `ts`. */
    rotatedAt: number;
  };
  /** The collie answering — i.e. the lead itself. `version` is what a member is compared against. */
  self: { id: string; name: string; version: string };
  /**
   * The member named ahead of time to take over if the lead goes silent (ADR 0027), or `null` when
   * none is named. `warrantGeneration` is null when the deputy holds no warrant yet.
   */
  deputy: { id: string; warrantGeneration: number | null } | null;
  /** Lead first, then peers by id — the same order the roster uses, so the two pages agree. */
  members: PackMemberStatus[];
  /**
   * The LEAD's clock when it assembled this body. Every timestamp above and below is stamped on
   * that same clock, so it is the only sound thing to age them against — never `Date.now()`
   * (lib/host-health.ts's header has the argument in full).
   */
  ts: number;
}

/** One machine's row in the census. */
export interface PackMemberStatus {
  /** Member id — the `?h=` value, so a row can navigate straight to that machine's home. */
  id: string;
  name: string;
  isLead: boolean;
  /** How the operator reached it; absent for the lead's own entry. Rendered verbatim, in mono. */
  address?: string;
  /** Epoch ms on the lead's clock when this member joined; absent for the lead's own entry. */
  enrolledAt?: number;
  /**
   * Four states, and the last two are the loud ones: `incompatible` is a version that must be
   * fixed, `conflicted` is two collies both believing they lead this pack. Neither is a transient
   * the next poll clears, so the page names them rather than folding them into "unreachable".
   */
  health: "reachable" | "unreachable" | "incompatible" | "conflicted";
  /** The lead's reason, verbatim — never paraphrased, because the fix follows from the words. */
  reason?: string;
  /** Epoch ms, stamped by the LEAD on receipt (§10.2). `0` = never answered. */
  lastSeenAt: number;
  /** The Collie version this member reports; absent until it has answered once. */
  version?: string;
  /** Enrolled under an older secret generation and has not picked up the current one. */
  secretBehind: boolean;
  /** Enrolled, never reached — so nothing about it has ever been confirmed. */
  provisional: boolean;
  /** Set only when `health` is `conflicted`: who this member thinks leads, and under what warrant. */
  conflict?: { leadMemberId: string; warrantGeneration: number | null };
}

/**
 * Version / upgrade status for the running Collie (mirrors UpdateInfo in bridge/types.ts). Optional
 * on the snapshot — an older bridge omits it entirely, which the client treats as "no info" (the
 * update banner renders nothing). `latest` is null when the newest upstream release isn't known.
 */
export interface UpdateInfo {
  /** The version this bridge is running, e.g. "0.11.0". */
  current: string;
  /** Newest upstream release, e.g. "0.12.0", or null when unknown. */
  latest: string | null;
  /** GitHub release page for `latest` (the banner links to it), or null when `latest` is unknown. */
  latestUrl: string | null;
  /** A newer release than `current` exists upstream — the update action will fetch it. */
  releaseAvailable: boolean;
  /** Newest release of a HIGHER major than `current`, or null. A routine update never crosses it —
   *  `update --major` is the consent (ADR 0020), so the banner names that command. */
  majorAvailable: string | null;
  /** GitHub release page for `majorAvailable`, or null when there is none. */
  majorUrl: string | null;
  /** The running bridge PROCESS is behind the on-disk code — a `systemctl restart` picks it up. */
  bridgeStale: boolean;
  /** When the upstream check last ran (epoch ms), or null if it hasn't. */
  checkedAt: number | null;
}

export interface SnapshotResponse {
  bridge: BridgeStatus;
  /** Per-device authorisation for the requesting client; absent when the feature is off. */
  device?: DeviceAuth;
  agents: AgentView[];
  shellPanes: AgentView[];
  workspaces: WorkspaceView[];
  tabs: TabView[];
  /** Notification quiet-hours: the active snooze deadline (epoch ms) or null. Absent on older bridges. */
  notifications?: { snoozedUntil: number | null };
  /** The bridge's session registry (primary-first). Absent on a single-session / older bridge. */
  sessions?: SessionSummary[];
  /**
   * Every member of the pack, the lead's own entry first (PACK_PROTOCOL.md §9.2).
   *
   * **Optional-and-absent, like `update?` and unlike the always-present `sessions`** — a solo bridge
   * emits no such key at all (§11), so absent (or fewer than two entries) is the one condition under
   * which the whole host dimension renders nothing: no switcher, no chips, no extra row height.
   */
  servers?: ServerSummary[];
  /** Version / upgrade status. Absent on an older bridge that doesn't report it. */
  update?: UpdateInfo;
  ts: number;
}

export interface PaneReadResponse {
  paneId: string;
  text: string;
  truncated: boolean;
  /** Herdr's monotonic pane revision — the prompt-select race guard checks a tapped menu against it. */
  revision: number;
  /** Set to true by the client when the server returns 304 Not Modified. Never sent over the wire. */
  notModified?: boolean;
}

/**
 * One renderable piece of a transcript turn. Mirrors `bridge/transcript.ts` (wire types are
 * hand-mirrored across the two sides, as with every other response here).
 */
export type TranscriptPart =
  | { kind: "text"; text: string; truncated?: boolean }
  | { kind: "thinking"; text: string; truncated?: boolean }
  | {
      kind: "tool";
      name: string;
      summary: string;
      result?: { text: string; truncated?: boolean; isError?: boolean };
    };

/**
 * One turn. `user`/`assistant` are speech; the other two are not, and render set apart so they can't
 * be mistaken for it — `summary` is Claude's own compaction summary, `note` is machine-injected
 * content that still belongs on screen (a background task finishing, a local command's output).
 */
export interface TranscriptEntry {
  uuid: string;
  ts: string;
  role: "user" | "assistant" | "summary" | "note";
  parts: TranscriptPart[];
}

/**
 * GET /api/pane/:id/history — real conversation history, read from the agent's own session log.
 *
 * This is NOT terminal scrollback and can't be: a Claude pane runs on the terminal's alternate
 * screen, which keeps no scrollback ring, so Herdr only ever holds the visible viewport. `available:
 * false` is an ordinary answer (a shell pane, a harness with no session log, or the feature off) —
 * the UI hides the History affordance rather than showing an error.
 */
export type PaneHistoryResponse =
  | { paneId: string; available: false; reason: "disabled" | "no-session" | "no-log" }
  | {
      paneId: string;
      available: true;
      /** Oldest-first, ready to render top-down. */
      entries: TranscriptEntry[];
      /** Older turns exist before `entries[0]` — page with `?before=<its uuid>`. */
      hasMore: boolean;
      total: number;
      fileTruncated: boolean;
    };

/**
 * `error` is the bridge's English sentence and stays what a client displays when it has nothing
 * better; `code` + `detail` are the machine half, which `lib/api-error-message.ts` turns into the
 * operator's language. `code` was once only ever `"prompt_changed"` — it now names any catalogued
 * refusal, so a client must fall back on a code it doesn't recognise rather than treat it as a bug.
 * Mirrors ActionResponse in bridge/types.ts.
 */
export type ActionResponse =
  | { ok: true }
  | {
      ok: false;
      error: string;
      textDelivered?: boolean;
      code?: ApiErrorCode;
      detail?: ApiErrorDetail;
    };

export type UploadResponse =
  | { ok: true; path: string }
  | { ok: false; error: string; code?: ApiErrorCode; detail?: ApiErrorDetail };

/** A freshly-created shell pane — enough to navigate into before the next poll lands. */
export interface CreatedPane {
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  tabId: string;
  cwd: string;
}

/** Result of creating a new tab/space — on success `pane` is the fresh shell to navigate into. */
export type CreateResponse =
  | { ok: true; pane: CreatedPane }
  | { ok: false; error: string; code?: ApiErrorCode; detail?: ApiErrorDetail };

/**
 * Which role the bridge plays in a pack (PACK_PROTOCOL.md §3). Mirrors PackMode in bridge/types.ts.
 * `solo` is a lead with zero peers — today's Collie, exactly.
 */
export type PackMode = "solo" | "lead" | "peer";

/**
 * One operator-declared palette row (a `[[commands]]` table in their `commands.toml`). Mirrors
 * OperatorCommand in
 * bridge/types.ts. Resolved against the shipped catalog by `commandsFor()`, which hands a pane
 * these rows instead of the catalog when any of them address it — see agent-commands.ts for why a
 * plugin- or user-registered command can only arrive this way.
 */
export interface OperatorCommand {
  /** Herdr agent name this applies to, lowercased. Omitted = every agent. */
  agent?: string;
  command: string;
  description: string;
  takesArg: boolean;
  argHint: string;
  /** The operator marking their own row dangerous. Optional so an older bridge stays readable. */
  confirm?: boolean;
}

/**
 * One operator-declared Keys-tray preset (a `[[keys]]` table in their `keys.toml`). Mirrors
 * OperatorKeyRow in bridge/types.ts. Resolved against the shipped presets by `ctrlPresetsFor()`,
 * which hands a pane these rows instead of the shipped ones when any of them address it. Only the
 * tray's preset CATALOG is configurable — its keyboard is fixed.
 */
export interface OperatorKeyRow {
  /** Herdr agent name this applies to, lowercased. Omitted = every agent. */
  agent?: string;
  /** The button's text, and its identity within one scope. */
  label: string;
  /** Chords in Herdr's `pane.send_keys` spelling; more than one is sent as ONE ordered batch. */
  keys: string[];
  /** The operator putting their own row behind the tray's two-tap confirm. */
  danger?: boolean;
}

/**
 * Every capability a multiplexer adapter may declare. Mirrors `MUX_CAPABILITIES` in
 * bridge/mux/capabilities.ts, which is where each one's meaning and its backing route are written
 * down — the two trees do not share a module, so this list is a copy the way `STATUS_RANK` is.
 *
 * A name here is only ever used to ASK. Nothing in `web/src` may key off which multiplexer answered
 * (scripts/check-mux-names.sh), and that is the difference this list exists to keep.
 */
export const MUX_CAPABILITIES = [
  "paneGrid",
  "gridScrollback",
  "agentDetection",
  "agentSessionRef",
  "typeText",
  "sendKeys",
  "renamePane",
  "closePane",
  "setFocus",
  "createTab",
  "renameTab",
  "closeTab",
  "createSpace",
  "listWorktrees",
  "createWorktree",
  "openWorktree",
  "pushTopologyEvents",
  "pushPaneEvents",
] as const;

export type MuxCapability = (typeof MUX_CAPABILITIES)[number];

/**
 * What the bridge says about the multiplexer underneath (`/api/config`). Mirrors `MuxConfig` in
 * bridge/types.ts.
 *
 * `name` is for display and support — the subject of a sentence, never a branch. Read the
 * capabilities through lib/mux-capability.ts rather than reaching in here: that module owns the one
 * rule that an unanswered capability counts as PRESENT.
 */
export interface MuxConfig {
  name: string;
  /** Total over {@link MUX_CAPABILITIES} on any bridge that knows the capability. */
  capabilities: Partial<Record<MuxCapability, boolean>>;
  /** Neutral key spellings this multiplexer refuses. */
  unsupportedKeys: string[];
  /**
   * How many spaces this multiplexer can hold — not how many exist right now.
   *
   * `"one"` drops the space strip and makes the tab strip the top level. ABSENT (an older bridge, a
   * cached page) reads as `"many"`; the rule and its reasoning live in lib/mux-capability.ts beside
   * every other "what is true of the multiplexer" answer.
   */
  spaces?: "one" | "many";
  /** The adapter's own words for the capabilities it lacks — the text an explanation renders. */
  notes: Partial<Record<MuxCapability, string>>;
  /**
   * Where the bridge serves this multiplexer's mark, for an `<img src>`. Absent on a bridge whose
   * adapter has no mark (and on every bridge older than the field), and absent means NO IMAGE — the
   * header renders its text alone rather than standing something in.
   *
   * The path arrives as DATA and is never spelled here: a mark chosen in the frontend would be a
   * lookup keyed by the multiplexer's name, which is the one thing this app must not do
   * (lib/mux-capability.ts, scripts/check-mux-names.sh).
   */
  logoUrl?: string;
  /**
   * How soon this bridge sees a topology change nobody announced. Mirrors `MuxTopologyLatency` in
   * bridge/mux/capabilities.ts.
   *
   * **Absent on any bridge older than the field, and absent reads as `push`** — the same fail-open
   * direction the capabilities take (lib/mux-capability.ts). Read it through `useTopologyLatency()`
   * rather than here, so that rule lives in exactly one place.
   */
  topologyLatency?: MuxTopologyLatency;
}

/**
 * How soon Collie sees a change made in the operator's own terminal — declared by the bridge, never
 * measured here (ADR 0031).
 *
 * `push` means the multiplexer announces it, so there is nothing to say and the UI says nothing.
 * `bounded` means the bridge censuses and `ms` is the longest a change can sit unseen — which is
 * what makes "synced Ns ago" honest information rather than decoration.
 */
export type MuxTopologyLatency =
  | { kind: "push" }
  | { kind: "bounded"; ms: number };

/**
 * One operator-declared Quick-dock group (a `[[replies]]` table in their `quick-replies.toml`).
 * Mirrors OperatorQuickReplyRow in bridge/types.ts. Resolved against the shipped groups by
 * `quickRepliesFor()`, which hands a pane these rows instead of the shipped ones when any of them
 * address it.
 */
export interface OperatorQuickReplyRow {
  /** Herdr agent name this applies to, lowercased. Omitted = every agent. */
  agent?: string;
  /** The group's heading, and its identity within one scope. */
  title: string;
  /** The literal strings sent — each is typed into the pane and submitted verbatim. */
  items: string[];
}

/**
 * One operator-declared UI typeface (a `[[font]]` row in their `theme.toml`). Mirrors
 * `OperatorFontRow` in bridge/types.ts.
 *
 * These ADD to the shipped faces rather than replacing them, which is where `theme.toml` parts
 * company with the ADR 0018 trio — a font cannot fire an action, so it shadows nothing (ADR 0033).
 *
 * NO URL CROSSES THE WIRE, only the basename: `lib/operator-fonts.ts` builds `/api/fonts/<name>`
 * itself, and re-validates every field here before any of it reaches a stylesheet.
 */
export interface OperatorFontRow {
  /** Display name AND the CSS family name. */
  family: string;
  /** The file's bare name, which is also the row's identity and the tail of its URL. */
  basename: string;
  /** `font-weight` for the `@font-face`, e.g. `400` or `400 700`. Absent = the browser's default. */
  weight?: string;
}

export interface BridgeConfig {
  push: boolean;
  vapidPublicKey: string;
  /** Build id of the bundle the bridge is currently serving (for stale-cache detection). */
  build?: string;
  /**
   * The bridge's pack mode. **Absent means `solo`** — a solo bridge emits no such key, so its
   * `/api/config` body stays byte-identical to the pre-federation one. Always read it as
   * `mode ?? "solo"`; never infer the mode from behaviour.
   */
  mode?: PackMode;
  /** The operator's own palette rows. Absent when there is no `commands.toml`. */
  operatorCommands?: OperatorCommand[];
  /** The operator's own Keys-tray presets. Absent when there is no `keys.toml`. */
  operatorKeys?: OperatorKeyRow[];
  /** The operator's own Quick-dock groups. Absent when there is no `quick-replies.toml`. */
  operatorQuickReplies?: OperatorQuickReplyRow[];
  /** The operator's own UI typefaces. Absent when there is no `theme.toml` (ADR 0033). */
  operatorFonts?: OperatorFontRow[];
  /**
   * The multiplexer and its declared capabilities. **Absent on a bridge older than this field**, and
   * that absence is read as "everything is supported" — a mid-upgrade Herdr operator must never
   * watch controls disappear while a cached config is in flight (lib/mux-capability.ts).
   */
  mux?: MuxConfig;
  /**
   * Speech-to-text, when the operator configured a provider (ADR 0029). Mirrors `SttCapability` in
   * bridge/types.ts.
   *
   * **Absent is the feature being off**, and it is also what every bridge older than the field
   * sends — so the phone reads "no key" as "no microphone" and draws no record button at all. The
   * feature is absent, not disabled.
   */
  stt?: SttCapability;
}

/**
 * What `/api/config` says about speech-to-text — a label and a yes/no, never the endpoint, the model
 * or the credential. The phone decides whether to draw a button, not where the audio goes.
 */
export interface SttCapability {
  /** The provider's id, e.g. `openai-compatible`. A label to show, never a branch. */
  provider: string;
  /** Whether it could serve a request right now. */
  available: boolean;
  /** Operator-facing prose when it could not. Absent when it could. */
  reason?: string;
}

/**
 * Notification type preferences (GET/POST /api/notifications/prefs). Which agent statuses push, set
 * bridge-wide (fans out to every device, like the snooze). Mirrors NotifyPrefs in bridge/notify-prefs.ts.
 */
export interface NotifyPrefs {
  /** Push when an agent becomes blocked (waiting on your input). Default on. */
  blocked: boolean;
  /** Push when an agent finishes its task. Default off. */
  done: boolean;
  /** Push when a new Collie version is available (a restart or upgrade is waiting). Default on. */
  updates: boolean;
}

/** Lower sorts first — "needs you" at the top. Mirrors STATUS_RANK on the server. */
export const STATUS_RANK = {
  blocked: 0,
  working: 1,
  unknown: 2,
  idle: 3,
  done: 4,
} satisfies Record<AgentStatus, number>;

/** Translated status labels, resolved fresh on every call — a caller that renders one must also
 *  call `useLocale()` so it re-renders when the active language changes (see hooks/use-locale.ts). */
export function statusLabel(status: AgentStatus): string {
  return t(`status.label.${status}`);
}

/** One Git worktree of the repo a space sits in. Mirrors `WorktreeView` in bridge/types.ts. */
export interface WorktreeView {
  path: string;
  branch: string | null;
  /** The space showing it, or `null` when nothing does — which is what hides its Remove row. */
  openWorkspaceId: string | null;
  /** `false` for the repo's own checkout: listed for context, never removable. */
  linked: boolean;
  prunable: boolean;
}

/** GET /api/workspace/:id/worktrees */
export type WorktreeListResponse =
  | { ok: true; worktrees: WorktreeView[] }
  | { ok: false; error: string; code?: ApiErrorCode; detail?: ApiErrorDetail };

/** POST /api/workspace/:id/worktree[/open] — `alreadyOpen` is an answer, never a failure. */
export type WorktreeOpenResponse =
  | { ok: true; pane: CreatedPane; alreadyOpen: boolean }
  | { ok: false; error: string; code?: ApiErrorCode; detail?: ApiErrorDetail };

