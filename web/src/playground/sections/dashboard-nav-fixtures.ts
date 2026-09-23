// Playground-only fixtures for the "Dashboard nav" design round (issue 270 + the Changes view per
// workspace). A bigger herd than `fixtures.ts`'s fourteen: six workspaces and twenty panes, so the
// attention filter has something to remove and the Changes tab has several workspaces to list.
//
// Three panes need you, in three different workspaces, and one finished run is unseen in a fourth.
// Four workspaces carry uncommitted changes; two are clean.

import type { AgentView, ChangedRepo, ChangeStatus } from "@/lib/types";
import { TS } from "../fixtures";

const SEC = 1_000;
const MIN = 60 * SEC;

interface PaneSpec {
  ws: number;
  pane: number;
  tab: string;
  agent: string;
  status: AgentView["status"];
  /** Minutes since the last status change. */
  ago: number;
  /** Minutes since you last opened it. Ahead of `ago` makes a `done` pane unseen. */
  seen?: number;
  name?: string;
  hint?: string;
  shell?: boolean;
}

const WORKSPACES = ["collie", "api", "infra", "blog", "collie-website", "dotfiles"] as const;

function pane(s: PaneSpec): AgentView {
  const label = WORKSPACES[s.ws - 1]!;
  const view: AgentView = {
    paneId: `w${s.ws}:p${s.pane}`,
    workspaceId: `w${s.ws}`,
    workspaceLabel: label,
    workspaceNumber: s.ws,
    tabId: `w${s.ws}:t-${s.tab}`,
    tabLabel: s.tab,
    agent: s.shell ? "shell" : s.agent,
    status: s.shell ? "unknown" : s.status,
    cwd: `/home/you/src/${label}`,
    focused: false,
    lastActiveAt: TS - s.ago * MIN,
    lastSeenAt: TS - (s.seen ?? s.ago - 1) * MIN,
  };
  if (s.shell) view.kind = "shell";
  if (s.name !== undefined) view.sessionName = s.name;
  if (s.hint !== undefined) view.hint = s.hint;
  return view;
}

const SPECS: PaneSpec[] = [
  // collie: 5 panes, one needs you
  { ws: 1, pane: 1, tab: "feat/footer-nav", agent: "claude", status: "blocked", ago: 2, name: "footer nav", hint: "waiting on a permission prompt: run `bun run build`" },
  { ws: 1, pane: 2, tab: "feat/footer-nav", agent: "codex", status: "working", ago: 6 },
  { ws: 1, pane: 3, tab: "fix/cache-chip", agent: "claude", status: "working", ago: 14, name: "cache chip" },
  { ws: 1, pane: 4, tab: "docs", agent: "pi", status: "done", ago: 50, seen: 20 },
  { ws: 1, pane: 5, tab: "docs", agent: "", status: "idle", ago: 90, shell: true },
  // api: 4 panes, one needs you
  { ws: 2, pane: 1, tab: "fix-deploy", agent: "codex", status: "blocked", ago: 7, hint: "asked you a question and is waiting for the answer" },
  { ws: 2, pane: 2, tab: "billing", agent: "claude", status: "working", ago: 3, name: "billing webhooks" },
  { ws: 2, pane: 3, tab: "billing", agent: "opencode", status: "idle", ago: 120 },
  { ws: 2, pane: 4, tab: "logs", agent: "", status: "idle", ago: 200, shell: true },
  // infra: 3 panes, all quiet
  { ws: 3, pane: 1, tab: "flake-bump", agent: "claude", status: "working", ago: 11 },
  { ws: 3, pane: 2, tab: "flake-bump", agent: "codex", status: "done", ago: 80, seen: 30 },
  { ws: 3, pane: 3, tab: "shell", agent: "", status: "idle", ago: 300, shell: true },
  // blog: 2 panes, one finished run you have not seen
  { ws: 4, pane: 1, tab: "seo-pass", agent: "gemini", status: "done", ago: 18, seen: 140, hint: "finished: 9 posts retagged" },
  { ws: 4, pane: 2, tab: "drafts", agent: "claude", status: "idle", ago: 400 },
  // collie-website: 4 panes, one needs you
  { ws: 5, pane: 1, tab: "homepage", agent: "claude", status: "working", ago: 1, name: "hero rework" },
  { ws: 5, pane: 2, tab: "homepage", agent: "claude", status: "blocked", ago: 4, name: "docs sync", hint: "waiting on a permission prompt: edit src/i18n/locales/fr.json" },
  { ws: 5, pane: 3, tab: "i18n", agent: "codex", status: "working", ago: 9 },
  { ws: 5, pane: 4, tab: "i18n", agent: "", status: "idle", ago: 60, shell: true },
  // dotfiles: 2 panes, quiet
  { ws: 6, pane: 1, tab: "zsh", agent: "pi", status: "idle", ago: 900 },
  { ws: 6, pane: 2, tab: "zsh", agent: "", status: "idle", ago: 900, shell: true },
];

