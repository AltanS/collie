import type { Page, Route } from "@playwright/test";

import type { AgentView, SnapshotResponse, TabView, WorkspaceView } from "@/lib/types";
import { fixtureSnapshot } from "@/test/handlers";
import { groupDecision, hillDecision } from "@/test/hill-fixtures";

import { installApiStub } from "../fixtures/api";

// THE WORLD THE CENSUS WALKS. The default stub is two agents in two spaces, which is a short
// list: a tap target's neighbour is what the census measures, and the dashboard of a person who uses
// Collie is thirty rows long. So this is a larger herd (eleven panes in four spaces, five harnesses,
// every status) served by the same stub as every other browser case, with the Hill switched on and
// its list answered. Nothing here is written to a bridge: the stub answers every `/api/*` in the page.

const HARNESSES = ["claude", "codex", "pi", "omp", "opencode"] as const;

function pane(i: number, space: number, status: AgentView["status"], agent: string): AgentView {
  return {
    paneId: `w${String(space)}:p${String(i)}`,
    workspaceId: `w${String(space)}`,
    workspaceLabel: ["webapp", "collie", "docs", "infra"][space - 1] ?? "misc",
    workspaceNumber: space,
    tabId: `w${String(space)}:t${String(i)}`,
    agent,
    status,
    cwd: `/home/you/${["webapp", "collie", "docs", "infra"][space - 1] ?? "misc"}`,
    focused: space === 2 && i === 1,
    sendProtocol: true,
  };
}

export const HERD: AgentView[] = [
  pane(1, 1, "blocked", "claude"),
  pane(2, 1, "working", "codex"),
  pane(3, 1, "idle", "pi"),
  pane(1, 2, "working", "claude"),
  pane(2, 2, "done", "omp"),
  pane(3, 2, "idle", "opencode"),
  pane(1, 3, "blocked", "codex"),
  pane(2, 3, "idle", "claude"),
  pane(1, 4, "working", "pi"),
  pane(2, 4, "done", "claude"),
  pane(3, 4, "idle", "omp"),
].map((p, n) => Object.assign({}, p, { paneId: `w${p.workspaceId.slice(1)}:p${String(n + 1)}`, tabId: `${p.workspaceId}:t${String(n + 1)}` }));

const SHELLS: AgentView[] = [{ ...pane(9, 2, "unknown", "shell"), paneId: "w2:p9", tabId: "w2:t9", kind: "shell" }];

const WORKSPACES: WorkspaceView[] = [1, 2, 3, 4].map((n) => ({
  workspaceId: `w${String(n)}`,
  number: n,
  label: ["webapp", "collie", "docs", "infra"][n - 1] ?? "misc",
  focused: n === 2,
  activeTabId: HERD.find((p) => p.workspaceId === `w${String(n)}`)?.tabId ?? `w${String(n)}:t1`,
  tabCount: HERD.filter((p) => p.workspaceId === `w${String(n)}`).length,
  paneCount: HERD.filter((p) => p.workspaceId === `w${String(n)}`).length,
}));

const TABS: TabView[] = HERD.map((p, n) => ({
  tabId: p.tabId,
  workspaceId: p.workspaceId,
  number: n + 1,
  label: String(n + 1),
  focused: p.focused,
  paneCount: 1,
}));

/** The snapshot of the larger herd, with a Hill. `rev` moves a poll's answer without changing the herd. */
export function richSnapshot(rev = 1, patch: (a: AgentView[]) => AgentView[] = (a) => a): SnapshotResponse {
  const agents = patch(HERD.map((a) => Object.assign({}, a)));
  // A pane a case adds needs its tab too, or the list leaves it out.
  const tabs = [...agents.filter((a) => !TABS.some((t) => t.tabId === a.tabId)).map((a, n) => ({ tabId: a.tabId, workspaceId: a.workspaceId, number: n, label: String(n), focused: false, paneCount: 1 })), ...TABS];
  return {
    ...fixtureSnapshot,
    agents,
    shellPanes: SHELLS,
    workspaces: WORKSPACES,
    tabs,
    hillRev: rev,
    ts: rev,
  };
}

export const HARNESS_COUNT = HARNESSES.length;

function json<T extends object>(route: Route, body: T, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/** What the page's `/api/snapshot` answers next, and how long it takes to answer. Tests change both. */
export interface SnapshotControl {
  /** Delay before the answer, ms. */
  delay: number;
  /** The body. A function so every poll can answer something else. */
  body: () => SnapshotResponse;
  /** How many snapshots the page has asked for. */
  asked: number;
}

/**
 * The stub, the larger herd, the Hill, and a snapshot route the case can slow down or change. Call
 * before the first `page.goto`. The stub's own order rule holds: the newest `page.route` is checked first.
 */
export async function installWorld(page: Page): Promise<SnapshotControl> {
  await installApiStub(page);
  const control: SnapshotControl = { delay: 0, body: () => richSnapshot(), asked: 0 };
  await page.route("**/api/snapshot", async (route) => {
    control.asked += 1;
    if (control.delay > 0) await new Promise((resolve) => setTimeout(resolve, control.delay));
    await json(route, control.body());
  });
  const open = [hillDecision(), hillDecision({ title: "Rename the crew command?", priority: "now" }), hillDecision({ title: "Which port for the preview?", text: "required" }), groupDecision(3)];
  await page.route("**/api/hill", (route) => json(route, { rev: 1, open, closed: [] }));
  return control;
}
