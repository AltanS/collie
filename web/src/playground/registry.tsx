// The design reference's entries, as data: id, title, group, keywords and a lazy loader of the entry's
// component. DEV-ONLY, never imported by the app. Two readers: this checkout's own dev page
// (`design.html`, app.tsx) and the workspace's design app, which builds a static reference snapshot
// from any checkout by importing ENTRIES from this module. Keep this module free of page chrome: it
// imports nothing but types and the entries' own files, lazily.

import type { ComponentType } from "react";

import type { Findable } from "./find";
import type { ClockMode, SectionDef } from "./layout";

/** What a section page gets handed — the page-level knobs a section needs. Today only the shared
 *  connection clock (`BootSection`'s `clock` prop); a section that needs nothing reads nothing off it. */
export interface SectionRenderCtx {
  readonly clock: ClockMode;
}

/** What the nav and the search know of an entry before its code is there. `id` and `title` are its
 *  file's own `DEF` (`app.test.tsx` holds the two equal); `keywords` are what a person types to find
 *  it: the component names it mounts and the feature words, never empty (`registry.test.ts`). */
export type EntryDef = Pick<SectionDef, "id" | "title"> &
  Findable & {
    /** The heading the entry sits under in a list: an area of the product, never a round. */
    readonly group: string;
  };

/** One row of the entry registry. `load` fetches the entry's module when its page is opened. */
export interface SectionEntry {
  readonly def: EntryDef;
  readonly load: () => Promise<{ default: ComponentType<SectionRenderCtx> }>;
}

/**
 * The reference's entries, in the order they are shown. Exported so `app.test.tsx` can iterate every
 * entry rather than special-casing whatever the page happens to mount by default.
 *
 * Adding an entry is one row here plus its own file under `sections/`, whose `DEF` carries the same
 * id and title. The id is flat kebab-case and is the entry's address (`design.html#motion`).
 * `{ def: { id: "motion", group: "Brand and look", title: "Motion", keywords: ["animation", "BottomSheet"] }, load: () => import("./sections/motion").then((m) => ({ default: m.MotionSection })) }`.
 * Keep the `import()` a literal path, so Vite can split it into its own chunk.
 */