const all = SPECS.map(pane);

/** The agent-bearing panes, as `SnapshotResponse.agents` carries them. */
export const navAgents: AgentView[] = all.filter((p) => p.kind !== "shell");
/** The bare shells, as `SnapshotResponse.shellPanes` carries them. */
export const navShells: AgentView[] = all.filter((p) => p.kind === "shell");

// ── Changes per workspace ───────────────────────────────────────────────────────────────────────
//
// What a `workspace/:workspaceId/changes` route would fetch, one entry per workspace folder. A clean
// folder has no entry, so it reads as "no changes" wherever it is listed.

function f(path: string, status: ChangeStatus, added: number, removed: number) {
  return { path, status, added, removed, binary: false };
}

export const navChanges = new Map<string, readonly ChangedRepo[]>([
  [
    "collie",
    [
    {
      relPath: ".",
      name: "collie",
      files: [
        f("web/src/components/footer-nav.tsx", "A", 142, 0),
        f("web/src/components/agent-list.tsx", "M", 18, 6),
        f("web/src/hooks/use-dash-prefs.ts", "M", 9, 2),
        f("web/src/lib/i18n/en.json", "M", 6, 0),
        f("web/src/routes/home.tsx", "M", 12, 4),
        f("web/src/routes/workspace-changes.tsx", "A", 88, 0),
        f("DESIGN.md", "M", 7, 1),
      ],
    },
    ],
  ],
  [
    "api",
    [
    {
      relPath: ".",
      name: "api",
      files: [
        f("src/billing/webhooks.ts", "M", 31, 12),
        f("src/billing/webhooks.test.ts", "A", 64, 0),
        f("deploy/fly.toml", "M", 2, 2),
      ],
    },
    ],
  ],
  ["infra", [{ relPath: ".", name: "infra", files: [f("flake.lock", "M", 24, 24)] }]],
  [
    "collie-website",
    [
    {
      relPath: ".",
      name: "collie-website",
      files: [
        f("src/pages/index.astro", "M", 40, 22),
        f("src/components/hero.tsx", "M", 18, 9),
        f("src/components/cache-row.tsx", "A", 51, 0),
        f("src/components/in-short.tsx", "A", 37, 0),
        f("src/i18n/locales/en.json", "M", 14, 3),
        f("src/i18n/locales/de.json", "M", 14, 3),
        f("src/i18n/locales/fr.json", "M", 14, 3),
        f("src/i18n/locales/pt.json", "M", 14, 3),
        f("src/i18n/locales/tr.json", "M", 14, 3),
        f("public/og.png", "M", 0, 0),
        f("src/styles/old-hero.css", "D", 0, 46),
        f("notes/hero.md", "?", 12, 0),
      ],
    },
    ],
  ],
]);

export const NAV_WORKSPACES: readonly string[] = WORKSPACES;