export const ENTRIES: readonly SectionEntry[] = [
  {
    def: { id: "dashboard", group: "Dashboard", title: "Dashboard", keywords: ["home", "herd", "AgentList", "tabs", "needs-you", "TabBar", "PaneStrip", "SpaceStrip", "TabStrip", "navigation", "update-band", "UpdateBanner", "UpdateRibbon", "footer", "build-stamp", "crew-link", "SessionSwitcher", "read-only", "write-gate", "worktree", "branch"] },
    load: () => import("./sections/dashboard").then((m) => ({ default: m.DashboardSection })),
  },
  {
    def: { id: "pane", group: "Pane", title: "Pane", keywords: ["chat", "mirror", "terminal", "NavTray", "tool-run", "pane-actions", "header", "NoEchoNotice"] },
    load: () => import("./sections/pane").then((m) => ({ default: m.PaneSection })),
  },
  {
    def: { id: "composer-states", group: "Pane", title: "Composer states", keywords: ["composer", "reply", "way-out", "held", "send", "queue", "draft", "steer", "hold", "confirm", "really-send", "send-it-again", "unknown", "destructive", "two-tap", "sign-in", "secret", "code", "SecretField", "refusal", "stop-card", "send-again", "RefusalActions", "SendRefusalNotice", "unread", "UnreadDialogBlock", "type-anyway", "answer-exit", "no-plan", "refused-answer", "cannot-tell", "arrived", "CannotTellCard"] },
    load: () => import("./sections/composer-states").then((m) => ({ default: m.ComposerStatesSection })),
  },
  {
    def: { id: "actions-row", group: "Pane", title: "Actions row", keywords: ["belt", "ActionsRow", "keys", "harness", "bar", "HarnessBarControl", "HarnessPrefsControl", "keyboard", "MiniMax", "mcode", "AgentIcon", "mark", "plan", "compact", "history", "resume"] },
    load: () => import("./sections/actions-row").then((m) => ({ default: m.ActionsRowSection })),
  },
  {
    def: { id: "programs", group: "Durable agents", title: "Durable agents home", keywords: ["durable-agents", "agent", "program", "conversation", "DurableHome", "ProgramSection", "AskCard", "ask", "SpaceOverview"] },
    load: () => import("./sections/programs").then((m) => ({ default: m.DurableSection })),
  },
  {
    def: { id: "crew", group: "Crew", title: "Crew", keywords: ["machines", "host", "HostChip", "HostStaleBanner", "ServerSwitcher", "stale", "peer", "lead", "member"] },
    load: () => import("./sections/crew").then((m) => ({ default: m.CrewSection })),
  },
  {
    def: { id: "machines", group: "Crew", title: "Machines", keywords: ["crew", "CrewTabView", "census", "detail", "history", "skeleton"] },
    load: () => import("./sections/machines").then((m) => ({ default: m.MachinesSection })),
  },
  {
    def: { id: "settings", group: "Settings", title: "Settings", keywords: ["LauncherHowSheet", "launcher", "CommandPicker", "FolderBrowse", "NotifyPrefsCard", "notifications", "theme", "ThemePickerControl", "ThemeBrowseSheet", "ThemePasteSheet", "ThemePreviewSheet", "codex", "consent", "speech", "voice", "SpeechCards", "prompts"] },
    load: () => import("./sections/settings").then((m) => ({ default: m.SettingsSection })),
  },
  {
    def: { id: "boot", group: "First run and system", title: "Boot & connection", keywords: ["splash", "connection", "ConnectionBanner", "CollieHome", "header", "dog", "lost", "trouble", "offline", "clock"] },
    load: () => import("./sections/boot").then((m) => ({ default: (ctx: SectionRenderCtx) => <m.BootSection clock={ctx.clock} /> })),
  },
  {
    def: { id: "tour", group: "First run and system", title: "First run", keywords: ["tour", "onboarding", "TourSheet", "TourControl", "push", "permission", "welcome"] },
    load: () => import("./sections/tour").then((m) => ({ default: m.TourSection })),
  },
  {
    def: { id: "idle", group: "First run and system", title: "Idle & resume", keywords: ["IdleLock", "lock", "resume", "cover"] },
    load: () => import("./sections/idle").then((m) => ({ default: m.IdleSection })),
  },
  {
    def: { id: "brand", group: "Brand and look", title: "Brand", keywords: ["mark", "CollieMark", "logo", "typeface", "font", "face", "header", "prerelease", "AlphaBar", "glyph", "icons", "app-icon"] },
    load: () => import("./sections/brand").then((m) => ({ default: m.BrandSection })),
  },
  {
    def: { id: "worktree-folder", group: "Settings", title: "Worktree folder", keywords: ["worktree", "folder", "settings", "new-sheet", "branch", "WorktreeFolderControl", "BranchBlock", "default-folder", "crew", "read-only"] },
    load: () => import("./sections/worktree-folder").then((m) => ({ default: m.WorktreeFolderSection })),
  },
  {
    def: { id: "character-picker", group: "Settings", title: "Character picker", keywords: ["character", "head", "mark", "collar", "CharacterPicker", "CharacterMovesRow", "theme", "motion", "drift", "moves", "still", "switch", "characterMotion"] },
    load: () => import("./sections/character-picker").then((m) => ({ default: m.CharacterPickerSection })),
  },
  {
    def: { id: "notices", group: "First run and system", title: "Notices", keywords: ["Notice", "strip", "band", "StripHost", "toast", "ribbon", "UpdateRibbon", "HeaderStatus", "StatusArea", "recovery", "flash"] },
    load: () => import("./sections/notices").then((m) => ({ default: m.NoticesSection })),
  },
  {
    def: { id: "update-screen", group: "First run and system", title: "Update mode", keywords: ["update", "UpdateScreen", "UpdateRunStrip", "upgrade", "install", "restart"] },
    load: () => import("./sections/update-screen").then((m) => ({ default: m.UpdateScreenSection })),
  },
  {
    def: { id: "motion", group: "Brand and look", title: "Motion", keywords: ["animation", "transition", "collapse", "swap", "OneOf", "BusyBar", "loading", "BottomSheet", "sheet", "AnchoredMenu", "menu", "pending", "pulse", "status-dot"] },
    load: () => import("./sections/motion").then((m) => ({ default: m.MotionSection })),
  },
  {
    def: { id: "cache", group: "Pane", title: "Cache", keywords: ["prompt-cache", "CacheChip", "CacheSheet", "expiry", "timer"] },
    load: () => import("./sections/cache").then((m) => ({ default: m.CacheSection })),
  },
  {
    def: { id: "pane-settings", group: "Pane", title: "Pane settings", keywords: ["PaneSettingsView", "sheet", "switch", "disabled"] },
    load: () => import("./sections/pane-settings").then((m) => ({ default: m.PaneSettingsSection })),
  },
  {
    def: { id: "walky", group: "Pane", title: "WalkyTalky", keywords: ["walky", "walkytalky", "walky-talky", "message", "ItemView", "AnsiOutput", "WalkySheet", "WalkyConfirm", "PaneActionsSheet", "log"] },
    load: () => import("./sections/walky").then((m) => ({ default: m.WalkySection })),
  },
  {
    def: { id: "changes", group: "Dashboard", title: "Changes", keywords: ["diff", "git", "files", "ChangesControl", "FileView", "breadcrumb", "filter", "worktree"] },
    load: () => import("./sections/changes").then((m) => ({ default: m.ChangesSection })),
  },
  {
    def: { id: "markdown-quotes", group: "Pane", title: "Blockquotes", keywords: ["markdown", "blockquote", "quote", "MarkdownText", "table", "code", "list"] },
    load: () => import("./sections/markdown-quotes").then((m) => ({ default: m.MarkdownQuotesSection })),
  },
  {
    def: { id: "left-hand", group: "Pane", title: "Left-hand layout", keywords: ["hand", "left", "right", "Composer", "belt", "layout"] },
    load: () => import("./sections/left-hand").then((m) => ({ default: m.LeftHandSection })),
  },
  {
    def: { id: "composer-box", group: "Pane", title: "Composer box", keywords: ["composer", "box", "Composer", "layout", "expand", "fullscreen", "editor", "draft"] },
    load: () => import("./sections/composer-box").then((m) => ({ default: m.ComposerBoxSection })),
  },
  {
    def: { id: "dashboard-top", group: "Dashboard", title: "Dashboard top", keywords: ["dashboard", "header", "AgentList", "HeadingNewTab", "ServerSwitcher", "SessionSwitcher", "control-bar", "workspace", "order"] },
    load: () => import("./sections/dashboard-top").then((m) => ({ default: m.DashboardTopSection })),
  },
  {
    def: { id: "usage-row", group: "Pane", title: "Usage row", keywords: ["usage", "ModelTag", "model", "tag", "context", "limits", "percent", "dots", "statusline"] },
    load: () => import("./sections/usage-row").then((m) => ({ default: m.UsageRowSection })),
  },
  {
    def: { id: "grounds", group: "Brand and look", title: "Grounds", keywords: ["ground", "pattern", "grain", "backdrop", "theme", "surface"] },
    load: () => import("./sections/grounds").then((m) => ({ default: m.GroundsSection })),
  },
  {
    def: { id: "pins", group: "Pane", title: "Pinned messages", keywords: ["pins", "pin", "StreamBlock", "BlockActionsSheet", "PinsSheet", "SubagentSheet", "Composer", "belt"] },
    load: () => import("./sections/pins").then((m) => ({ default: m.PinsSection })),
  },
  {
    def: { id: "switcher", group: "Pane", title: "Session switcher", keywords: ["switch", "pane", "sheet", "ThreadSidebar", "sessions", "filter", "crew"] },
    load: () => import("./sections/switcher").then((m) => ({ default: m.SwitcherSection })),
  },
  {
    def: { id: "new-tab", group: "Pane", title: "New tab sheet", keywords: ["new", "tab", "plus", "NewTabSheet", "launcher", "start"] },
    load: () => import("./sections/new-tab").then((m) => ({ default: m.NewTabSection })),
  },
  {
    def: { id: "primitives", group: "Brand and look", title: "Primitives", keywords: ["ui", "MatchText", "match", "find", "mark"] },
    load: () => import("./sections/primitives").then((m) => ({ default: m.PrimitivesSection })),
  },
  {
    def: { id: "add-your-own", group: "Pane", title: "Add your own", keywords: ["new", "add", "launcher", "RecipeForm", "recipe", "chips", "options", "harness", "MiniMax", "mcode", "start", "/new/add"] },
    load: () => import("./sections/add-your-own").then((m) => ({ default: m.AddYourOwnSection })),
  },
  {
    def: { id: "report", group: "Pane", title: "Report a problem", keywords: ["report", "issue", "ReportCard", "ReportSheetView", "failed", "sends"] },
    load: () => import("./sections/report").then((m) => ({ default: m.ReportSection })),
  },
  {
    def: { id: "pair-by-phone", group: "Crew", title: "Pair by phone", keywords: ["pair", "device", "QR", "PairWithPhoneView", "approve", "phone"] },
    load: () => import("./sections/pair-by-phone").then((m) => ({ default: m.PairByPhoneSection })),
  },
  {
    def: { id: "trick-render", group: "Tricks and Hill", title: "Trick render", keywords: ["tricks", "tree-ui", "nodes", "renderer", "part", "frame", "trick-mark"] },
    load: () => import("./sections/trick-render").then((m) => ({ default: m.TrickRenderSection })),
  },
  {
    def: { id: "trick-places", group: "Tricks and Hill", title: "Trick places", keywords: ["tricks", "belt", "status-line", "DashboardTabBar", "TrickDashboardStrip", "tiles", "TrickSessionRow", "trick-session"] },
    load: () => import("./sections/trick-places").then((m) => ({ default: m.TrickPlacesSection })),
  },
  {
    def: { id: "trick-menu", group: "Tricks and Hill", title: "Trick menu", keywords: ["tricks", "menu", "PaneActionsSheet", "rows", "switches", "confirm", "belt-mark"] },
    load: () => import("./sections/trick-menu").then((m) => ({ default: m.TrickMenuSection })),
  },
  {
    def: { id: "trick-settings", group: "Tricks and Hill", title: "Trick settings", keywords: ["tricks", "TricksSettingsCard", "TrickAboutSheet", "about", "provenance", "official", "TrickCardsWaiting", "TrickCardsLine", "waiting", "TrickCardRoute", "TrickSettingsGroup", "fields", "setup"] },
    load: () => import("./sections/trick-settings").then((m) => ({ default: m.TrickSettingsSection })),
  },
  {
    def: { id: "hill", group: "Tricks and Hill", title: "Hill", keywords: ["hill", "decision", "DecisionCard", "HillView", "HillHeader", "DashboardTabBar", "answer", "images", "ChatApprovalCard", "proposal", "chat-approval"] },
    load: () => import("./sections/hill").then((m) => ({ default: m.HillSection })),
  },
  {
    def: { id: "token-label", group: "Tricks and Hill", title: "Uses agent tokens", keywords: ["tokens", "token-use", "label", "chip", "TokenUseLookProvider", "TricksSettingsCard"] },
    load: () => import("./sections/token-label").then((m) => ({ default: m.TokenLabelSection })),
  },
  {
    def: { id: "agent-view", group: "Tricks and Hill", title: "Agent view", keywords: ["agent-view", "AgentViewScreen", "morph", "tricks", "PaneActionsSheet", "send", "refusal"] },
    load: () => import("./sections/agent-view").then((m) => ({ default: m.AgentViewSection })),
  },
  {
    def: { id: "dashboard-places", group: "Dashboard", title: "Dashboard places", keywords: ["dashboard", "hill", "bottom-bar", "DashboardTabBar", "TrickDashboardStrip", "tiles", "DecisionCard"] },
    load: () => import("./sections/dashboard-places").then((m) => ({ default: m.DashboardPlacesSection })),
  },
  {
    def: { id: "accounts", group: "Settings", title: "Profiles", keywords: ["profiles", "profile", "accounts", "account", "login", "sign-in", "email", "plan", "AccountListRow", "SignedInRow", "identity", "intro", "IntroLines", "more", "sessions", "same-login"] },
    load: () => import("./sections/accounts").then((m) => ({ default: m.AccountsSection })),
  },
];
